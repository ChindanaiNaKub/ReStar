import postgres from "postgres";
import { randomUUID } from "node:crypto";

export type JobContext = {
  attempt: number;
  maxAttempts: number;
  heartbeat: () => Promise<boolean>;
};
type JobHandler = (payload: unknown, context: JobContext) => Promise<void>;

type RunWorkerCycleOptions = {
  databaseUrl: string;
  now: Date;
  handlers: Record<string, JobHandler>;
  batchSize?: number;
};

type ClaimedJob = {
  id: number;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  locked_by: string;
};

type RetryableFailure = Error & { retryable?: boolean; retryAfterMs?: number };

export async function runWorkerCycle({
  databaseUrl,
  now,
  handlers,
  batchSize = 10,
}: RunWorkerCycleOptions) {
  const client = postgres(databaseUrl, { max: 1 });
  const workerToken = randomUUID();

  try {
    const claimed = await client.begin(async (transaction) => {
      return transaction<ClaimedJob[]>`
        with due_jobs as (
          select id
          from jobs
          where (status = 'pending' and run_after <= ${now})
             or (status = 'running' and locked_at <= ${new Date(now.getTime() - 5 * 60_000)})
          order by run_after, id
          for update skip locked
          limit ${batchSize}
        )
        update jobs
        set status = 'running', locked_at = ${now}, locked_by = ${workerToken}, attempts = attempts + 1
        from due_jobs
        where jobs.id = due_jobs.id
        returning jobs.id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts, jobs.locked_by
      `;
    });

    let completed = 0;
    let failed = 0;
    let retrying = 0;

    for (const job of claimed) {
      const handler = handlers[job.kind];
      const heartbeat = async () => {
        const refreshed = await client<{ id: number }[]>`
          update jobs set locked_at = ${new Date()}
          where id = ${job.id} and status = 'running' and locked_by = ${job.locked_by}
          returning id
        `;
        return refreshed.length === 1;
      };
      const heartbeatTimer = setInterval(() => {
        void heartbeat().catch((error: unknown) => {
          console.error(JSON.stringify({
            event: "worker.heartbeat_failed",
            jobId: job.id,
            errorName: error instanceof Error ? error.name : "UnknownFailure",
          }));
        });
      }, 60_000);
      heartbeatTimer.unref();

      try {
        if (!handler) {
          throw new Error(`No handler registered for job kind: ${job.kind}`);
        }

        await handler(job.payload, { attempt: job.attempts, maxAttempts: job.max_attempts, heartbeat });
        const updated = await client<{ id: number }[]>`
          update jobs
          set status = 'completed', completed_at = ${now}, locked_at = null, locked_by = null
          where id = ${job.id} and locked_by = ${job.locked_by}
          returning id
        `;
        completed += updated.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown job failure";
        const retryable = error as RetryableFailure;
        if (retryable.retryable && job.attempts < job.max_attempts) {
          const requestedDelay = retryable.retryAfterMs ?? 60_000 * 2 ** (job.attempts - 1);
          const delayMs = Math.min(Math.max(requestedDelay, 1_000), 15 * 60_000);
          const updated = await client<{ id: number }[]>`
            update jobs
            set status = 'pending', last_error = ${message}, locked_at = null, locked_by = null,
              run_after = ${new Date(now.getTime() + delayMs)}
            where id = ${job.id} and locked_by = ${job.locked_by}
            returning id
          `;
          retrying += updated.length;
        } else {
          const updated = await client<{ id: number }[]>`
            update jobs
            set status = 'failed', last_error = ${message}, locked_at = null, locked_by = null
            where id = ${job.id} and locked_by = ${job.locked_by}
            returning id
          `;
          failed += updated.length;
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    }

    return { claimed: claimed.length, completed, failed, retrying };
  } finally {
    await client.end();
  }
}
