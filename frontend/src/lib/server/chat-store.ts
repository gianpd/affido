import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { UIMessage } from 'ai';
import { db } from '#lib/server/db';
import { chatMessage } from '#lib/server/db/schema';
import type { ChatSessionSummary } from '#lib/types';

/**
 * The chat view of the user's sessions (RFC 0008): one row per conversation
 * that has chat rows — the first question as the title, message count, activity
 * window — plus the active conversation even when it is still empty, so the
 * history list always contains the session the user is in.
 */

const TITLE_MAX = 96;

const textOfParts = (parts: unknown): string =>
	Array.isArray(parts)
		? parts
				.filter(
					(part): part is { type: string; text?: unknown } =>
						typeof part === 'object' &&
						part !== null &&
						typeof (part as { type?: unknown }).type === 'string'
				)
				.filter((part) => part.type === 'text' && typeof part.text === 'string')
				.map((part) => part.text as string)
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim()
		: '';

export async function listChatSessions(
	userId: string,
	activeConversationId: number | null
): Promise<ChatSessionSummary[]> {
	// One grouped row per conversation, and the earliest user message per
	// conversation for the title (the first row of a session is the user's
	// question; the WHERE keeps that true even if assistant rows ever land first).
	const [aggregates, firsts] = await Promise.all([
		db
			.select({
				conversationId: chatMessage.conversationId,
				messages: count(),
				firstAt: sql<Date | null>`min(${chatMessage.createdAt})`,
				lastAt: sql<Date | null>`max(${chatMessage.createdAt})`
			})
			.from(chatMessage)
			.where(eq(chatMessage.userId, userId))
			.groupBy(chatMessage.conversationId),
		db
			.selectDistinctOn([chatMessage.conversationId], {
				conversationId: chatMessage.conversationId,
				parts: chatMessage.parts
			})
			.from(chatMessage)
			.where(and(eq(chatMessage.userId, userId), eq(chatMessage.role, 'user')))
			.orderBy(chatMessage.conversationId, chatMessage.createdAt)
	]);

	const titles = new Map(firsts.map((row) => [row.conversationId, textOfParts(row.parts)]));

	const sessions: ChatSessionSummary[] = aggregates.map((row) => ({
		conversationId: row.conversationId,
		title: (titles.get(row.conversationId) ?? '').slice(0, TITLE_MAX),
		messages: Number(row.messages),
		firstAt: row.firstAt === null ? null : new Date(row.firstAt),
		lastAt: row.lastAt === null ? null : new Date(row.lastAt)
	}));

	if (
		activeConversationId !== null &&
		!sessions.some((session) => session.conversationId === activeConversationId)
	) {
		sessions.push({
			conversationId: activeConversationId,
			title: '',
			messages: 0,
			firstAt: null,
			lastAt: null
		});
	}

	return sessions.sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
}

/** The renderable chat of one conversation, oldest first. `null` is the offline
 * fallback of the page load: every message the user has ever sent. */
export async function conversationMessages(
	userId: string,
	conversationId: number | null
): Promise<UIMessage[]> {
	const rows = await db
		.select()
		.from(chatMessage)
		.where(
			conversationId === null
				? eq(chatMessage.userId, userId)
				: and(eq(chatMessage.userId, userId), eq(chatMessage.conversationId, conversationId))
		)
		.orderBy(desc(chatMessage.createdAt))
		.limit(200);
	return rows.reverse().map((row) => ({
		id: row.id,
		role: row.role === 'assistant' ? 'assistant' : 'user',
		parts: row.parts as UIMessage['parts']
	}));
}
