ALTER TABLE "digest_preferences" ADD COLUMN "inactivity_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_preferences" ADD COLUMN "pause_notice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digest_preferences" ADD COLUMN "pause_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "feedback_action_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "digest_preferences" ADD CONSTRAINT "digest_preferences_inactivity_count_check" CHECK ("digest_preferences"."inactivity_count" >= 0);--> statement-breakpoint
ALTER TABLE "digest_preferences" ADD CONSTRAINT "digest_preferences_pause_generation_check" CHECK ("digest_preferences"."pause_generation" >= 0);--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_feedback_action_count_check" CHECK ("digests"."feedback_action_count" >= 0);