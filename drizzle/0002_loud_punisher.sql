ALTER TABLE "jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key_idx" ON "jobs" USING btree ("idempotency_key");