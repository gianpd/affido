import { and, count, countDistinct, desc, eq, sql } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '#lib/server/db';
import { traceSession } from '#lib/server/db/schema';
import { inspectSandbox } from '#lib/server/sandbox';
import type { TraceReport } from '#lib/types';

/**
 * The sandbox exposes the trace of its current conversation. The web app keeps
 * every capture (append-only): each row is one snapshot of one conversation at
 * one point in time, so the trace page shows the full capture history of the
 * user — not just the newest state of each conversation — without activating
 * every sandbox on page load.
 */
export async function captureTrace(
	event: RequestEvent,
	options: { conversationId?: number; limit?: number } = {}
): Promise<TraceReport> {
	const report = await inspectSandbox(event, { limit: 500, ...options });
	const userId = event.locals.user?.id;
	if (!userId) throw new Error('captureTrace requires a signed-in user');

	await db.insert(traceSession).values({
		id: crypto.randomUUID(),
		userId,
		conversationId: report.conversationId,
		agent: report.agent,
		paused: report.paused,
		entries: report.entries.returned,
		tokens: report.usage.totalTokens,
		cost: report.usage.cost,
		report,
		capturedAt: new Date()
	});

	return report;
}

/** The newest 500 captures of the user — the list page stays bounded as history grows. */
export async function listTraceSessions(userId: string) {
	return db
		.select({
			id: traceSession.id,
			conversationId: traceSession.conversationId,
			agent: traceSession.agent,
			paused: traceSession.paused,
			entries: traceSession.entries,
			tokens: traceSession.tokens,
			cost: traceSession.cost,
			capturedAt: traceSession.capturedAt,
			createdAt: traceSession.createdAt
		})
		.from(traceSession)
		.where(eq(traceSession.userId, userId))
		.orderBy(desc(traceSession.capturedAt))
		.limit(500);
}

export async function getTraceSession(userId: string, id: string) {
	const [row] = await db
		.select()
		.from(traceSession)
		.where(and(eq(traceSession.userId, userId), eq(traceSession.id, id)))
		.limit(1);
	return row;
}

/** Every snapshot of one conversation, oldest first: the detail page's timeline. */
export async function listConversationSnapshots(userId: string, conversationId: number) {
	return db
		.select({ id: traceSession.id, capturedAt: traceSession.capturedAt })
		.from(traceSession)
		.where(and(eq(traceSession.userId, userId), eq(traceSession.conversationId, conversationId)))
		.orderBy(traceSession.capturedAt);
}

export async function countTraceSessions(userId: string): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(traceSession)
		.where(eq(traceSession.userId, userId));
	return row?.value ?? 0;
}

export async function countTraceConversations(userId: string): Promise<number> {
	const [row] = await db
		.select({ value: countDistinct(traceSession.conversationId) })
		.from(traceSession)
		.where(eq(traceSession.userId, userId));
	return row?.value ?? 0;
}

export async function deleteTraceSession(userId: string, id: string): Promise<void> {
	await db
		.delete(traceSession)
		.where(and(eq(traceSession.userId, userId), eq(traceSession.id, id)));
}

/**
 * Totals over the newest snapshot of each conversation only: snapshots of the
 * same conversation overlap, so summing every row would double-count usage.
 */
export async function traceTotals(userId: string) {
	const [row] = await db
		.select({
			tokens: sql<number>`coalesce(sum(${traceSession.tokens}), 0)`,
			cost: sql<number>`coalesce(sum(${traceSession.cost}), 0)`
		})
		.from(
			sql`(select distinct on (${traceSession.conversationId}) ${traceSession.tokens}, ${traceSession.cost} from ${traceSession} where ${traceSession.userId} = ${userId} order by ${traceSession.conversationId}, ${traceSession.capturedAt} desc) as latest`
		);
	return { tokens: Number(row?.tokens ?? 0), cost: Number(row?.cost ?? 0) };
}
