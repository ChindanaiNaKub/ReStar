import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { hashToken, randomToken } from "../src/auth/crypto";
import { startTestApplication } from "./support/test-application";

const day = 24 * 60 * 60 * 1000;

let application: Awaited<ReturnType<typeof startTestApplication>>;
let database: ReturnType<typeof postgres>;
let sessionCookie: string;

beforeAll(async () => {
  application = await startTestApplication();
  database = postgres(application.databaseUrl);
});

afterAll(async () => {
  await database?.end();
  await application?.stop();
});

async function resetDatabase() {
  await database`truncate rotation_feedback_events, rotation_states, starred_repositories, repositories, sessions, users restart identity cascade`;
  const sessionToken = randomToken();
  const users = await database<{ id: number }[]>`
    insert into users (github_user_id, github_login)
    values ('rotation-user', 'rotation-user')
    returning id
  `;
  await database`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(sessionToken)}, ${users[0]!.id}, ${new Date(Date.now() + day)})
  `;
  sessionCookie = `restar_session=${sessionToken}`;
  return users[0]!.id;
}

async function addRepository(
  userId: number,
  repository: { name: string; starredAt: Date },
) {
  const repositories = await database<{ id: number }[]>`
    insert into repositories (
      github_repository_id, owner_login, name, full_name, description, language, star_count, html_url
    ) values (
      ${repository.name}, 'acme', ${repository.name}, ${`acme/${repository.name}`},
      ${`${repository.name} description`}, 'TypeScript', 100, ${`https://github.com/acme/${repository.name}`}
    )
    returning id
  `;
  await database`
    insert into starred_repositories (user_id, repository_id, starred_at)
    values (${userId}, ${repositories[0]!.id}, ${repository.starredAt})
  `;
  return repositories[0]!.id;
}

it("returns only eligible Starred Repositories in fair Rotation order", async () => {
  const userId = await resetDatabase();
  const now = Date.now();
  const neverPresentedOld = await addRepository(userId, { name: "never-old", starredAt: new Date(now - 200 * day) });
  const neverPresentedNew = await addRepository(userId, { name: "never-new", starredAt: new Date(now - 100 * day) });
  const longestSincePresentation = await addRepository(userId, {
    name: "presented-longest",
    starredAt: new Date(now - 300 * day),
  });
  const recentlyPresented = await addRepository(userId, {
    name: "presented-recently",
    starredAt: new Date(now - 400 * day),
  });
  const samePresentationOldStar = await addRepository(userId, {
    name: "presented-same-time-old-star",
    starredAt: new Date(now - 250 * day),
  });
  const samePresentationNewStar = await addRepository(userId, {
    name: "presented-same-time-new-star",
    starredAt: new Date(now - 150 * day),
  });
  await addRepository(userId, { name: "too-new", starredAt: new Date(now - 29 * day) });
  const dueNow = await addRepository(userId, { name: "due-now", starredAt: new Date(now - 50 * day) });
  const snoozed = await addRepository(userId, { name: "snoozed", starredAt: new Date(now - 400 * day) });
  const done = await addRepository(userId, { name: "done", starredAt: new Date(now - 400 * day) });
  const forgotten = await addRepository(userId, { name: "forgotten", starredAt: new Date(now - 400 * day) });

  await database`
    insert into rotation_states (user_id, repository_id, status, next_eligible_at, last_presented_at)
    values
      (${userId}, ${longestSincePresentation}, 'active', ${new Date(now - 400 * day)}, ${new Date(now - 90 * day)}),
      (${userId}, ${samePresentationOldStar}, 'active', ${new Date(now - 400 * day)}, ${new Date(now - 20 * day)}),
      (${userId}, ${samePresentationNewStar}, 'active', ${new Date(now - 400 * day)}, ${new Date(now - 20 * day)}),
      (${userId}, ${recentlyPresented}, 'active', ${new Date(now - 400 * day)}, ${new Date(now - 10 * day)}),
      (${userId}, ${dueNow}, 'active', now(), null),
      (${userId}, ${snoozed}, 'active', ${new Date(now + 10 * day)}, null),
      (${userId}, ${done}, 'done', ${new Date(now - 400 * day)}, null),
      (${userId}, ${forgotten}, 'forgotten', ${new Date(now - 400 * day)}, null)
  `;

  const response = await application.request("/api/rotation", { headers: { cookie: sessionCookie } });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    repositories: [
      { repositoryId: neverPresentedOld, name: "never-old" },
      { repositoryId: neverPresentedNew, name: "never-new" },
      { repositoryId: dueNow, name: "due-now" },
      { repositoryId: longestSincePresentation, name: "presented-longest" },
      { repositoryId: samePresentationOldStar, name: "presented-same-time-old-star" },
      { repositoryId: samePresentationNewStar, name: "presented-same-time-new-star" },
      { repositoryId: recentlyPresented, name: "presented-recently" },
    ],
  });

  const page = await application.request("/rotation", { headers: { cookie: sessionCookie } });
  expect(page.status).toBe(200);
  const pageMarkup = await page.text();
  expect(pageMarkup).toContain("Open on GitHub");
  expect(pageMarkup).toContain("Still Interested");
});

it("applies every Feedback Action, retains events, and makes repeated submissions safe", async () => {
  const userId = await resetDatabase();
  const repositoryIds = await Promise.all([
    addRepository(userId, { name: "interested", starredAt: new Date(Date.now() - 60 * day) }),
    addRepository(userId, { name: "snooze", starredAt: new Date(Date.now() - 60 * day) }),
    addRepository(userId, { name: "done", starredAt: new Date(Date.now() - 60 * day) }),
    addRepository(userId, { name: "forget", starredAt: new Date(Date.now() - 60 * day) }),
  ]);
  const actions = [
    [repositoryIds[0], "still_interested", 90, "active"],
    [repositoryIds[1], "snooze", 30, "active"],
    [repositoryIds[2], "done", null, "done"],
    [repositoryIds[3], "forget", null, "forgotten"],
  ] as const;

  for (const [repositoryId, action, days, status] of actions) {
    const response = await application.request("/api/rotation/feedback", {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      body: JSON.stringify({ repositoryId, action }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ action, status });
    if (days) {
      const state = await database<{ status: string; next_eligible_at: Date }[]>`
        select status, next_eligible_at from rotation_states
        where user_id = ${userId} and repository_id = ${repositoryId}
      `;
      expect(state[0]!.next_eligible_at.getTime()).toBeGreaterThan(Date.now() + (days - 1) * day);
      expect(state[0]!.next_eligible_at.getTime()).toBeLessThan(Date.now() + (days + 1) * day);
    }
  }

  const snoozeStateBeforeRepeat = await database<{ next_eligible_at: Date }[]>`
    select next_eligible_at from rotation_states
    where user_id = ${userId} and repository_id = ${repositoryIds[1]}
  `;
  const repeatedSnooze = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repositoryIds[1], action: "snooze" }),
  });
  expect(repeatedSnooze.status).toBe(200);
  const snoozeStateAfterRepeat = await database<{ next_eligible_at: Date }[]>`
    select next_eligible_at from rotation_states
    where user_id = ${userId} and repository_id = ${repositoryIds[1]}
  `;
  expect(snoozeStateAfterRepeat[0]!.next_eligible_at).toEqual(snoozeStateBeforeRepeat[0]!.next_eligible_at);

  const interestedStateBeforeRepeat = await database<{ next_eligible_at: Date }[]>`
    select next_eligible_at from rotation_states
    where user_id = ${userId} and repository_id = ${repositoryIds[0]}
  `;
  const repeatedInterest = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repositoryIds[0], action: "still_interested" }),
  });
  expect(repeatedInterest.status).toBe(200);
  const interestedStateAfterRepeat = await database<{ next_eligible_at: Date }[]>`
    select next_eligible_at from rotation_states
    where user_id = ${userId} and repository_id = ${repositoryIds[0]}
  `;
  expect(interestedStateAfterRepeat[0]!.next_eligible_at).toEqual(interestedStateBeforeRepeat[0]!.next_eligible_at);

  const repeatedForget = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repositoryIds[3], action: "forget" }),
  });
  expect(repeatedForget.status).toBe(200);

  const contradictory = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repositoryIds[2], action: "forget" }),
  });
  expect(contradictory.status).toBe(409);

  const repeated = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: repositoryIds[2], action: "done" }),
  });
  expect(repeated.status).toBe(200);

  const events = await database<{ repository_id: number; action: string; resulting_status: string }[]>`
    select repository_id, action, resulting_status from rotation_feedback_events
    where user_id = ${userId}
    order by id
  `;
  expect(events).toEqual([
    { repository_id: repositoryIds[0], action: "still_interested", resulting_status: "active" },
    { repository_id: repositoryIds[1], action: "snooze", resulting_status: "active" },
    { repository_id: repositoryIds[2], action: "done", resulting_status: "done" },
    { repository_id: repositoryIds[3], action: "forget", resulting_status: "forgotten" },
    { repository_id: repositoryIds[1], action: "snooze", resulting_status: "active" },
    { repository_id: repositoryIds[0], action: "still_interested", resulting_status: "active" },
    { repository_id: repositoryIds[3], action: "forget", resulting_status: "forgotten" },
    { repository_id: repositoryIds[2], action: "done", resulting_status: "done" },
  ]);

  const active = await application.request("/api/rotation", { headers: { cookie: sessionCookie } });
  await expect(active.json()).resolves.toEqual({ repositories: [] });
});

it("includes a repository starred exactly 30 days ago and excludes one just inside the boundary", async () => {
  const userId = await resetDatabase();
  const boundary = await addRepository(userId, { name: "boundary", starredAt: new Date(Date.now() - 30 * day - 2_000) });
  await addRepository(userId, { name: "fresh", starredAt: new Date(Date.now() - 30 * day + 2_000) });

  const response = await application.request("/api/rotation", { headers: { cookie: sessionCookie } });

  await expect(response.json()).resolves.toMatchObject({ repositories: [{ repositoryId: boundary, name: "boundary" }] });
});
