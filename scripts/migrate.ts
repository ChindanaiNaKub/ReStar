import { migrateDatabase } from "../src/db/migrate";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

await migrateDatabase(databaseUrl);
console.info("Database migrations are up to date.");
