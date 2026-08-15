import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_github_user_id_idx").on(table.githubUserId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.repositoryId] })],
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
