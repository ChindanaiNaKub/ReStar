import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type DatabaseConnection = ReturnType<typeof createDatabaseConnection>;

const globalDatabase = globalThis as typeof globalThis & {
  restarDatabase?: DatabaseConnection;
};

function createDatabaseConnection() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(databaseUrl, { max: 10 });

  return {
    client,
    db: drizzle(client),
  };
}

export function getDatabase() {
  globalDatabase.restarDatabase ??= createDatabaseConnection();
  return globalDatabase.restarDatabase;
}
