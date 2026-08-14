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
