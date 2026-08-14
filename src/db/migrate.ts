import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import postgres from "postgres";

export async function migrateDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });

  try {
    await migrate(drizzle(client), {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
  } finally {
    await client.end();
  }
}
