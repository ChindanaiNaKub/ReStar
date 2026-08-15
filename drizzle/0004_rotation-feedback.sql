CREATE TABLE "rotation_feedback_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_eligible_at" timestamp with time zone,
	"resulting_status" text NOT NULL,
	CONSTRAINT "rotation_feedback_events_action_check" CHECK ("rotation_feedback_events"."action" in ('still_interested', 'snooze', 'done', 'forget')),
	CONSTRAINT "rotation_feedback_events_status_check" CHECK ("rotation_feedback_events"."resulting_status" in ('active', 'done', 'forgotten'))
);
--> statement-breakpoint
CREATE TABLE "rotation_states" (
	"user_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL,
	"last_presented_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_states_user_id_repository_id_pk" PRIMARY KEY("user_id","repository_id"),
	CONSTRAINT "rotation_states_status_check" CHECK ("rotation_states"."status" in ('active', 'done', 'forgotten'))
);
--> statement-breakpoint
ALTER TABLE "rotation_feedback_events" ADD CONSTRAINT "rotation_feedback_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_feedback_events" ADD CONSTRAINT "rotation_feedback_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_states" ADD CONSTRAINT "rotation_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_states" ADD CONSTRAINT "rotation_states_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rotation_feedback_events_repository_idx" ON "rotation_feedback_events" USING btree ("user_id","repository_id","id");--> statement-breakpoint
CREATE INDEX "rotation_states_eligible_idx" ON "rotation_states" USING btree ("user_id","status","next_eligible_at");