import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let postgres: StartedPostgreSqlContainer;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.DATABASE_URL = postgres.getConnectionUri();
});

afterAll(async () => {
  await postgres.stop();
  delete process.env.DATABASE_URL;
});

it("reports that the application and database are healthy", async () => {
  vi.resetModules();
  const { GET } = await import("../src/app/api/health/route");

  const response = await GET();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    status: "ok",
    database: "connected",
  });
});
