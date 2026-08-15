import { migrateDatabase } from "../src/db/migrate";
import { logEvent } from "../src/observability/log";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

await migrateDatabase(databaseUrl);
logEvent("database.migrations_completed", {});
