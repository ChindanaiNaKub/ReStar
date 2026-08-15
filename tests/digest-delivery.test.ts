import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { encryptAccessToken } from "../src/auth/crypto";
import { createJobHandlers } from "../src/jobs/handlers";
import { runWorkerCycle } from "../src/jobs/run-worker-cycle";
import { startTestApplication } from "./support/test-application";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const now = new Date("2026-08-17T09:00:00.000Z");

type SentEmail = { from: string; to: string; subject: string; text: string; html: string; idempotencyKey: string };

async function startFakeGitHub() {
  const server = createServer((request, response) => {
    if (request.url === "/user/starred?per_page=100&page=1") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{
        starred_at: "2020-01-01T00:00:00Z",
        repo: {
          id: 9001,
          name: "memory",
          full_name: "reStar/memory",
          private: false,
          html_url: "https://github.com/reStar/memory",
          description: "A repository worth revisiting",
          language: "TypeScript",
          stargazers_count: 321,
          owner: { login: "reStar" },
        },
      }]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

let application: Awaited<ReturnType<typeof startTestApplication>>;
let database: ReturnType<typeof postgres>;
let github: Awaited<ReturnType<typeof startFakeGitHub>>;

beforeAll(async () => {
  application = await startTestApplication();
  database = postgres(application.databaseUrl);
  github = await startFakeGitHub();
});

afterAll(async () => {
  await database?.end();
  await github?.stop();
  await application?.stop();
});

async function seedUser(githubUserId: string) {
  const users = await database<{ id: number }[]>`
    insert into users (github_user_id, github_login, email)
    values (${githubUserId}, ${githubUserId}, ${`${githubUserId}@example.test`})
    returning id
  `;
  const userId = users[0]!.id;
  await database`
    insert into digest_preferences (user_id, day_of_week, hour, minute, timezone, item_count, paused)
    values (${userId}, 1, 9, 0, 'UTC', 4, false)
  `;
  await database`
    insert into github_credentials (user_id, encrypted_access_token)
    values (${userId}, ${encryptAccessToken("github-token", encryptionKey)})
  `;
  return userId;
}

function handlers(emails: SentEmail[], failFirst = false) {
  let calls = 0;
  return createJobHandlers({
    databaseUrl: application.databaseUrl,
    githubApiBaseUrl: github.baseUrl,
    tokenEncryptionKey: encryptionKey,
    emailProvider: {
      async send(message) {
        calls += 1;
        if (failFirst && calls === 1) {
          const error = new Error("temporary email outage") as Error & { retryable: boolean };
          error.retryable = true;
          throw error;
        }
        emails.push(message);
        return { id: `fake-${calls}` };
      },
    },
  });
}

it("claims one due User, reconciles before selecting, and delivers one fixed Digest", async () => {
  const userId = await seedUser("digest-one");
  const emails: SentEmail[] = [];
  const jobHandlers = handlers(emails);

  const [first, second] = await Promise.all([
    runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers }),
    runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers }),
  ]);
  expect(first.claimed + second.claimed).toBe(1);

  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });

  const digests = await database<{ id: number; status: string; period_key: string }[]>`
    select id, status, period_key from digests where user_id = ${userId}
  `;
  const items = await database<{ full_name: string; description: string | null; html_url: string }[]>`
    select full_name, description, html_url from digest_items where digest_id = ${digests[0]!.id}
  `;
  expect(digests).toEqual([{ id: digests[0]!.id, status: "sent", period_key: now.toISOString() }]);
  expect(items).toEqual([{
    full_name: "reStar/memory",
    description: "A repository worth revisiting",
    html_url: "https://github.com/reStar/memory",
  }]);
  expect(emails).toHaveLength(1);
  expect(emails[0]!.idempotencyKey).toBe(`digest:${digests[0]!.id}`);
  expect(emails[0]!.html).toContain("https://github.com/reStar/memory");
  expect(emails[0]!.text).toContain("A repository worth revisiting");
  expect(emails[0]!.html).toContain("Still Interested");
  expect(emails[0]!.html).toContain("Snooze");
  expect(emails[0]!.html).toContain("Done");
  expect(emails[0]!.html).toContain("Forget");
  expect(emails[0]!.html).not.toContain("github-token");
  expect(emails[0]!.html).not.toContain("digest-one@example.test");

  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  expect(emails).toHaveLength(1);
});

it("keeps selected Digest Items fixed while delivery retries with visible state", async () => {
  const userId = await seedUser("digest-retry");
  const emails: SentEmail[] = [];
  const jobHandlers = handlers(emails, true);

  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  const failedDelivery = await runWorkerCycle({ databaseUrl: application.databaseUrl, now, handlers: jobHandlers });
  expect(failedDelivery).toEqual({ claimed: 1, completed: 0, failed: 0, retrying: 1 });

  const beforeRetry = await database<{ status: string; last_error: string | null }[]>`
    select digests.status, digests.last_error from digests where user_id = ${userId}
  `;
  expect(beforeRetry).toEqual([{ status: "failed", last_error: "temporary email outage" }]);

  const retry = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    now: new Date(now.getTime() + 60_000),
    handlers: jobHandlers,
  });
  expect(retry).toEqual({ claimed: 1, completed: 1, failed: 0, retrying: 0 });
  expect(emails).toHaveLength(1);

  const afterRetry = await database<{ status: string; item_count: number }[]>`
    select status, (select count(*) from digest_items where digest_id = digests.id)::int as item_count
    from digests where user_id = ${userId}
  `;
  expect(afterRetry).toEqual([{ status: "sent", item_count: 1 }]);
});
