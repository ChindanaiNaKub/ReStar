import postgres from "postgres";

import { decryptAccessToken } from "@/auth/crypto";
import { fetchStarredPage, GitHubImportFailure } from "@/github/starred-repositories";
import { logEvent } from "@/observability/log";
import type { JobContext } from "./run-worker-cycle";

type ImportPayload = { importId: number; userId: number };

class JobLeaseLostFailure extends Error {}

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
        if (!(await context.heartbeat())) throw new JobLeaseLostFailure("GitHub import job lease was lost");
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
        let pagesCompleted = 0;
        let importedRepositories = 0;

        const started = await client<{ id: number }[]>`
          update imports set status = 'running', error = null,
            pages_completed = 0, imported_repositories = 0, updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
            and exists (
              select 1 from jobs
              where jobs.id = ${context.jobId} and jobs.status = 'running'
                and jobs.locked_by = ${context.leaseToken}
            )
          returning id
        `;
        if (started.length === 0) throw new JobLeaseLostFailure("GitHub import job lease was lost");

        while (pageUrl) {
          const page = await fetchStarredPage(pageUrl, accessToken, apiBase.origin);
          if (!(await context.heartbeat())) throw new JobLeaseLostFailure("GitHub import job lease was lost");
          const publicStars = page.stars.filter((star) => star.repo.private === false);
          pagesCompleted += 1;
          importedRepositories += publicStars.length;
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
            const progressed = await transaction<{ id: number }[]>`
              update imports set
                pages_completed = ${pagesCompleted},
                imported_repositories = ${importedRepositories},
                updated_at = now()
              where id = ${payload.importId} and user_id = ${payload.userId}
                and exists (
                  select 1 from jobs
                  where jobs.id = ${context.jobId} and jobs.status = 'running'
                    and jobs.locked_by = ${context.leaseToken}
                )
              returning id
            `;
            if (progressed.length === 0) throw new JobLeaseLostFailure("GitHub import job lease was lost");
          });
          logEvent("github_import.page_completed", {
            importId: payload.importId,
            pageRepositories: publicStars.length,
          });
          pageUrl = page.next;
        }

        if (!(await context.heartbeat())) throw new JobLeaseLostFailure("GitHub import job lease was lost");
        const completed = await client<{ id: number }[]>`
          update imports set status = 'completed', error = null, completed_at = now(), updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
            and exists (
              select 1 from jobs
              where jobs.id = ${context.jobId} and jobs.status = 'running'
                and jobs.locked_by = ${context.leaseToken}
            )
          returning id
        `;
        if (completed.length === 0) throw new JobLeaseLostFailure("GitHub import job lease was lost");
        logEvent("github_import.completed", { importId: payload.importId, userId: payload.userId });
      } catch (error) {
        if (error instanceof JobLeaseLostFailure || !(await context.heartbeat().catch(() => false))) {
          logEvent("github_import.lease_lost", { importId: payload.importId, userId: payload.userId });
          throw error;
        }
        const failure = error instanceof GitHubImportFailure
          ? error
          : new GitHubImportFailure(error instanceof Error ? error.message : "Import failed", "other", true);
        const willRetry = failure.retryable && context.attempt < context.maxAttempts;
        const finalStatus = failure.kind === "revoked"
          ? "failed_revoked"
          : failure.kind === "rate_limit"
            ? "failed_rate_limit"
            : "failed";
        const failed = await client<{ id: number }[]>`
          update imports set status = ${willRetry ? "retrying" : finalStatus}, error = ${failure.message}, updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
            and exists (
              select 1 from jobs
              where jobs.id = ${context.jobId} and jobs.status = 'running'
                and jobs.locked_by = ${context.leaseToken}
            )
          returning id
        `;
        if (failed.length === 0) {
          logEvent("github_import.lease_lost", { importId: payload.importId, userId: payload.userId });
          throw new JobLeaseLostFailure("GitHub import job lease was lost");
        }
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
