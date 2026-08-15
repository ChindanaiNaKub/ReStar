CREATE TABLE "digest_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"digest_id" bigint NOT NULL,
	"position" smallint NOT NULL,
	"repository_id" bigint NOT NULL,
	"owner_login" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"description" text,
	"language" text,
	"star_count" integer NOT NULL,
	"html_url" text NOT NULL,
	"starred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"period_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"item_count" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digests_item_count_check" CHECK ("digests"."item_count" in (3, 4, 5)),
	CONSTRAINT "digests_status_check" CHECK ("digests"."status" in ('pending', 'sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "imports" DROP CONSTRAINT "imports_sync_type_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_items" ADD CONSTRAINT "digest_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digest_items_digest_position_idx" ON "digest_items" USING btree ("digest_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "digest_items_digest_repository_idx" ON "digest_items" USING btree ("digest_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_user_period_idx" ON "digests" USING btree ("user_id","period_key");--> statement-breakpoint
CREATE INDEX "digests_user_status_idx" ON "digests" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_sync_type_check" CHECK ("imports"."sync_type" in ('initial', 'manual', 'weekly'));