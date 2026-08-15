ALTER TABLE "imports" ADD COLUMN "sync_type" text DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "sync_token" text;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_sync_type_check" CHECK ("imports"."sync_type" in ('initial', 'manual'));--> statement-breakpoint
ALTER TABLE "starred_repositories" ADD COLUMN "last_seen_sync_token" text;
