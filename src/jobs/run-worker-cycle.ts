import postgres from "postgres";

export type JobContext = { attempt: number; maxAttempts: number };
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
};

type RetryableFailure = Error & { retryable?: boolean; retryAfterMs?: number };

export async function runWorkerCycle({
  databaseUrl,
  now,
  handlers,
  batchSize = 10,
}: RunWorkerCycleOptions) {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    const claimed = await client.begin(async (transaction) => {
      return transaction<ClaimedJob[]>`
        with due_jobs as (
          select id
          from jobs
          where status = 'pending' and run_after <= ${now}
          order by run_after, id
          for update skip locked
          limit ${batchSize}
        )
        update jobs
        set status = 'running', locked_at = ${now}, attempts = attempts + 1
        from due_jobs
        where jobs.id = due_jobs.id
        returning jobs.id, jobs.kind, jobs.payload, jobs.attempts, jobs.max_attempts
      `;
    });

    let completed = 0;
    let failed = 0;
    let retrying = 0;

    for (const job of claimed) {
      const handler = handlers[job.kind];

      try {
        if (!handler) {
          throw new Error(`No handler registered for job kind: ${job.kind}`);
        }

        await handler(job.payload, { attempt: job.attempts, maxAttempts: job.max_attempts });
        await client`
          update jobs
          set status = 'completed', completed_at = ${now}, locked_at = null
          where id = ${job.id}
        `;
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown job failure";
        const retryable = error as RetryableFailure;
        if (retryable.retryable && job.attempts < job.max_attempts) {
          const delayMs = retryable.retryAfterMs ?? Math.min(60_000 * 2 ** (job.attempts - 1), 15 * 60_000);
          await client`
            update jobs
            set status = 'pending', last_error = ${message}, locked_at = null, run_after = ${new Date(now.getTime() + delayMs)}
            where id = ${job.id}
          `;
          retrying += 1;
        } else {
          await client`
            update jobs
            set status = 'failed', last_error = ${message}, locked_at = null
            where id = ${job.id}
          `;
          failed += 1;
        }
      }
    }

    return { claimed: claimed.length, completed, failed, retrying };
  } finally {
    await client.end();
  }
}
