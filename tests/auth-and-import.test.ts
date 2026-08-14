import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";

import { startTestApplication } from "./support/test-application";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

type FakeGitHubOptions = {
  stars?: Array<Array<Record<string, unknown>>>;
  starsFailure?: { status: number; headers?: Record<string, string> };
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
      response.end(JSON.stringify({ id: 42, login: "octocat", avatar_url: "https://avatars.example/octocat" }));
      return;
    }

    if (request.url?.startsWith("/user/starred")) {
      if (options.starsFailure) {
        response.statusCode = options.starsFailure.status;
        for (const [name, value] of Object.entries(options.starsFailure.headers ?? {})) response.setHeader(name, value);
        response.end(JSON.stringify({ message: "GitHub failure" }));
        return;
      }
      const url = new URL(request.url, "http://github.test");
      const page = Number(url.searchParams.get("page") ?? "1");
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

const applications: RunningApplication[] = [];
const githubServers: RunningGitHub[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
  await Promise.all(githubServers.splice(0).map((github) => github.stop()));
});

async function startAuthenticatedApplication(options: FakeGitHubOptions = {}) {
  const github = await startFakeGitHub(options);
  githubServers.push(github);
  const application = await startTestApplication({
    environment: {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_OAUTH_BASE_URL: github.baseUrl,
      GITHUB_API_BASE_URL: github.baseUrl,
      GITHUB_TOKEN_ENCRYPTION_KEY: encryptionKey,
    },
  });
  applications.push(application);

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

  return { application, authorizationUrl, callback, github, sessionCookie };
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
    starsFailure: { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } },
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
});
