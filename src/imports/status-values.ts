export const importStatusNames = [
  "pending",
  "running",
  "retrying",
  "completed",
  "failed",
  "failed_revoked",
  "failed_rate_limit",
] as const;

export type ImportStatusName = (typeof importStatusNames)[number];

export const terminalImportStatuses = new Set<ImportStatusName>([
  "failed",
  "failed_revoked",
  "failed_rate_limit",
]);

export function isImportStatusName(value: string): value is ImportStatusName {
  return (importStatusNames as readonly string[]).includes(value);
}

export function isTerminalImportStatus(value: string) {
  return isImportStatusName(value) && terminalImportStatuses.has(value);
}
