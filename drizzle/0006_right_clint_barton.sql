CREATE TABLE "digest_preferences" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"day_of_week" smallint DEFAULT 1 NOT NULL,
	"hour" smallint DEFAULT 9 NOT NULL,
	"minute" smallint DEFAULT 0 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"item_count" smallint DEFAULT 4 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_preferences_day_of_week_check" CHECK ("digest_preferences"."day_of_week" between 1 and 7),
	CONSTRAINT "digest_preferences_hour_check" CHECK ("digest_preferences"."hour" between 0 and 23),
	CONSTRAINT "digest_preferences_minute_check" CHECK ("digest_preferences"."minute" between 0 and 59),
	CONSTRAINT "digest_preferences_item_count_check" CHECK ("digest_preferences"."item_count" in (3, 4, 5))
);
--> statement-breakpoint
ALTER TABLE "digest_preferences" ADD CONSTRAINT "digest_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;