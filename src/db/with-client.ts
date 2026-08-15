import postgres from "postgres";

export async function withDatabaseClient<T>(run: (client: ReturnType<typeof postgres>) => Promise<T>) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
