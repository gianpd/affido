CREATE TABLE "chat_message" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpus" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corpus_document" (
	"corpusId" text NOT NULL,
	"documentId" text NOT NULL,
	"addedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corpus_document_corpusId_documentId_pk" PRIMARY KEY("corpusId","documentId")
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"mimeType" text DEFAULT 'text/plain' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_session" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"conversationId" integer NOT NULL,
	"agent" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"entries" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"report" jsonb NOT NULL,
	"capturedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
-- Compatibility with a control-plane database where e2e tests already created
-- the four-column seed table (id, userId, token, expiresAt).
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "createdAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "ipAddress" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "userAgent" text;--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corpus_document" ADD CONSTRAINT "corpus_document_corpusId_corpus_id_fk" FOREIGN KEY ("corpusId") REFERENCES "public"."corpus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corpus_document" ADD CONSTRAINT "corpus_document_documentId_document_id_fk" FOREIGN KEY ("documentId") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_userId_createdAt_idx" ON "chat_message" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "corpus_userId_idx" ON "corpus" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "corpus_document_documentId_idx" ON "corpus_document" USING btree ("documentId");--> statement-breakpoint
CREATE INDEX "document_userId_idx" ON "document" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_session_userId_conversationId_idx" ON "trace_session" USING btree ("userId","conversationId");--> statement-breakpoint
CREATE INDEX "trace_session_userId_capturedAt_idx" ON "trace_session" USING btree ("userId","capturedAt");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");