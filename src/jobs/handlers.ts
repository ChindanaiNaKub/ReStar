import postgres from "postgres";
import { randomUUID } from "node:crypto";

import { decryptAccessToken } from "@/auth/crypto";
import {
  claimDigestForDelivery,
  createDigest,
  markDigestFailed,
  markDigestSent,
  parseDigestDeliveryPayload,
  parseDigestPayload,
  parsePauseNoticePayload,
  renderDigestEmail,
  renderPauseNoticeEmail,
} from "@/digest/service";
import { applicationUrl } from "@/email/actions";
import { createEmailProvider, EmailDeliveryFailure, type EmailProvider } from "@/email/provider";
import { fetchStarredPage, GitHubImportFailure } from "@/github/starred-repositories";
import { logEvent } from "@/observability/log";
import type { JobContext } from "./run-worker-cycle";

type ImportPayload = { importId: number; userId: number; digestId?: number };

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
  const rawDigestId = (payload as { digestId?: unknown }).digestId;
  if (rawDigestId === undefined) return { importId, userId };
  const digestId = Number(rawDigestId);
  if (!Number.isSafeInteger(digestId)) throw new Error("Invalid GitHub Stars import payload");
  return { importId, userId, digestId };
}

type CreateJobHandlersOptions = {
  databaseUrl: string;
  githubApiBaseUrl?: string;
  tokenEncryptionKey?: string;
  emailActionTokenSecret?: string;
  emailActionBaseUrl?: string;
  emailProvider?: EmailProvider;
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
        const importState = await client<{ status: string }[]>`
          select status from imports where id = ${payload.importId} and user_id = ${payload.userId}
        `;
        if (importState[0]?.status === "completed") {
          logEvent("github_import.already_completed", { importId: payload.importId, userId: payload.userId });
          if (payload.digestId !== undefined) {
            await client`
              insert into jobs (kind, payload, idempotency_key, run_after)
              values ('digest-delivery', ${client.json({ digestId: payload.digestId, userId: payload.userId })}, ${`digest-delivery:${payload.digestId}`}, now())
              on conflict (idempotency_key) do nothing
            `;
          }
          return;
        }
        const credentials = await client<{ encrypted_access_token: string }[]>`
          select encrypted_access_token from github_credentials where user_id = ${payload.userId}
        `;
        const encryptedToken = credentials[0]?.encrypted_access_token;
        if (!encryptedToken) throw new GitHubImportFailure("GitHub access was revoked; sign in again", "revoked", false);
        const accessToken = decryptAccessToken(encryptedToken, options.tokenEncryptionKey);
        const apiBase = new URL(options.githubApiBaseUrl ?? process.env.GITHUB_API_BASE_URL ?? "https://api.github.com");
        const syncToken = randomUUID();
        let pageUrl: URL | null = new URL("/user/starred?per_page=100&page=1", apiBase);
        let pagesCompleted = 0;
        let importedRepositories = 0;

        const started = await client<{ id: number }[]>`
          update imports set status = 'running', sync_token = ${syncToken}, error = null,
            pages_completed = 0, imported_repositories = 0, updated_at = now()
          where id = ${payload.importId} and user_id = ${payload.userId}
            and status <> 'completed'
            and exists (
              select 1 from jobs
              where jobs.id = ${context.jobId} and jobs.status = 'running'
                and jobs.locked_by = ${context.leaseToken}
            )
          returning id
        `;
        if (started.length === 0) {
          const completed = await client<{ id: number }[]>`
            select id from imports
            where id = ${payload.importId} and user_id = ${payload.userId} and status = 'completed'
          `;
          if (completed.length > 0) {
            logEvent("github_import.already_completed", { importId: payload.importId, userId: payload.userId });
            if (payload.digestId !== undefined) {
              await client`
                insert into jobs (kind, payload, idempotency_key, run_after)
                values ('digest-delivery', ${client.json({ digestId: payload.digestId, userId: payload.userId })}, ${`digest-delivery:${payload.digestId}`}, now())
                on conflict (idempotency_key) do nothing
              `;
            }
            return;
          }
          throw new JobLeaseLostFailure("GitHub import job lease was lost");
        }

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
              const existingStarred = await transaction<{ repository_id: number }[]>`
                select repository_id from starred_repositories
                where user_id = ${payload.userId} and repository_id = ${repositories[0]!.id}
                for update
              `;
              await transaction`
                insert into starred_repositories (user_id, repository_id, starred_at, last_seen_sync_token)
                values (${payload.userId}, ${repositories[0]!.id}, ${starredAt}, ${syncToken})
                on conflict (user_id, repository_id) do update set
                  starred_at = excluded.starred_at,
                  last_seen_sync_token = excluded.last_seen_sync_token,
                  updated_at = now()
              `;
              if (existingStarred.length === 0) {
                await transaction`
                  insert into rotation_states (user_id, repository_id, status, next_eligible_at)
                  values (${payload.userId}, ${repositories[0]!.id}, 'active', ${new Date(0)})
                  on conflict (user_id, repository_id) do update set
                    status = 'active', updated_at = now()
                `;
              }
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
        const completed = await client.begin(async (transaction) => {
          const removed = await transaction<{ repository_id: number }[]>`
            delete from starred_repositories
            where user_id = ${payload.userId}
              and last_seen_sync_token is distinct from ${syncToken}
            returning repository_id
          `;
          const finished = await transaction<{ id: number }[]>`
            update imports set status = 'completed', error = null, completed_at = now(), updated_at = now()
            where id = ${payload.importId} and user_id = ${payload.userId}
              and sync_token = ${syncToken}
              and exists (
                select 1 from jobs
                where jobs.id = ${context.jobId} and jobs.status = 'running'
                  and jobs.locked_by = ${context.leaseToken}
              )
            returning id
          `;
          if (finished.length === 0) throw new JobLeaseLostFailure("GitHub import job lease was lost");
          return { finished, removed };
        });
        logEvent("github_import.completed", {
          importId: payload.importId,
          userId: payload.userId,
          repositoriesRemovedFromRotation: completed.removed.length,
        });
        if (payload.digestId !== undefined) {
          await client`
            insert into jobs (kind, payload, idempotency_key, run_after)
            values (
              'digest-delivery',
              ${client.json({ digestId: payload.digestId, userId: payload.userId })},
              ${`digest-delivery:${payload.digestId}`},
              now()
            )
            on conflict (idempotency_key) do nothing
          `;
        }
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
        if (payload.digestId !== undefined) {
          await markDigestFailed(client, payload.digestId, failure.message);
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
    "digest-prepare": async (rawPayload: unknown, context: JobContext) => {
      const payload = parseDigestPayload(rawPayload);
      const client = postgres(options.databaseUrl, { max: 1 });
      try {
        if (!(await context.heartbeat())) throw new JobLeaseLostFailure("Digest preparation job lease was lost");
        const digestId = await createDigest(client, payload);
        const existing = await client<{ status: string }[]>`
          select status from digests where id = ${digestId} and user_id = ${payload.userId}
        `;
        if (existing[0]?.status === "sent") return;

        const syncJob = await client<{ id: number }[]>`
          select id from jobs where idempotency_key = ${`digest-sync:${digestId}`}
        `;
        if (syncJob.length === 0) {
          const imports = await client<{ id: number }[]>`
            insert into imports (user_id, sync_type, status)
            values (${payload.userId}, 'weekly', 'pending')
            returning id
          `;
          await client`
            insert into jobs (kind, payload, idempotency_key, run_after)
            values (
              'github-stars-import',
              ${client.json({ importId: imports[0]!.id, userId: payload.userId, digestId })},
              ${`digest-sync:${digestId}`},
              now()
            )
            on conflict (idempotency_key) do nothing
          `;
        }
      } finally {
        await client.end();
      }
    },
    "digest-delivery": async (rawPayload: unknown, context: JobContext) => {
      const payload = parseDigestDeliveryPayload(rawPayload);
      const client = postgres(options.databaseUrl, { max: 1 });
      try {
        let digest;
        try {
          digest = await claimDigestForDelivery(client, payload.digestId, payload.userId, new Date(), {
            actionTokenSecret: options.emailActionTokenSecret ?? options.tokenEncryptionKey,
            actionBaseUrl: options.emailActionBaseUrl,
          });
        } catch (error) {
          await markDigestFailed(client, payload.digestId, error instanceof Error ? error.message : "Digest delivery failed");
          throw new EmailDeliveryFailure(error instanceof Error ? error.message : "Digest delivery failed", false);
        }
        if (!digest) return;
        if (!(await context.heartbeat())) throw new JobLeaseLostFailure("Digest delivery job lease was lost");

        try {
          const provider = options.emailProvider ?? createEmailProvider();
          const email = renderDigestEmail(digest);
          await provider.send({
            to: digest.email,
            from: process.env.EMAIL_FROM ?? "ReStar <no-reply@localhost>",
            subject: email.subject,
            html: email.html,
            text: email.text,
            idempotencyKey: `digest:${digest.digestId}`,
          });
          if (!(await context.heartbeat())) throw new JobLeaseLostFailure("Digest delivery job lease was lost");
          await markDigestSent(client, digest.digestId, new Date());
          logEvent("digest.delivered", {
            digestId: digest.digestId,
            userId: digest.userId,
            itemCount: digest.items.length,
          });
        } catch (error) {
          if (error instanceof JobLeaseLostFailure) throw error;
          const failure = error instanceof EmailDeliveryFailure
            ? error
            : new EmailDeliveryFailure(error instanceof Error ? error.message : "Email delivery failed", true);
          await markDigestFailed(client, digest.digestId, failure.message);
          throw failure;
        }
      } finally {
        await client.end();
      }
    },
    "digest-pause-notice": async (rawPayload: unknown, context: JobContext) => {
      const payload = parsePauseNoticePayload(rawPayload);
      const client = postgres(options.databaseUrl, { max: 1 });
      try {
        const users = await client<{ email: string | null; paused: boolean; pause_generation: number; pause_notice_sent_at: Date | null }[]>`
          select users.email, digest_preferences.paused, digest_preferences.pause_generation,
            digest_preferences.pause_notice_sent_at
          from users
          join digest_preferences on digest_preferences.user_id = users.id
          where users.id = ${payload.userId}
        `;
        const user = users[0];
        if (!user || !user.paused || user.pause_generation !== payload.pauseGeneration || user.pause_notice_sent_at) return;
        if (!user.email) throw new EmailDeliveryFailure("User has no email address", false);
        if (!(await context.heartbeat())) throw new JobLeaseLostFailure("Digest pause notice lease was lost");

        try {
          const provider = options.emailProvider ?? createEmailProvider();
          const email = renderPauseNoticeEmail(applicationUrl("/settings", options.emailActionBaseUrl));
          await provider.send({
            to: user.email,
            from: process.env.EMAIL_FROM ?? "ReStar <no-reply@localhost>",
            subject: email.subject,
            html: email.html,
            text: email.text,
            idempotencyKey: `pause-notice:${payload.userId}:${payload.pauseGeneration}`,
          });
          if (!(await context.heartbeat())) throw new JobLeaseLostFailure("Digest pause notice lease was lost");
          await client`
            update digest_preferences
            set pause_notice_sent_at = now(), updated_at = now()
            where user_id = ${payload.userId}
              and paused = true
              and pause_generation = ${payload.pauseGeneration}
              and pause_notice_sent_at is null
          `;
        } catch (error) {
          if (error instanceof JobLeaseLostFailure) throw error;
          const failure = error instanceof EmailDeliveryFailure
            ? error
            : new EmailDeliveryFailure(error instanceof Error ? error.message : "Pause notice delivery failed", true);
          throw failure;
        }
      } finally {
        await client.end();
      }
    },
  };
}
