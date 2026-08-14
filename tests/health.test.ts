import { afterAll, beforeAll, expect, it } from "vitest";

import { startTestApplication } from "./support/test-application";

let application: Awaited<ReturnType<typeof startTestApplication>>;

beforeAll(async () => {
  application = await startTestApplication();
});

afterAll(async () => {
  await application.stop();
});

it("reports that the application and database are healthy", async () => {
  const response = await application.request("/api/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    status: "ok",
    database: "connected",
  });
});
