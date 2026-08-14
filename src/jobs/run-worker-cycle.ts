import postgres from "postgres";

type JobHandler = (payload: unknown) => Promise<void>;

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
};

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
        returning jobs.id, jobs.kind, jobs.payload
      `;
    });

    let completed = 0;
    let failed = 0;

    for (const job of claimed) {
      const handler = handlers[job.kind];

      try {
        if (!handler) {
          throw new Error(`No handler registered for job kind: ${job.kind}`);
        }

        await handler(job.payload);
        await client`
          update jobs
          set status = 'completed', completed_at = ${now}, locked_at = null
          where id = ${job.id}
        `;
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown job failure";
        await client`
          update jobs
          set status = 'failed', last_error = ${message}, locked_at = null
          where id = ${job.id}
        `;
        failed += 1;
      }
    }

    return { claimed: claimed.length, completed, failed };
  } finally {
    await client.end();
  }
}
