import { eq } from 'drizzle-orm';
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type UIMessage,
	type UIMessageChunk
} from 'ai';
import { chunkText } from '#lib/chat-text';
import { db } from '#lib/server/db';
import { chatMessage } from '#lib/server/db/schema';
import { promptSandbox, sandboxErrorMessage } from '#lib/server/sandbox';
import { captureTrace } from '#lib/server/trace-store';
import type { RequestHandler } from './$types';

type ChatBody = {
	messages?: UIMessage[];
	trigger?: 'submit-message' | 'regenerate-message';
	messageId?: string;
	/** RFC 0006 §5.9: the Strict citations toggle of the composer, verbatim. */
	citations?: 'required' | 'off';
	/** The client's view of the active conversation (RFC 0008), used to persist
	 * the question even when the sandbox never answers. */
	conversationId?: number | null;
};

/** What the assistant message carries beside the text: the evidence envelope (§5.7)
 * and the artifact list of the run (RFC 0009 R7). */
type CitationsData = {
	evidence: 'cited' | 'plain' | 'none';
	evidenceReason: string | null;
	citations: {
		citationId: string;
		docId: string;
		title: string;
		filename: string;
		version: number;
		line: number;
		quote: string;
		status: string;
	}[];
};

type ArtifactsData = {
	artifacts: {
		path: string;
		bytes: number;
		sha256: string | null;
		modifiedAt: string;
	}[];
};

const textOf = (message: UIMessage): string =>
	message.parts
		.filter(
			(part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text'
		)
		.map((part) => part.text)
		.join('')
		.trim();

export const POST: RequestHandler = async (event) => {
	const user = event.locals.user;
	if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

	let body: ChatBody;
	try {
		body = (await event.request.json()) as ChatBody;
	} catch {
		return Response.json({ error: 'invalid JSON body' }, { status: 400 });
	}
	const citationsMode = body.citations === 'required' ? 'required' : 'off';
	const sentConversationId =
		typeof body.conversationId === 'number' &&
		Number.isSafeInteger(body.conversationId) &&
		body.conversationId >= 1
			? body.conversationId
			: null;

	const messages = Array.isArray(body.messages) ? body.messages : [];
	const userMessage = [...messages].reverse().find((message) => message.role === 'user');
	if (!userMessage) return Response.json({ error: 'no user message' }, { status: 400 });
	const prompt = textOf(userMessage);
	if (prompt === '') return Response.json({ error: 'the message is empty' }, { status: 400 });

	let userParts: unknown[] = userMessage.parts;
	if (userMessage.id) {
		// The toggle state travels with the user message, so history shows which
		// questions were asked under strict citations.
		userParts =
			citationsMode === 'required'
				? [...userMessage.parts, { type: 'data-strict' as const, data: { citations: true } }]
				: userMessage.parts;
	}

	const assistantId = crypto.randomUUID();
	const textId = crypto.randomUUID();

	// The question is durable before the sandbox is asked: if the sandbox never
	// answers, the row keeps the client's view of the active conversation, so a
	// failed ask stays in the history instead of vanishing. After the answer it
	// is re-pointed to the conversation that actually replied.
	if (userMessage.id) {
		await db
			.insert(chatMessage)
			.values({
				id: userMessage.id,
				userId: user.id,
				...(sentConversationId === null ? {} : { conversationId: sentConversationId }),
				role: 'user',
				parts: userParts
			})
			.onConflictDoUpdate({ target: chatMessage.id, set: { parts: userParts } });
	}

	// The stream starts immediately. While the sandbox wakes — cold provision,
	// paused harness (L0), stopped container (L1) — it emits `data-waking`
	// progress parts with the elapsed time instead of holding the response open
	// in silence. A warm sandbox answers fast enough that no part is ever sent:
	// the notice is delayed on purpose.
	const WAKING_DELAY_MS = 1200;
	const stream = createUIMessageStream({
		execute: async ({ writer }) => {
			writer.write({ type: 'start', messageId: assistantId });
			const submittedAt = Date.now();
			let wakingTimer: ReturnType<typeof setInterval> | undefined;
			const stopWaking = () => {
				if (wakingTimer !== undefined) clearInterval(wakingTimer);
				wakingTimer = undefined;
			};
			const timeout = setTimeout(() => {
				writer.write({ type: 'data-waking', id: assistantId, data: { elapsedMs: 0 } });
				wakingTimer = setInterval(() => {
					writer.write({
						type: 'data-waking',
						id: assistantId,
						data: { elapsedMs: Date.now() - submittedAt }
					});
				}, 1000);
			}, WAKING_DELAY_MS);
			timeout.unref?.();

			let result;
			try {
				result = await promptSandbox(
					event,
					prompt,
					userMessage.id ?? body.messageId,
					citationsMode
				);
			} catch (error) {
				stopWaking();
				clearTimeout(timeout);
				throw error;
			}
			stopWaking();
			clearTimeout(timeout);

			// Re-point the question to the conversation that answered (RFC 0008): the
			// pre-prompt insert used the client's view, which may be stale or unknown.
			if (userMessage.id !== undefined && result.conversationId !== sentConversationId) {
				await db
					.update(chatMessage)
					.set({ conversationId: result.conversationId })
					.where(eq(chatMessage.id, userMessage.id));
			}

			const answer =
				result.answer ??
				(result.status === 'unanswered'
					? `The agent did not answer: ${result.reason ?? 'unknown reason'}${result.reasonDetail ? ` — ${result.reasonDetail}` : ''}.`
					: 'The agent finished without a text answer.');

			// The server-built evidence fields (RFC 0006 §5.1): stored as a data part,
			// streamed to the UI, and rendered by the Files used panel. The artifact
			// list rides the same mechanism (RFC 0009 §5.7): the download button never
			// depends on the model typing a path.
			const citationsData: CitationsData = {
				evidence: result.evidence ?? 'plain',
				evidenceReason: result.evidenceReason ?? null,
				citations: (result.citations ?? []).map((citation) => ({
					citationId: citation.citationId,
					docId: citation.docId,
					title: citation.title,
					filename: citation.filename,
					version: citation.version,
					line: citation.line,
					quote: citation.quote,
					status: citation.status
				}))
			};
			const artifactsData: ArtifactsData = {
				artifacts: (result.artifacts ?? []).map((artifact) => ({
					path: artifact.path,
					bytes: artifact.bytes,
					sha256: artifact.sha256,
					modifiedAt: artifact.modifiedAt
				}))
			};

			await db.insert(chatMessage).values({
				id: assistantId,
				userId: user.id,
				conversationId: result.conversationId,
				role: 'assistant',
				parts: [
					{ type: 'text', text: answer },
					{ type: 'data-citations', data: citationsData },
					{ type: 'data-artifacts', data: artifactsData }
				]
			});

			// The chat is usable even when the trace endpoint hiccups.
			await captureTrace(event).catch(() => undefined);

			writer.write({ type: 'start-step' });
			writer.write({ type: 'text-start', id: textId });
			for (const chunk of chunkText(answer)) {
				writer.write({ type: 'text-delta', id: textId, delta: chunk });
			}
			writer.write({ type: 'text-end', id: textId });
			writer.write({ type: 'data-citations', id: assistantId, data: citationsData });
			writer.write({ type: 'data-artifacts', id: assistantId, data: artifactsData });
			writer.write({ type: 'finish-step' });
			writer.write({ type: 'finish', finishReason: 'stop' });
		},
		onError: (error) => sandboxErrorMessage(error)
	});

	return createUIMessageStreamResponse({
		stream: stream as ReadableStream<UIMessageChunk>
	});
};
