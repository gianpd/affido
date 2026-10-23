import { and, count, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '#lib/server/db';
import { corpus, corpusDocument, document, ingestEvent } from '#lib/server/db/schema';

export type DocumentSummary = {
	id: string;
	title: string;
	mimeType: string;
	size: number;
	createdAt: Date;
	updatedAt: Date;
	corpora: { id: string; name: string }[];
};

export type CorpusSummary = {
	id: string;
	name: string;
	description: string;
	createdAt: Date;
	updatedAt: Date;
	documents: number;
};

export const listDocuments = async (userId: string): Promise<DocumentSummary[]> => {
	const docs = await db
		.select()
		.from(document)
		.where(eq(document.userId, userId))
		.orderBy(desc(document.updatedAt));
	if (docs.length === 0) return [];

	const links = await db
		.select({ documentId: corpusDocument.documentId, id: corpus.id, name: corpus.name })
		.from(corpusDocument)
		.innerJoin(corpus, eq(corpus.id, corpusDocument.corpusId))
		.where(
			inArray(
				corpusDocument.documentId,
				docs.map((doc) => doc.id)
			)
		);

	const byDocument = new Map<string, { id: string; name: string }[]>();
	for (const link of links) {
		const list = byDocument.get(link.documentId) ?? [];
		list.push({ id: link.id, name: link.name });
		byDocument.set(link.documentId, list);
	}

	return docs.map((doc) => ({
		id: doc.id,
		title: doc.title,
		mimeType: doc.mimeType,
		size: doc.size,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		corpora: byDocument.get(doc.id) ?? []
	}));
};

export const getDocument = async (userId: string, id: string) => {
	const [row] = await db
		.select()
		.from(document)
		.where(and(eq(document.userId, userId), eq(document.id, id)))
		.limit(1);
	return row;
};

export const createDocument = async (
	userId: string,
	input: {
		/** Caller-owned: the workspace path and the ingest request are keyed by it. */
		id: string;
		title: string;
		filename: string;
		mimeType: string;
		bytes: number;
		sourceSha256: string;
		corpusId?: string | null;
	}
) => {
	await db.insert(document).values({
		id: input.id,
		userId,
		title: input.title,
		filename: input.filename,
		mimeType: input.mimeType,
		size: input.bytes,
		sourceSha256: input.sourceSha256,
		ingestStatus: 'raw_only'
	});
	if (input.corpusId) await addDocumentToCorpus(userId, input.corpusId, input.id);
	return input.id;
};

/** Append one ingestion event. A replay of the same `(userId, requestId)` is
 * ignored: the first record of what happened is the one that counts. */
export const recordIngestEvent = async (
	userId: string,
	input: {
		id: string;
		documentId: string;
		requestId: string;
		sourceSha256: string;
		bytes: number;
		status: string;
		errorCode?: string | null;
		durationMs?: number | null;
		parser?: unknown;
		labelsetSnapshot?: unknown;
	}
) => {
	await db
		.insert(ingestEvent)
		.values({
			id: input.id,
			userId,
			documentId: input.documentId,
			requestId: input.requestId,
			sourceSha256: input.sourceSha256,
			bytes: input.bytes,
			status: input.status,
			errorCode: input.errorCode ?? null,
			durationMs: input.durationMs ?? null,
			parser: input.parser ?? null,
			labelsetSnapshot: input.labelsetSnapshot ?? null
		})
		.onConflictDoNothing();
};

export const deleteDocument = async (userId: string, id: string) => {
	await db.delete(document).where(and(eq(document.userId, userId), eq(document.id, id)));
};

export const listCorpora = async (userId: string): Promise<CorpusSummary[]> => {
	const rows = await db
		.select({
			id: corpus.id,
			name: corpus.name,
			description: corpus.description,
			createdAt: corpus.createdAt,
			updatedAt: corpus.updatedAt,
			documents: count(corpusDocument.documentId)
		})
		.from(corpus)
		.leftJoin(corpusDocument, eq(corpusDocument.corpusId, corpus.id))
		.where(eq(corpus.userId, userId))
		.groupBy(corpus.id)
		.orderBy(desc(corpus.updatedAt));
	return rows.map((row) => ({ ...row, documents: Number(row.documents) }));
};

export const getCorpus = async (userId: string, id: string) => {
	const [row] = await db
		.select()
		.from(corpus)
		.where(and(eq(corpus.userId, userId), eq(corpus.id, id)))
		.limit(1);
	return row;
};

export const createCorpus = async (
	userId: string,
	input: { name: string; description: string }
): Promise<string> => {
	const id = crypto.randomUUID();
	await db.insert(corpus).values({ id, userId, name: input.name, description: input.description });
	return id;
};

export const deleteCorpus = async (userId: string, id: string) => {
	await db.delete(corpus).where(and(eq(corpus.userId, userId), eq(corpus.id, id)));
};

export const listCorpusDocuments = async (userId: string, corpusId: string) => {
	const owned = await getCorpus(userId, corpusId);
	if (!owned) return [];
	return db
		.select({
			id: document.id,
			title: document.title,
			mimeType: document.mimeType,
			size: document.size,
			addedAt: corpusDocument.addedAt
		})
		.from(corpusDocument)
		.innerJoin(document, eq(document.id, corpusDocument.documentId))
		.where(eq(corpusDocument.corpusId, corpusId))
		.orderBy(desc(corpusDocument.addedAt));
};

export const listDocumentsOutsideCorpus = async (userId: string, corpusId: string) => {
	const memberIds = db
		.select({ id: corpusDocument.documentId })
		.from(corpusDocument)
		.where(eq(corpusDocument.corpusId, corpusId));
	return db
		.select({ id: document.id, title: document.title })
		.from(document)
		.where(and(eq(document.userId, userId), notInArray(document.id, memberIds)))
		.orderBy(desc(document.updatedAt));
};

export const addDocumentToCorpus = async (
	userId: string,
	corpusId: string,
	documentId: string
): Promise<boolean> => {
	const [ownedCorpus, ownedDocument] = await Promise.all([
		getCorpus(userId, corpusId),
		getDocument(userId, documentId)
	]);
	if (!ownedCorpus || !ownedDocument) return false;
	await db.insert(corpusDocument).values({ corpusId, documentId }).onConflictDoNothing();
	await touchCorpus(corpusId);
	return true;
};

export const removeDocumentFromCorpus = async (
	userId: string,
	corpusId: string,
	documentId: string
): Promise<boolean> => {
	const owned = await getCorpus(userId, corpusId);
	if (!owned) return false;
	await db
		.delete(corpusDocument)
		.where(and(eq(corpusDocument.corpusId, corpusId), eq(corpusDocument.documentId, documentId)));
	await touchCorpus(corpusId);
	return true;
};

const touchCorpus = async (id: string) => {
	await db.update(corpus).set({ updatedAt: new Date() }).where(eq(corpus.id, id));
};

export const documentStats = async (userId: string) => {
	const [docRow] = await db
		.select({ value: count(), bytes: sql<number>`coalesce(sum(${document.size}), 0)` })
		.from(document)
		.where(eq(document.userId, userId));
	const [corpusRow] = await db
		.select({ value: count() })
		.from(corpus)
		.where(eq(corpus.userId, userId));
	return {
		documents: docRow?.value ?? 0,
		bytes: Number(docRow?.bytes ?? 0),
		corpora: corpusRow?.value ?? 0
	};
};
