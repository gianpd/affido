import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

export * from './auth.schema';

/** One user's document: metadata only.
 *
 * The bytes live at `corpus/raw/<docId><ext>` in the sandbox workspace and the
 * parsed markdown at `corpus/docs/<docId>.md`; neither is stored here. This row
 * is the current state, `ingestEvent` is the history of how it got that way. */
export const document = pgTable(
	'document',
	{
		id: text('id').primaryKey(),
		userId: text('userId').notNull(),
		title: text('title').notNull(),
		/** Original upload name: with `id` it determines the workspace path.
		 * Nullable because documents ingested before the sandbox owned the bytes have
		 * no filename on record; they must be re-ingested before they can be read. */
		filename: text('filename'),
		mimeType: text('mimeType').notNull().default('text/plain'),
		/** Uploaded bytes. */
		size: integer('size').notNull().default(0),
		/** Code points of the parsed markdown; set by the parse step (PRD 0001 §6.2). */
		chars: integer('chars'),
		/** sha256 of the uploaded bytes: proves which document this is. */
		sourceSha256: text('sourceSha256'),
		/** sha256 of the parsed markdown UTF-8: pins the version citations point at. */
		textSha256: text('textSha256'),
		docDate: text('docDate'),
		labelsetId: text('labelsetId'),
		labelsetVersion: integer('labelsetVersion'),
		labelsetSnapshot: jsonb('labelsetSnapshot').$type<unknown>(),
		/** `raw_only` (bytes staged, not parsed) | `parsed` | `failed`. */
		ingestStatus: text('ingestStatus').notNull().default('raw_only'),
		ingestError: text('ingestError'),
		createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updatedAt', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('document_userId_idx').on(table.userId)]
);

/** Append-only record of every ingestion attempt: what arrived, what happened to
 * it, and why. Never holds document content; `requestId` makes a retry idempotent
 * even after the sandbox is rebuilt. */
export const ingestEvent = pgTable(
	'ingest_event',
	{
		id: text('id').primaryKey(),
		userId: text('userId').notNull(),
		/** No foreign key on purpose: an audit row must outlive the document it
		 * describes, so deleting a document cannot erase the record of its ingestion. */
		documentId: text('documentId').notNull(),
		requestId: text('requestId').notNull(),
		sourceSha256: text('sourceSha256').notNull(),
		textSha256: text('textSha256'),
		bytes: integer('bytes').notNull().default(0),
		labelsetSnapshot: jsonb('labelsetSnapshot').$type<unknown>(),
		/** Parser traceability: structure, ner, ocr, doc_date. No markdown. */
		parser: jsonb('parser').$type<unknown>(),
		status: text('status').notNull(),
		errorCode: text('errorCode'),
		durationMs: integer('durationMs'),
		createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		uniqueIndex('ingest_event_userId_requestId_idx').on(table.userId, table.requestId),
		index('ingest_event_documentId_idx').on(table.documentId)
	]
);

/** A named collection of documents. One document may belong to many corpora. */
export const corpus = pgTable(
	'corpus',
	{
		id: text('id').primaryKey(),
		userId: text('userId').notNull(),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updatedAt', { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('corpus_userId_idx').on(table.userId)]
);

export const corpusDocument = pgTable(
	'corpus_document',
	{
		corpusId: text('corpusId')
			.notNull()
			.references(() => corpus.id, { onDelete: 'cascade' }),
		/** No foreign key on purpose: an audit row must outlive the document it
		 * describes, so deleting a document cannot erase the record of its ingestion. */
		documentId: text('documentId').notNull(),
		addedAt: timestamp('addedAt', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.corpusId, table.documentId] }),
		index('corpus_document_documentId_idx').on(table.documentId)
	]
);

/** UI history for the AI SDK chat. The sandbox keeps the agent's own durable
 * conversation; this table is the renderable copy (UIMessage parts). */
export const chatMessage = pgTable(
	'chat_message',
	{
		id: text('id').primaryKey(),
		userId: text('userId').notNull(),
		/** The sandbox conversation this message belongs to; rows survive New session (RFC 0008). */
		conversationId: integer('conversationId').notNull().default(1),
		role: text('role').notNull(),
		parts: jsonb('parts').$type<unknown[]>().notNull(),
		createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [
		index('chat_message_userId_conversationId_createdAt_idx').on(
			table.userId,
			table.conversationId,
			table.createdAt
		)
	]
);

/** Snapshot of one sandbox conversation trace, append-only: every capture of
 * every conversation is kept, so the trace page shows the full capture history
 * of the user, not just the newest state of each conversation. */
export const traceSession = pgTable(
	'trace_session',
	{
		id: text('id').primaryKey(),
		userId: text('userId').notNull(),
		conversationId: integer('conversationId').notNull(),
		agent: text('agent').notNull(),
		paused: boolean('paused').notNull().default(false),
		entries: integer('entries').notNull().default(0),
		tokens: integer('tokens').notNull().default(0),
		cost: doublePrecision('cost').notNull().default(0),
		report: jsonb('report').$type<unknown>().notNull(),
		capturedAt: timestamp('capturedAt', { withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull()
	},
	(table) => [index('trace_session_userId_capturedAt_idx').on(table.userId, table.capturedAt)]
);
