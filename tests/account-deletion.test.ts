import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { hashToken, randomToken } from "../src/auth/crypto";
import { startTestApplication } from "./support/test-application";

let application: Awaited<ReturnType<typeof startTestApplication>>;
let database: ReturnType<typeof postgres>;
let sessionCookie: string;
let userId: number;
let repositoryId: number;

beforeAll(async () => {
  application = await startTestApplication();
  database = postgres(application.databaseUrl);

  const users = await database<{ id: number }[]>`
    insert into users (github_user_id, github_login, email)
    values ('delete-user', 'delete-user', 'delete@example.test')
    returning id
  `;
  userId = users[0]!.id;
  const sessionToken = randomToken();
  sessionCookie = `restar_session=${sessionToken}`;
  await database`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(sessionToken)}, ${userId}, now() + interval '1 day')
  `;

  const repositories = await database<{ id: number }[]>`
    insert into repositories (
      github_repository_id, owner_login, name, full_name, star_count, html_url
    ) values ('delete-repository', 'owner', 'repository', 'owner/repository', 12, 'https://github.com/owner/repository')
    returning id
  `;
  repositoryId = repositories[0]!.id;
  const digests = await database<{ id: number }[]>`
    insert into digests (user_id, period_key, scheduled_for, item_count)
    values (${userId}, 'delete-period', now(), 4)
    returning id
  `;
  const items = await database<{ id: number }[]>`
    insert into digest_items (
      digest_id, position, repository_id, owner_login, name, full_name,
      star_count, html_url, starred_at
    ) values (
      ${digests[0]!.id}, 1, ${repositoryId}, 'owner', 'repository', 'owner/repository',
      12, 'https://github.com/owner/repository', now()
    )
    returning id
  `;
  await database`insert into digest_preferences (user_id) values (${userId})`;
  await database`insert into github_credentials (user_id, encrypted_access_token) values (${userId}, 'encrypted')`;
  await database`
    insert into starred_repositories (user_id, repository_id, starred_at)
    values (${userId}, ${repositoryId}, now())
  `;
  await database`
    insert into rotation_states (user_id, repository_id, next_eligible_at)
    values (${userId}, ${repositoryId}, now())
  `;
  await database`
    insert into rotation_feedback_events (user_id, repository_id, action, resulting_status)
    values (${userId}, ${repositoryId}, 'forget', 'forgotten')
  `;
  await database`
    insert into email_action_tokens (
      nonce_hash, nonce, user_id, digest_item_id, intended_action, expires_at
    ) values ('delete-nonce-hash', 'delete-nonce', ${userId}, ${items[0]!.id}, 'forget', now() + interval '1 day')
  `;
  await database`insert into imports (user_id) values (${userId})`;
  await database`
    insert into jobs (kind, payload, run_after)
    values ('github-stars-import', ${database.json({ userId })}, now())
  `;
});

afterAll(async () => {
  await database?.end();
  await application?.stop();
});

it("requires explicit confirmation before deleting a User", async () => {
  const response = await application.request("/api/account", {
    method: "DELETE",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "keep" }),
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "Type DELETE to confirm account deletion" });
  const remaining = await database<{ count: string }[]>`select count(*) from users where id = ${userId}`;
  expect(remaining).toEqual([{ count: "1" }]);
});

it("deletes the User's account data and invalidates the session", async () => {
  const response = await application.request("/api/account", {
    method: "DELETE",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ deleted: true });
  expect(response.headers.get("set-cookie")).toContain("restar_session=");

  const counts = await database<{ users: string; sessions: string; preferences: string; credentials: string; imports: string; digests: string; starred: string; rotation: string; feedback: string; tokens: string; jobs: string }[]>`
    select
      (select count(*) from users where id = ${userId}) as users,
      (select count(*) from sessions where user_id = ${userId}) as sessions,
      (select count(*) from digest_preferences where user_id = ${userId}) as preferences,
      (select count(*) from github_credentials where user_id = ${userId}) as credentials,
      (select count(*) from imports where user_id = ${userId}) as imports,
      (select count(*) from digests where user_id = ${userId}) as digests,
      (select count(*) from starred_repositories where user_id = ${userId}) as starred,
      (select count(*) from rotation_states where user_id = ${userId}) as rotation,
      (select count(*) from rotation_feedback_events where user_id = ${userId}) as feedback,
      (select count(*) from email_action_tokens where user_id = ${userId}) as tokens,
      (select count(*) from jobs where payload->>'userId' = ${String(userId)}) as jobs
  `;
  expect(counts).toEqual([{
    users: "0",
    sessions: "0",
    preferences: "0",
    credentials: "0",
    imports: "0",
    digests: "0",
    starred: "0",
    rotation: "0",
    feedback: "0",
    tokens: "0",
    jobs: "0",
  }]);

  const unauthorized = await application.request("/api/account", {
    method: "DELETE",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE" }),
  });
  expect(unauthorized.status).toBe(401);
});
