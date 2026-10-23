CREATE TABLE "ingest_event" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"documentId" text NOT NULL,
	"requestId" text NOT NULL,
	"sourceSha256" text NOT NULL,
	"textSha256" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"labelsetSnapshot" jsonb,
	"parser" jsonb,
	"status" text NOT NULL,
	"errorCode" text,
	"durationMs" integer,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "chars" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "sourceSha256" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "textSha256" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "docDate" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "labelsetId" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "labelsetVersion" integer;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "labelsetSnapshot" jsonb;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "ingestStatus" text DEFAULT 'raw_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "ingestError" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_event_userId_requestId_idx" ON "ingest_event" USING btree ("userId","requestId");--> statement-breakpoint
CREATE INDEX "ingest_event_documentId_idx" ON "ingest_event" USING btree ("documentId");