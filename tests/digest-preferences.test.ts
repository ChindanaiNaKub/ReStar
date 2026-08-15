import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { getNextDigestDelivery } from "../src/digest/schedule";
import { hashToken, randomToken } from "../src/auth/crypto";
import { startTestApplication } from "./support/test-application";

const day = 24 * 60 * 60 * 1000;

let application: Awaited<ReturnType<typeof startTestApplication>>;
let database: ReturnType<typeof postgres>;
let sessionCookie: string;

beforeAll(async () => {
  application = await startTestApplication();
  database = postgres(application.databaseUrl);
  const user = await database<{ id: number }[]>`
    insert into users (github_user_id, github_login)
    values ('digest-user', 'digest-user')
    returning id
  `;
  const sessionToken = randomToken();
  await database`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(sessionToken)}, ${user[0]!.id}, ${new Date(Date.now() + day)})
  `;
  sessionCookie = `restar_session=${sessionToken}`;
});

afterAll(async () => {
  await database?.end();
  await application?.stop();
});

it("defaults a new User to four Monday Digest Items at 09:00 in the detected timezone", async () => {
  const response = await application.request("/api/digest/preferences", {
    headers: { cookie: sessionCookie, "x-time-zone": "America/New_York" },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    dayOfWeek: 1,
    hour: 9,
    minute: 0,
    timezone: "America/New_York",
    itemCount: 4,
    paused: false,
  });
});

it("updates Digest preferences and can pause and resume scheduled Digests", async () => {
  const updated = await application.request("/api/digest/preferences", {
    method: "PUT",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ dayOfWeek: 5, hour: 14, minute: 30, timezone: "Asia/Bangkok", itemCount: 5, paused: true }),
  });

  expect(updated.status).toBe(200);
  await expect(updated.json()).resolves.toMatchObject({
    dayOfWeek: 5,
    hour: 14,
    minute: 30,
    timezone: "Asia/Bangkok",
    itemCount: 5,
    paused: true,
    nextDeliveryAt: null,
  });

  const resumed = await application.request("/api/digest/preferences", {
    method: "PUT",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ dayOfWeek: 5, hour: 14, minute: 30, timezone: "Asia/Bangkok", itemCount: 5, paused: false }),
  });
  expect(resumed.status).toBe(200);
  await expect(resumed.json()).resolves.toMatchObject({ paused: false, nextDeliveryAt: expect.any(String) });
});

it("rejects invalid timezone and item-count input without changing stored settings", async () => {
  const before = await application.request("/api/digest/preferences", { headers: { cookie: sessionCookie } });
  const beforeBody = await before.json();

  const invalid = await application.request("/api/digest/preferences", {
    method: "PUT",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ ...beforeBody, timezone: "Not/A_Timezone", itemCount: 6 }),
  });

  expect(invalid.status).toBe(400);
  const after = await application.request("/api/digest/preferences", { headers: { cookie: sessionCookie } });
  await expect(after.json()).resolves.toEqual(beforeBody);
});

it("calculates the next local Monday correctly across UTC offsets and daylight-saving time", () => {
  expect(getNextDigestDelivery({ dayOfWeek: 1, hour: 9, minute: 0, timezone: "America/New_York", paused: false }, new Date("2024-03-09T15:00:00Z")))
    .toEqual(new Date("2024-03-11T13:00:00Z"));
  expect(getNextDigestDelivery({ dayOfWeek: 1, hour: 9, minute: 0, timezone: "America/New_York", paused: false }, new Date("2024-03-10T15:00:00Z")))
    .toEqual(new Date("2024-03-11T13:00:00Z"));
  expect(getNextDigestDelivery({ dayOfWeek: 1, hour: 9, minute: 0, timezone: "America/New_York", paused: false }, new Date("2024-11-02T15:00:00Z")))
    .toEqual(new Date("2024-11-04T14:00:00Z"));
  expect(getNextDigestDelivery({ dayOfWeek: 1, hour: 9, minute: 0, timezone: "Asia/Bangkok", paused: false }, new Date("2024-03-10T15:00:00Z")))
    .toEqual(new Date("2024-03-11T02:00:00Z"));
});
