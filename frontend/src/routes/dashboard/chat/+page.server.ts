import { conversationMessages, listChatSessions } from '#lib/server/chat-store';
import { requireUser } from '#lib/server/auth-helpers';
import { sandboxErrorMessage, statusSandbox } from '#lib/server/sandbox';
import { captureTrace } from '#lib/server/trace-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event.locals, event.url);

	type SandboxState =
		| {
				reachable: true;
				paused: boolean;
				agent: string;
				conversationId: number | null;
				entries: number;
				inFlight: number;
		  }
		| { reachable: false; error: string };

	let sandbox: SandboxState;
	let conversationId: number | null = null;

	try {
		const before = await statusSandbox(event);
		// A status read does not activate the agent; the trace read does, and it
		// keeps the trace page current even for sessions opened elsewhere.
		const report = await captureTrace(event).catch(() => undefined);
		const after = await statusSandbox(event).catch(() => before);
		conversationId =
			after.conversationId ?? report?.conversationId ?? before.conversationId ?? null;
		sandbox = {
			reachable: true,
			paused: after.paused,
			agent: after.agent,
			conversationId,
			entries: after.entries || report?.entries.returned || before.entries,
			inFlight: after.inFlight
		};
	} catch (error) {
		sandbox = { reachable: false, error: sandboxErrorMessage(error) };
	}

	// The chat shows the active conversation's messages (RFC 0008); when the
	// sandbox is unreachable, fall back to everything the user has asked.
	const messages = await conversationMessages(user.id, conversationId);
	const sessions = await listChatSessions(user.id, conversationId);

	return { messages, sessions, sandbox };
};
