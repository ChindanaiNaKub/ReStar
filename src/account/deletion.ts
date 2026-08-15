import type postgres from "postgres";

export async function deleteUserAccount(client: ReturnType<typeof postgres>, userId: number) {
  return client.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(${userId})`;
    await transaction`
      delete from jobs
      where payload->>'userId' = ${String(userId)}
    `;
    const deleted = await transaction<{ id: number }[]>`
      delete from users
      where id = ${userId}
      returning id
    `;
    return deleted.length === 1;
  });
}
