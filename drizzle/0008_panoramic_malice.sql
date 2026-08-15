CREATE TABLE "email_action_tokens" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"nonce" text NOT NULL,
	"user_id" bigint NOT NULL,
	"digest_item_id" bigint NOT NULL,
	"intended_action" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"feedback_event_id" bigint,
	"previous_status" text,
	"previous_next_eligible_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_action_tokens_action_check" CHECK ("email_action_tokens"."intended_action" in ('still_interested', 'snooze', 'done', 'forget'))
);
--> statement-breakpoint
ALTER TABLE "rotation_feedback_events" DROP CONSTRAINT "rotation_feedback_events_action_check";--> statement-breakpoint
ALTER TABLE "rotation_feedback_events" ADD COLUMN "compensates_event_id" bigint;--> statement-breakpoint
ALTER TABLE "email_action_tokens" ADD CONSTRAINT "email_action_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_action_tokens" ADD CONSTRAINT "email_action_tokens_digest_item_id_digest_items_id_fk" FOREIGN KEY ("digest_item_id") REFERENCES "public"."digest_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_action_tokens_digest_action_idx" ON "email_action_tokens" USING btree ("digest_item_id","intended_action");--> statement-breakpoint
CREATE INDEX "email_action_tokens_digest_item_idx" ON "email_action_tokens" USING btree ("digest_item_id");--> statement-breakpoint
ALTER TABLE "rotation_feedback_events" ADD CONSTRAINT "rotation_feedback_events_action_check" CHECK ("rotation_feedback_events"."action" in ('still_interested', 'snooze', 'done', 'forget', 'undo'));