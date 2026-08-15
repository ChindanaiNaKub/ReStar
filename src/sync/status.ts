import type postgres from "postgres";
import { isImportStatusName, type ImportStatusName } from "@/imports/status-values";

export type SyncStatus = {
  syncId: number;
  status: ImportStatusName;
  pagesCompleted: number;
  importedRepositories: number;
  error: string | null;
  attempts: number;
  requestedAt: string;
  nextAllowedAt: string;
};

export async function getCurrentSyncStatus(client: ReturnType<typeof postgres>, userId: number) {
  const rows = await client<{
    id: number;
    status: string;
    pages_completed: number;
    imported_repositories: number;
    error: string | null;
    attempts: number | null;
    requested_at: Date;
  }[]>`
    select imports.id, imports.status, imports.pages_completed, imports.imported_repositories,
      coalesce(imports.error, jobs.last_error) as error, jobs.attempts, imports.created_at as requested_at
    from imports
    left join jobs on jobs.kind = 'github-stars-import'
      and (jobs.payload->>'importId')::bigint = imports.id
    where imports.user_id = ${userId} and imports.sync_type = 'manual'
    order by imports.created_at desc
    limit 1
  `;
  const current = rows[0];
  if (!current) return null;
  if (!isImportStatusName(current.status)) throw new Error(`Unknown sync status: ${current.status}`);
  const nextAllowedAt = new Date(current.requested_at.getTime() + 60 * 60_000);
  return {
    syncId: current.id,
    status: current.status,
    pagesCompleted: current.pages_completed,
    importedRepositories: current.imported_repositories,
    attempts: current.attempts ?? 0,
    error: current.error,
    requestedAt: current.requested_at.toISOString(),
    nextAllowedAt: nextAllowedAt.toISOString(),
  } satisfies SyncStatus;
}
