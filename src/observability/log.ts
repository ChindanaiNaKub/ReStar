export function logEvent(event: string, fields: Record<string, string | number | boolean | null>) {
  console.info(JSON.stringify({ event, ...fields }));
}
