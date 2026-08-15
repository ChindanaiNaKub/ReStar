import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let postgresContainer: StartedPostgreSqlContainer;

beforeAll(async () => {
  postgresContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
});

afterAll(async () => {
  await postgresContainer.stop();
});

it("runs a due job through the scheduled worker entrypoint", async () => {
  const databaseUrl = postgresContainer.getConnectionUri();
  const { migrateDatabase } = await import("../src/db/migrate");
  await migrateDatabase(databaseUrl);

  const seed = postgres(databaseUrl);
  await seed`
    insert into jobs (kind, payload, run_after)
    values ('probe', ${seed.json({ requestId: "job-123" })}, ${new Date("2026-08-14T00:00:00Z")})
  `;
  await seed.end();

  vi.resetModules();
  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const handledPayloads: unknown[] = [];

  const result = await runWorkerCycle({
    databaseUrl,
    now: new Date("2026-08-14T00:00:01Z"),
    handlers: {
      probe: async (payload: unknown) => {
        handledPayloads.push(payload);
      },
    },
  });

  expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, retrying: 0 });
  expect(handledPayloads).toEqual([{ requestId: "job-123" }]);
});

it("reclaims a job after its worker lease expires", async () => {
  const databaseUrl = postgresContainer.getConnectionUri();
  const { migrateDatabase } = await import("../src/db/migrate");
  await migrateDatabase(databaseUrl);

  const seed = postgres(databaseUrl);
  await seed`
    insert into jobs (kind, payload, status, run_after, locked_at, attempts)
    values (
      'probe', ${seed.json({ requestId: "abandoned-job" })}, 'running',
      ${new Date("2026-08-14T00:00:00Z")}, ${new Date("2026-08-14T00:01:00Z")}, 1
    )
  `;
  await seed.end();

  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const handledPayloads: unknown[] = [];
  const result = await runWorkerCycle({
    databaseUrl,
    now: new Date("2026-08-14T00:10:00Z"),
    handlers: { probe: async (payload) => { handledPayloads.push(payload); } },
  });

  expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, retrying: 0 });
  expect(handledPayloads).toEqual([{ requestId: "abandoned-job" }]);
});

it("does not let a worker overwrite a job after losing its lease", async () => {
  const databaseUrl = postgresContainer.getConnectionUri();
  const { migrateDatabase } = await import("../src/db/migrate");
  await migrateDatabase(databaseUrl);
  const seed = postgres(databaseUrl);
  await seed`
    insert into jobs (kind, payload, run_after)
    values ('probe', ${seed.json({ requestId: "contended-job" })}, ${new Date("2026-08-14T00:00:00Z")})
  `;
  await seed.end();

  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl,
    now: new Date("2026-08-14T00:00:01Z"),
    handlers: {
      probe: async (_payload, context) => {
        const replacement = postgres(databaseUrl);
        await replacement`
          update jobs set locked_by = 'replacement-worker', locked_at = now()
          where payload->>'requestId' = 'contended-job'
        `;
        await replacement.end();
        expect(await context.heartbeat()).toBe(false);
        throw new Error("Original worker lost its lease");
      },
    },
  });

  expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, retrying: 0 });
  const inspect = postgres(databaseUrl);
  const jobs = await inspect<{ status: string; locked_by: string }[]>`
    select status, locked_by from jobs where payload->>'requestId' = 'contended-job'
  `;
  await inspect.end();
  expect(jobs).toEqual([{ status: "running", locked_by: "replacement-worker" }]);
});

it("stores a redacted diagnostic when a job fails", async () => {
  const databaseUrl = postgresContainer.getConnectionUri();
  const { migrateDatabase } = await import("../src/db/migrate");
  await migrateDatabase(databaseUrl);

  const seed = postgres(databaseUrl);
  await seed`
    insert into jobs (kind, payload, run_after)
    values ('probe', ${seed.json({ requestId: "secret-job" })}, ${new Date("2026-08-14T00:00:00Z")})
  `;
  await seed.end();

  const { runWorkerCycle } = await import("../src/jobs/run-worker-cycle");
  const result = await runWorkerCycle({
    databaseUrl,
    now: new Date("2026-08-14T00:00:01Z"),
    handlers: {
      probe: async () => {
        throw new Error("GitHub rejected Bearer secret-token for person@example.com");
      },
    },
  });

  expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, retrying: 0 });
  const inspect = postgres(databaseUrl);
  const jobs = await inspect<{ status: string; last_error: string }[]>`
    select status, last_error from jobs where payload->>'requestId' = 'secret-job'
  `;
  expect(jobs).toEqual([{
    status: "failed",
    last_error: "GitHub rejected Authorization [REDACTED] for [REDACTED_EMAIL]",
  }]);
  await inspect.end();
});
