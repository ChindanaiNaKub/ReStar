import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { startTestApplication } from "./support/test-application";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

type FakeGitHubOptions = {
  githubUserId?: number;
  stars?: Array<Array<Record<string, unknown>>>;
  starsFailure?: { status: number; page?: number; headers?: Record<string, string> };
};

async function startFakeGitHub(options: FakeGitHubOptions = {}) {
  const requests: Array<{ authorization: string | undefined; method: string; url: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      authorization: request.headers.authorization,
      method: request.method ?? "GET",
      url: request.url ?? "/",
      body,
    });

    if (request.url === "/login/oauth/access_token") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "github-access-token", token_type: "bearer", scope: "user:email" }));
      return;
    }

    if (request.url === "/user") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: options.githubUserId ?? 42,
        login: `octocat-${options.githubUserId ?? 42}`,
        avatar_url: "https://avatars.example/octocat",
      }));
      return;
    }

    if (request.url?.startsWith("/user/starred")) {
      const url = new URL(request.url, "http://github.test");
      const page = Number(url.searchParams.get("page") ?? "1");
      if (options.starsFailure && (options.starsFailure.page ?? 1) === page) {
        response.statusCode = options.starsFailure.status;
        for (const [name, value] of Object.entries(options.starsFailure.headers ?? {})) response.setHeader(name, value);
        response.end(JSON.stringify({ message: "GitHub failure" }));
        return;
      }
      const stars = options.stars?.[page - 1] ?? [];
      response.setHeader("content-type", "application/json");
      if (options.stars && page < options.stars.length) {
        const address = server.address() as AddressInfo;
        response.setHeader("link", `<http://127.0.0.1:${address.port}/user/starred?per_page=100&page=${page + 1}>; rel="next"`);
      }
      response.end(JSON.stringify(stars));
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
    requests,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

type RunningApplication = Awaited<ReturnType<typeof startTestApplication>>;
type RunningGitHub = Awaited<ReturnType<typeof startFakeGitHub>>;

const sharedGitHubOptions: FakeGitHubOptions = {};
let sharedApplication: RunningApplication;
let sharedGitHub: RunningGitHub;
let nextGitHubUserId = 100;

beforeAll(async () => {
  sharedGitHub = await startFakeGitHub(sharedGitHubOptions);
  sharedApplication = await startTestApplication({
    environment: {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_OAUTH_BASE_URL: sharedGitHub.baseUrl,
      GITHUB_API_BASE_URL: sharedGitHub.baseUrl,
      GITHUB_TOKEN_ENCRYPTION_KEY: encryptionKey,
    },
  });
});

afterAll(async () => {
  await sharedApplication?.stop();
  await sharedGitHub?.stop();
});

async function startAuthenticatedApplication(options: FakeGitHubOptions = {}) {
  for (const key of Object.keys(sharedGitHubOptions) as Array<keyof FakeGitHubOptions>) {
    delete sharedGitHubOptions[key];
  }
  Object.assign(sharedGitHubOptions, options, { githubUserId: nextGitHubUserId++ });
  sharedGitHub.requests.length = 0;
  const cleanup = postgres(sharedApplication.databaseUrl);
  await cleanup`delete from jobs where status in ('pending', 'running')`;
  await cleanup.end();
  const authentication = await authenticate(sharedApplication);

  return { application: sharedApplication, github: sharedGitHub, ...authentication };
}

async function authenticate(application: RunningApplication) {
  const start = await application.request("/api/auth/github/start", { redirect: "manual" });
  const authorizationUrl = new URL(start.headers.get("location") ?? "");
  const oauthCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
  const state = authorizationUrl.searchParams.get("state");
  if (!oauthCookie || !state) throw new Error("OAuth start did not create browser state");

  const callback = await application.request(`/api/auth/github/callback?code=fake-code&state=${state}`, {
    headers: { cookie: oauthCookie },
    redirect: "manual",
  });
  const sessionCookie = callback.headers.get("set-cookie")?.match(/restar_session=[^;]+/)?.[0];
  if (!sessionCookie) throw new Error("OAuth callback did not create a session");

  return { authorizationUrl, callback, sessionCookie };
}

async function runGitHubJob(application: RunningApplication, github: RunningGitHub) {
  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  return runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
}

it("signs in with state and PKCE, revalidates identity, and queues initial import", async () => {
  const { application, authorizationUrl, callback, github, sessionCookie } = await startAuthenticatedApplication();

  expect(authorizationUrl.origin).toBe(github.baseUrl);
  expect(authorizationUrl.pathname).toBe("/login/oauth/authorize");
  expect(authorizationUrl.searchParams.get("client_id")).toBe("client-id");
  expect(authorizationUrl.searchParams.get("scope")).toBe("user:email");
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callback.status).toBe(307);
  expect(new URL(callback.headers.get("location") ?? "").pathname).toBe("/import");

  const tokenRequest = github.requests.find((request) => request.url === "/login/oauth/access_token");
  expect(new URLSearchParams(tokenRequest?.body).get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(github.requests.find((request) => request.url === "/user")?.authorization).toBe("Bearer github-access-token");

  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toEqual({
    attempts: 0,
    error: null,
    importedRepositories: 0,
    pagesCompleted: 0,
    status: "pending",
  });

  const progressPage = await application.request("/import", { headers: { cookie: sessionCookie } });
  expect(progressPage.status).toBe(200);
  expect(await progressPage.text()).toContain("Import pending");
});

it("imports multiple pages of public Starred Repositories in the background", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    stars: [
      [
        {
          starred_at: "2020-01-02T03:04:05Z",
          repo: {
            id: 1001,
            name: "alpha",
            full_name: "acme/alpha",
            private: false,
            html_url: "https://github.com/acme/alpha",
            description: "First repository",
            language: "TypeScript",
            stargazers_count: 123,
            owner: { login: "acme" },
          },
        },
      ],
      [
        {
          starred_at: "2021-06-07T08:09:10Z",
          repo: {
            id: 1002,
            name: "beta",
            full_name: "octo/beta",
            private: false,
            html_url: "https://github.com/octo/beta",
            description: null,
            language: null,
            stargazers_count: 456,
            owner: { login: "octo" },
          },
        },
      ],
    ],
  });

  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  const statusBody = await status.json();
  expect({ result, statusBody }).toEqual({
    result: { claimed: 1, completed: 1, failed: 0, retrying: 0 },
    statusBody: {
    attempts: 1,
    error: null,
    importedRepositories: 2,
    pagesCompleted: 2,
    status: "completed",
    },
  });

  const repositories = await application.request("/api/starred-repositories", {
    headers: { cookie: sessionCookie },
  });
  expect(repositories.status).toBe(200);
  await expect(repositories.json()).resolves.toEqual({
    repositories: [
      {
        description: "First repository",
        fullName: "acme/alpha",
        htmlUrl: "https://github.com/acme/alpha",
        language: "TypeScript",
        ownerLogin: "acme",
        starCount: 123,
        starredAt: "2020-01-02T03:04:05.000Z",
      },
      {
        description: null,
        fullName: "octo/beta",
        htmlUrl: "https://github.com/octo/beta",
        language: null,
        ownerLogin: "octo",
        starCount: 456,
        starredAt: "2021-06-07T08:09:10.000Z",
      },
    ],
  });

  const starRequests = github.requests.filter((request) => request.url.startsWith("/user/starred"));
  expect(starRequests).toHaveLength(2);
  expect(starRequests.every((request) => request.authorization === "Bearer github-access-token")).toBe(true);
});

it("shows rate-limit retry state without blocking the request", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    starsFailure: { status: 403, headers: { "retry-after": "60" } },
  });
  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
  expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retrying: 1 });

  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  await expect(status.json()).resolves.toMatchObject({
    attempts: 1,
    error: "GitHub rate limit reached; import will retry",
    status: "retrying",
  });
});

it("does not mislabel a permanent GitHub forbidden response as a rate limit", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    starsFailure: { status: 403 },
  });
  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
  expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retrying: 0 });

  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  await expect(status.json()).resolves.toMatchObject({
    error: "GitHub Stars request failed (403)",
    status: "failed",
  });
});

it("shows revoked GitHub access as a terminal import failure", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    starsFailure: { status: 401 },
  });
  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
  expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retrying: 0 });

  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  await expect(status.json()).resolves.toMatchObject({
    error: "GitHub access was revoked; sign in again",
    status: "failed_revoked",
  });

  const renewed = await authenticate(application);
  const restarted = await application.request("/api/import/status", {
    headers: { cookie: renewed.sessionCookie },
  });
  await expect(restarted.json()).resolves.toMatchObject({
    attempts: 0,
    error: null,
    status: "pending",
  });
});

it("keeps completed-page progress visible when a later GitHub page needs retrying", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    stars: [
      [{
        starred_at: "2020-01-02T03:04:05Z",
        repo: {
          id: 1001, name: "alpha", full_name: "acme/alpha", private: false,
          html_url: "https://github.com/acme/alpha", description: null, language: null,
          stargazers_count: 123, owner: { login: "acme" },
        },
      }],
      [],
    ],
    starsFailure: { status: 503, page: 2 },
  });
  const { createJobHandlers } = await import("../src/jobs/handlers");
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl: application.databaseUrl,
    handlers: createJobHandlers({
      databaseUrl: application.databaseUrl,
      githubApiBaseUrl: github.baseUrl,
      tokenEncryptionKey: encryptionKey,
    }),
    now: new Date(),
  });
  expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retrying: 1 });

  const status = await application.request("/api/import/status", { headers: { cookie: sessionCookie } });
  await expect(status.json()).resolves.toMatchObject({
    importedRepositories: 1,
    pagesCompleted: 1,
    status: "retrying",
  });
});

it("reconciles complete pages, preserves partial runs, and reactivates a repository after it leaves Rotation", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    stars: [[
      {
        starred_at: "2020-01-02T03:04:05Z",
        repo: {
          id: 2001, name: "alpha", full_name: "acme/alpha", private: false,
          html_url: "https://github.com/acme/alpha", description: "Alpha", language: "TypeScript",
          stargazers_count: 10, owner: { login: "acme" },
        },
      },
      {
        starred_at: "2020-02-02T03:04:05Z",
        repo: {
          id: 2002, name: "beta", full_name: "acme/beta", private: false,
          html_url: "https://github.com/acme/beta", description: "Beta", language: "Rust",
          stargazers_count: 20, owner: { login: "acme" },
        },
      },
      {
        starred_at: "2020-03-02T03:04:05Z",
        repo: {
          id: 2003, name: "gamma", full_name: "acme/gamma", private: false,
          html_url: "https://github.com/acme/gamma", description: "Gamma", language: "Go",
          stargazers_count: 30, owner: { login: "acme" },
        },
      },
    ]],
  });

  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ completed: 1 });
  const rotation = await application.request("/api/rotation", { headers: { cookie: sessionCookie } });
  const rotationBody = await rotation.json() as { repositories: Array<{ repositoryId: number; name: string }> };
  const alpha = rotationBody.repositories.find((repository) => repository.name === "alpha");
  const beta = rotationBody.repositories.find((repository) => repository.name === "beta");
  if (!alpha || !beta) throw new Error("Expected alpha and beta in initial Rotation");
  const feedback = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: alpha.repositoryId, action: "done" }),
  });
  expect(feedback.status).toBe(200);
  const betaFeedback = await application.request("/api/rotation/feedback", {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: beta.repositoryId, action: "done" }),
  });
  expect(betaFeedback.status).toBe(200);

  github.requests.length = 0;
  Object.assign(sharedGitHubOptions, {
    stars: [[{
      starred_at: "2020-02-02T03:04:05Z",
      repo: {
        id: 2002, name: "beta", full_name: "acme/beta", private: false,
        html_url: "https://github.com/acme/beta", description: "Beta", language: "Rust",
        stargazers_count: 20, owner: { login: "acme" },
      },
    }, {
      starred_at: "2020-03-02T03:04:05Z",
      repo: {
        id: 2003, name: "gamma", full_name: "acme/gamma", private: false,
        html_url: "https://github.com/acme/gamma", description: "Gamma", language: "Go",
        stargazers_count: 30, owner: { login: "acme" },
      },
    }]],
  });
  const firstSync = await application.request("/api/sync", {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  expect(firstSync.status).toBe(202);
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ completed: 1 });

  const partialStars = await application.request("/api/starred-repositories", { headers: { cookie: sessionCookie } });
  await expect(partialStars.json()).resolves.toMatchObject({
    repositories: expect.arrayContaining([
      expect.objectContaining({ fullName: "acme/beta" }),
      expect.objectContaining({ fullName: "acme/gamma" }),
    ]),
  });
  const history = postgres(application.databaseUrl);
  const eventsAfterRemoval = await history<{ action: string; resulting_status: string }[]>`
    select action, resulting_status from rotation_feedback_events
    where repository_id = ${alpha.repositoryId} order by id
  `;
  expect(eventsAfterRemoval).toEqual([{ action: "done", resulting_status: "done" }]);
  const betaState = await history<{ status: string }[]>`
    select status from rotation_states where repository_id = ${beta.repositoryId}
  `;
  expect(betaState).toEqual([{ status: "done" }]);

  await history`update imports set created_at = created_at - interval '1 hour' where sync_type = 'manual'`;
  Object.assign(sharedGitHubOptions, {
    stars: [[{
      starred_at: "2020-01-02T03:04:05Z",
      repo: {
        id: 2001, name: "alpha", full_name: "acme/alpha", private: false,
        html_url: "https://github.com/acme/alpha", description: "Alpha", language: "TypeScript",
        stargazers_count: 11, owner: { login: "acme" },
      },
    }, {
      starred_at: "2020-03-02T03:04:05Z",
      repo: {
        id: 2003, name: "gamma", full_name: "acme/gamma", private: false,
        html_url: "https://github.com/acme/gamma", description: "Gamma", language: "Go",
        stargazers_count: 30, owner: { login: "acme" },
      },
    }]],
  });
  const secondSync = await application.request("/api/sync", {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  expect(secondSync.status).toBe(202);
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ completed: 1 });

  const reactivated = await application.request("/api/rotation", { headers: { cookie: sessionCookie } });
  await expect(reactivated.json()).resolves.toMatchObject({
    repositories: expect.arrayContaining([expect.objectContaining({ name: "alpha" })]),
  });
  const state = await history<{ status: string }[]>`
    select status from rotation_states where repository_id = ${alpha.repositoryId}
  `;
  expect(state).toEqual([{ status: "active" }]);
  const historyAfterReactivation = await history<{ action: string; resulting_status: string }[]>`
    select action, resulting_status from rotation_feedback_events
    where repository_id = ${alpha.repositoryId} order by id
  `;
  expect(historyAfterReactivation).toEqual([{ action: "done", resulting_status: "done" }]);

  await history`update imports set created_at = created_at - interval '1 hour' where sync_type = 'manual'`;
  Object.assign(sharedGitHubOptions, {
    stars: [[{
      starred_at: "2020-01-02T03:04:05Z",
      repo: {
        id: 2001, name: "alpha", full_name: "acme/alpha", private: false,
        html_url: "https://github.com/acme/alpha", description: "Alpha", language: "TypeScript",
        stargazers_count: 11, owner: { login: "acme" },
      },
    }], []],
    starsFailure: { status: 503, page: 2 },
  });
  const failedSync = await application.request("/api/sync", {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  expect(failedSync.status).toBe(202);
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ retrying: 1 });
  const safeAfterFailure = await application.request("/api/starred-repositories", { headers: { cookie: sessionCookie } });
  await expect(safeAfterFailure.json()).resolves.toMatchObject({
    repositories: expect.arrayContaining([
      expect.objectContaining({ fullName: "acme/alpha" }),
      expect.objectContaining({ fullName: "acme/gamma" }),
    ]),
  });
  await history.end();
});

it("rate-limits Sync now and exposes revoked authorization", async () => {
  const { application, github, sessionCookie } = await startAuthenticatedApplication({
    stars: [[]],
  });
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ completed: 1 });
  const staleJob = postgres(application.databaseUrl);
  const latestJob = await staleJob<{ id: number }[]>`
    select id from jobs where kind = 'github-stars-import' order by id desc limit 1
  `;
  await staleJob`
    update jobs set status = 'running', locked_at = now() - interval '10 minutes', locked_by = 'stale-worker'
    where id = ${latestJob[0]!.id}
  `;
  github.requests.length = 0;
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ completed: 1 });
  expect(github.requests.some((request) => request.url.startsWith("/user/starred"))).toBe(false);
  await staleJob.end();
  const first = await application.request("/api/sync", {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  expect(first.status).toBe(202);
  const second = await application.request("/api/sync", {
    method: "POST",
    headers: { cookie: sessionCookie },
  });
  expect(second.status).toBe(429);
  await expect(second.json()).resolves.toMatchObject({ status: "rate_limited" });

  Object.assign(sharedGitHubOptions, { starsFailure: { status: 401 } });
  await expect(runGitHubJob(application, github)).resolves.toMatchObject({ failed: 1 });
  const status = await application.request("/api/sync", { headers: { cookie: sessionCookie } });
  await expect(status.json()).resolves.toMatchObject({
    status: "failed_revoked",
    error: "GitHub access was revoked; sign in again",
  });
});
