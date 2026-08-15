import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    githubUserId: text("github_user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_github_user_id_idx").on(table.githubUserId)],
);

export const digestPreferences = pgTable(
  "digest_preferences",
  {
    userId: bigint("user_id", { mode: "number" })
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull().default(1),
    hour: smallint("hour").notNull().default(9),
    minute: smallint("minute").notNull().default(0),
    timezone: text("timezone").notNull().default("UTC"),
    itemCount: smallint("item_count").notNull().default(4),
    paused: boolean("paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("digest_preferences_day_of_week_check", sql`${table.dayOfWeek} between 1 and 7`),
    check("digest_preferences_hour_check", sql`${table.hour} between 0 and 23`),
    check("digest_preferences_minute_check", sql`${table.minute} between 0 and 59`),
    check("digest_preferences_item_count_check", sql`${table.itemCount} in (3, 4, 5)`),
  ],
);

export const digests = pgTable(
  "digests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    itemCount: smallint("item_count").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("digests_user_period_idx").on(table.userId, table.periodKey),
    index("digests_user_status_idx").on(table.userId, table.status),
    check("digests_item_count_check", sql`${table.itemCount} in (3, 4, 5)`),
    check("digests_status_check", sql`${table.status} in ('pending', 'sending', 'sent', 'failed')`),
  ],
);

export const digestItems = pgTable(
  "digest_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    digestId: bigint("digest_id", { mode: "number" })
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    ownerLogin: text("owner_login").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    description: text("description"),
    language: text("language"),
    starCount: integer("star_count").notNull(),
    htmlUrl: text("html_url").notNull(),
    starredAt: timestamp("starred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("digest_items_digest_position_idx").on(table.digestId, table.position),
    uniqueIndex("digest_items_digest_repository_idx").on(table.digestId, table.repositoryId),
  ],
);

export const emailActionTokens = pgTable(
  "email_action_tokens",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    nonce: text("nonce").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    digestItemId: bigint("digest_item_id", { mode: "number" })
      .notNull()
      .references(() => digestItems.id, { onDelete: "cascade" }),
    intendedAction: text("intended_action").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    feedbackEventId: bigint("feedback_event_id", { mode: "number" }),
    previousStatus: text("previous_status"),
    previousNextEligibleAt: timestamp("previous_next_eligible_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("email_action_tokens_digest_action_idx").on(table.digestItemId, table.intendedAction),
    index("email_action_tokens_digest_item_idx").on(table.digestItemId),
    check(
      "email_action_tokens_action_check",
      sql`${table.intendedAction} in ('still_interested', 'snooze', 'done', 'forget')`,
    ),
  ],
);

export const githubCredentials = pgTable("github_credentials", {
  userId: bigint("user_id", { mode: "number" })
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAttempts = pgTable("oauth_attempts", {
  stateHash: text("state_hash").primaryKey(),
  browserNonceHash: text("browser_nonce_hash").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const imports = pgTable(
  "imports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    syncType: text("sync_type").notNull().default("initial"),
    syncToken: text("sync_token"),
    status: text("status").notNull().default("pending"),
    pagesCompleted: integer("pages_completed").notNull().default(0),
    importedRepositories: integer("imported_repositories").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("imports_user_created_idx").on(table.userId, table.createdAt),
    check(
      "imports_status_check",
      sql`${table.status} in ('pending', 'running', 'retrying', 'completed', 'failed', 'failed_revoked', 'failed_rate_limit')`,
    ),
    check("imports_sync_type_check", sql`${table.syncType} in ('initial', 'manual', 'weekly')`),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    githubRepositoryId: text("github_repository_id").notNull(),
    ownerLogin: text("owner_login").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    description: text("description"),
    language: text("language"),
    starCount: integer("star_count").notNull(),
    htmlUrl: text("html_url").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("repositories_github_id_idx").on(table.githubRepositoryId)],
);

export const starredRepositories = pgTable(
  "starred_repositories",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    starredAt: timestamp("starred_at", { withTimezone: true }).notNull(),
    lastSeenSyncToken: text("last_seen_sync_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repositoryId] })],
);

export const rotationStates = pgTable(
  "rotation_states",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }).notNull(),
    lastPresentedAt: timestamp("last_presented_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.repositoryId] }),
    index("rotation_states_eligible_idx").on(table.userId, table.status, table.nextEligibleAt),
    check("rotation_states_status_check", sql`${table.status} in ('active', 'done', 'forgotten')`),
  ],
);

export const rotationFeedbackEvents = pgTable(
  "rotation_feedback_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" })
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    resultingStatus: text("resulting_status").notNull(),
    compensatesEventId: bigint("compensates_event_id", { mode: "number" }),
  },
  (table) => [
    index("rotation_feedback_events_repository_idx").on(table.userId, table.repositoryId, table.id),
    check(
      "rotation_feedback_events_action_check",
      sql`${table.action} in ('still_interested', 'snooze', 'done', 'forget', 'undo')`,
    ),
    check(
      "rotation_feedback_events_status_check",
      sql`${table.resultingStatus} in ('active', 'done', 'forgotten')`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull().default("pending"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_due_idx").on(table.status, table.runAfter),
    uniqueIndex("jobs_idempotency_key_idx").on(table.idempotencyKey),
    check("jobs_status_check", sql`${table.status} in ('pending', 'running', 'completed', 'failed')`),
  ],
);
