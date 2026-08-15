import postgres from "postgres";

import { decryptAccessToken } from "@/auth/crypto";
import { logEvent } from "@/observability/log";
import type { JobContext } from "./run-worker-cycle";

type ImportPayload = { importId: number; userId: number };

type StarredRepositoryResponse = {
  starred_at: string;
  repo: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    owner: { login: string };
  };
};

class GitHubImportFailure extends Error {
  constructor(
    message: string,
    readonly kind: "revoked" | "rate_limit" | "other",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function nextPageUrl(link: string | null, apiOrigin: string) {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] !== "next") continue;
    const next = new URL(match[1]!);
    if (next.origin !== apiOrigin) throw new GitHubImportFailure("GitHub returned an unsafe pagination link", "other", false);
    return next;
  }
  return null;
}

async function fetchStarredPage(url: URL, accessToken: string, apiOrigin: string) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github.star+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubImportFailure("GitHub access was revoked; sign in again", "revoked", false);
    }
    if (response.status === 429 || response.status === 403) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      throw new GitHubImportFailure(
        "GitHub rate limit reached; import will retry",
        "rate_limit",
        true,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
      );
    }
    throw new GitHubImportFailure(
      `GitHub Stars request failed (${response.status})`,
      "other",
      response.status >= 500,
    );
  }
  const body = (await response.json()) as StarredRepositoryResponse[];
  if (!Array.isArray(body)) throw new GitHubImportFailure("GitHub returned an invalid Stars page", "other", false);
  return { stars: body, next: nextPageUrl(response.headers.get("link"), apiOrigin) };
}

function importPayload(payload: unknown): ImportPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid GitHub Stars import payload");
  }
  const importId = Number((payload as { importId?: unknown }).importId);
  const userId = Number((payload as { userId?: unknown }).userId);
  if (!Number.isSafeInteger(importId) || !Number.isSafeInteger(userId)) {
    throw new Error("Invalid GitHub Stars import payload");
  }
  return { importId, userId };
}

type CreateJobHandlersOptions = {
  databaseUrl: string;
  githubApiBaseUrl?: string;
  tokenEncryptionKey?: string;
};

export function createJobHandlers(options: CreateJobHandlersOptions) {
  return {
    "github-stars-import": async (rawPayload: unknown, context: JobContext) => {
      const payload = importPayload(rawPayload);
      const client = postgres(options.databaseUrl, { max: 1 });
      try {
        logEvent("github_import.started", {
          importId: payload.importId,
          userId: payload.userId,
          attempt: context.attempt,
        });
        const credentials = await client<{ encrypted_access_token: string }[]>`
          select encrypted_access_token from github_credentials where user_id = ${payload.userId}
        `;
        const encryptedToken = credentials[0]?.encrypted_access_token;
        if (!encryptedToken) throw new GitHubImportFailure("GitHub access was revoked; sign in again", "revoked", false);
        const accessToken = decryptAccessToken(encryptedToken, options.tokenEncryptionKey);
        const apiBase = new URL(options.githubApiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com");
        let pageUrl: URL | null = new URL("/user/starred?per_page=100&page=1", apiBase);

        await client`
          update imports set status = 'running', error = null,
            pages_completed = 0, imported_repositories = 0, updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
        `;

        while (pageUrl) {
          const page = await fetchStarredPage(pageUrl, accessToken, apiBase.origin);
          const publicStars = page.stars.filter((star) => star.repo.private === false);
          await client.begin(async (transaction) => {
            for (const star of publicStars) {
              const starredAt = new Date(star.starred_at);
              if (Number.isNaN(starredAt.getTime())) {
                throw new GitHubImportFailure("GitHub returned an invalid star timestamp", "other", false);
              }
              const repositories = await transaction<{ id: number }[]>`
                insert into repositories (
                  github_repository_id, owner_login, name, full_name, description, language, star_count, html_url
                ) values (
                  ${String(star.repo.id)}, ${star.repo.owner.login}, ${star.repo.name}, ${star.repo.full_name},
                  ${star.repo.description}, ${star.repo.language}, ${star.repo.stargazers_count}, ${star.repo.html_url}
                )
                on conflict (github_repository_id) do update set
                  owner_login = excluded.owner_login,
                  name = excluded.name,
                  full_name = excluded.full_name,
                  description = excluded.description,
                  language = excluded.language,
                  star_count = excluded.star_count,
                  html_url = excluded.html_url,
                  updated_at = now()
                returning id
              `;
              await transaction`
                insert into starred_repositories (user_id, repository_id, starred_at)
                values (${payload.userId}, ${repositories[0]!.id}, ${starredAt})
                on conflict (user_id, repository_id) do update set
                  starred_at = excluded.starred_at,
                  updated_at = now()
              `;
            }
            await transaction`
              update imports set
                pages_completed = pages_completed + 1,
                imported_repositories = imported_repositories + ${publicStars.length},
                updated_at = now()
              where id = ${payload.importId} and user_id = ${payload.userId}
            `;
          });
          logEvent("github_import.page_completed", {
            importId: payload.importId,
            pageRepositories: publicStars.length,
          });
          pageUrl = page.next;
        }

        await client`
          update imports set status = 'completed', error = null, completed_at = now(), updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
        `;
        logEvent("github_import.completed", { importId: payload.importId, userId: payload.userId });
      } catch (error) {
        const failure = error instanceof GitHubImportFailure
          ? error
          : new GitHubImportFailure(error instanceof Error ? error.message : "Import failed", "other", true);
        const willRetry = failure.retryable && context.attempt < context.maxAttempts;
        const finalStatus = failure.kind === "revoked"
          ? "failed_revoked"
          : failure.kind === "rate_limit"
            ? "failed_rate_limit"
            : "failed";
        await client`
          update imports set status = ${willRetry ? "retrying" : finalStatus}, error = ${failure.message}, updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
        `;
        logEvent("github_import.failed", {
          importId: payload.importId,
          userId: payload.userId,
          failureKind: failure.kind,
          retrying: willRetry,
        });
        throw failure;
      } finally {
        await client.end();
      }
    },
  };
}
