import { migrateDatabase } from "./db/migrate";
import { runWorkerCycle } from "./jobs/run-worker-cycle";

const databaseUrl = process.env.DATABASE_URL;
const intervalMs = 15_000;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

await migrateDatabase(databaseUrl);

while (!stopping) {
  const result = await runWorkerCycle({ databaseUrl, now: new Date(), handlers: {} });

  if (result.claimed > 0) {
    console.info(JSON.stringify({ event: "worker.cycle", ...result }));
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
