import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { issueEmailActionToken } from "../src/email/actions";
import { startTestApplication } from "./support/test-application";

const now = new Date("2026-08-15T12:00:00.000Z");
const secret = "email-action-test-secret";
const day = 24 * 60 * 60 * 1000;

let application: Awaited<ReturnType<typeof startTestApplication>>;
let database: ReturnType<typeof postgres>;
let userId: number;
let itemSequence = 0;

beforeAll(async () => {
  application = await startTestApplication({
    environment: { EMAIL_ACTION_TOKEN_SECRET: secret },
  });
  database = postgres(application.databaseUrl);
  const users = await database<{ id: number }[]>`
    insert into users (github_user_id, github_login, email)
    values ('email-actions-user', 'email-actions-user', 'private@example.test')
    returning id
  `;
  userId = users[0]!.id;
});

afterAll(async () => {
  await database?.end();
  await application?.stop();
});

async function addActionItem(
  action: "still_interested" | "snooze" | "done" | "forget",
  expiresAt = new Date(now.getTime() + 365 * day),
) {
  itemSequence += 1;
  const slug = `email-${action}-${itemSequence}`;
  const repositories = await database<{ id: number }[]>`
    insert into repositories (
      github_repository_id, owner_login, name, full_name, description, language, star_count, html_url
    ) values (
      ${slug}, 'acme', ${slug}, ${`acme/${slug}`},
      'Email action test repository', 'TypeScript', 42, ${`https://github.com/acme/email-${action}`}
    ) returning id
  `;
  const repositoryId = repositories[0]!.id;
  await database`
    insert into starred_repositories (user_id, repository_id, starred_at)
    values (${userId}, ${repositoryId}, ${new Date(now.getTime() - 60 * day)})
  `;
  await database`
    insert into rotation_states (user_id, repository_id, status, next_eligible_at)
    values (${userId}, ${repositoryId}, 'active', ${new Date(0)})
  `;
  const digests = await database<{ id: number }[]>`
    insert into digests (user_id, period_key, scheduled_for, item_count, status)
    values (${userId}, ${`email-action-${slug}`}, ${now}, 4, 'sent')
    returning id
  `;
  const items = await database<{ id: number }[]>`
    insert into digest_items (
      digest_id, position, repository_id, owner_login, name, full_name, description,
      language, star_count, html_url, starred_at
    ) values (
      ${digests[0]!.id}, 1, ${repositoryId}, 'acme', ${slug},
      ${`acme/${slug}`}, 'Email action test repository', 'TypeScript', 42,
      ${`https://github.com/acme/${slug}`}, ${new Date(now.getTime() - 60 * day)}
    ) returning id
  `;
  const token = await issueEmailActionToken(database, {
    userId,
    digestItemId: items[0]!.id,
    action,
    expiresAt,
  }, secret, now);
  return { repositoryId, digestItemId: items[0]!.id, token };
}

function formBody(token: string) {
  return new URLSearchParams({ token }).toString();
}

it("confirms email actions on GET, applies every action once, and rejects replay", async () => {
  const actions = ["still_interested", "snooze", "done", "forget"] as const;
  const items = await Promise.all(actions.map((action) => addActionItem(action)));

  for (const item of items) {
    const confirmation = await application.request(`/email/action?token=${encodeURIComponent(item.token)}`);
    expect(confirmation.status).toBe(200);
    expect(confirmation.headers.get("cache-control")).toBe("no-store");
    expect(await confirmation.text()).toContain("Confirm");

    const before = await database<{ count: number }[]>`
      select count(*)::int as count from rotation_feedback_events where user_id = ${userId} and repository_id = ${item.repositoryId}
    `;
    expect(before[0]!.count).toBe(0);

    const applied = await application.request("/api/email/action", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(item.token),
    });
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({ action: actions[items.indexOf(item)] });

    const replay = await application.request("/api/email/action", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody(item.token),
    });
    expect(replay.status).toBe(409);
  }
});

it("rejects tampered and expired links without changing Rotation", async () => {
  const tampered = await addActionItem("snooze");
  const changed = `${tampered.token.slice(0, -1)}${tampered.token.endsWith("a") ? "b" : "a"}`;
  const tamperedResponse = await application.request(`/api/email/action?token=${encodeURIComponent(changed)}`);
  expect(tamperedResponse.status).toBe(400);

  const expiredItem = await addActionItem("done", new Date(now.getTime() - day));
  const expiredResponse = await application.request(`/api/email/action?token=${encodeURIComponent(expiredItem.token)}`);
  expect(expiredResponse.status).toBe(410);
  const events = await database<{ count: number }[]>`
    select count(*)::int as count from rotation_feedback_events where repository_id = ${expiredItem.repositoryId}
  `;
  expect(events[0]!.count).toBe(0);
});

it("offers Undo and records a compensating event that restores prior Rotation state", async () => {
  const item = await addActionItem("snooze");
  const applied = await application.request("/email/action", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: formBody(item.token),
  });
  expect(applied.status).toBe(200);
  const result = await applied.text();
  const undoToken = result.match(/name="token" value="([^"]+)"/)?.[1];
  expect(undoToken).toBeTruthy();
  expect(result).toContain("Undo");

  const undone = await application.request("/api/email/action/undo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(undoToken!),
  });
  expect(undone.status).toBe(200);
  await expect(undone.json()).resolves.toMatchObject({ undone: true });

  const state = await database<{ status: string; next_eligible_at: Date }[]>`
    select status, next_eligible_at from rotation_states where repository_id = ${item.repositoryId}
  `;
  expect(state).toEqual([{ status: "active", next_eligible_at: new Date(0) }]);
  const events = await database<{ action: string; compensates_event_id: number | null }[]>`
    select action, compensates_event_id from rotation_feedback_events where repository_id = ${item.repositoryId} order by id
  `;
  expect(events).toEqual([
    { action: "snooze", compensates_event_id: null },
    { action: "undo", compensates_event_id: expect.any(String) },
  ]);

  const replayAfterUndo = await application.request("/api/email/action", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(item.token),
  });
  expect(replayAfterUndo.status).toBe(409);
});
