import { getSessionUserId } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";
import { getCurrentSyncStatus } from "@/sync/status";

const syncWindowMs = 60 * 60_000;

export async function GET(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json(await getCurrentSyncStatus(client, userId) ?? { status: "not_started" });
  });
}

export async function POST(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    return client.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(${userId})`;
      const now = new Date();
      const recent = await transaction<{ id: number; created_at: Date }[]>`
        select id, created_at from imports
        where user_id = ${userId} and sync_type = 'manual'
        order by created_at desc
        limit 1
      `;
      const latest = recent[0];
      if (latest && latest.created_at.getTime() + syncWindowMs > now.getTime()) {
        return Response.json({
          error: "Sync now is limited to once per hour",
          status: "rate_limited",
          nextAllowedAt: new Date(latest.created_at.getTime() + syncWindowMs).toISOString(),
        }, { status: 429 });
      }

      const active = await transaction<{ id: number }[]>`
        select imports.id
        from imports
        join jobs on jobs.kind = 'github-stars-import'
          and (jobs.payload->>'importId')::bigint = imports.id
        where imports.user_id = ${userId} and jobs.status in ('pending', 'running')
        limit 1
      `;
      if (active.length > 0) {
        return Response.json({ error: "A GitHub Stars sync is already in progress" }, { status: 409 });
      }

      const created = await transaction<{ id: number }[]>`
        insert into imports (user_id, sync_type, status)
        values (${userId}, 'manual', 'pending')
        returning id
      `;
      const syncId = created[0]!.id;
      await transaction`
        insert into jobs (kind, payload, idempotency_key, run_after)
        values (
          'github-stars-import',
          ${transaction.json({ importId: syncId, userId })},
          ${`github-stars-sync:${userId}:${syncId}`},
          ${now}
        )
      `;
      return Response.json({ syncId, status: "pending" }, { status: 202 });
    });
  });
}
