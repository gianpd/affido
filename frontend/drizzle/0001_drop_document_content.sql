-- Postgres stops holding document bodies: the bytes and the parsed markdown live in the
-- sandbox workspace (see docs/prd/0001-evidence-flow-v1.md). Documents created before
-- this migration lose their text and must be re-ingested.
ALTER TABLE "corpus_document" DROP CONSTRAINT "corpus_document_documentId_document_id_fk";
--> statement-breakpoint
ALTER TABLE "document" DROP COLUMN "content";