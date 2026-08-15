import type postgres from "postgres";
import { isImportStatusName, type ImportStatusName } from "./status-values";

export type ImportStatus = {
  status: ImportStatusName;
  pagesCompleted: number;
  importedRepositories: number;
  error: string | null;
  attempts: number;
};

export async function getCurrentImportStatus(client: ReturnType<typeof postgres>, userId: number) {
  const rows = await client<{
    status: string;
    pages_completed: number;
    imported_repositories: number;
    error: string | null;
    attempts: number | null;
  }[]>`
    select imports.status, imports.pages_completed, imports.imported_repositories,
      coalesce(imports.error, jobs.last_error) as error, jobs.attempts
    from imports
    left join jobs on jobs.kind = 'github-stars-import' and (jobs.payload->>'importId')::bigint = imports.id
    where imports.user_id = ${userId}
    order by imports.created_at desc
    limit 1
  `;
  const current = rows[0];
  if (!current) return null;
  if (!isImportStatusName(current.status)) throw new Error(`Unknown import status: ${current.status}`);
  return {
    status: current.status,
    pagesCompleted: current.pages_completed,
    importedRepositories: current.imported_repositories,
    attempts: current.attempts ?? 0,
    error: current.error,
  } satisfies ImportStatus;
}
