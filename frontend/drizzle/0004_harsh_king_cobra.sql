DROP INDEX "chat_message_userId_createdAt_idx";--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN "conversationId" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "chat_message_userId_conversationId_createdAt_idx" ON "chat_message" USING btree ("userId","conversationId","createdAt");