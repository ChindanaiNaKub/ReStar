const sensitiveKeyPattern = /authorization|cookie|email|password|secret|token|nonce|signature|verifier|signed.?url|access.?key/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const authorizationPattern = /\bBearer\s+[^\s,;]+/gi;
const signedQueryPattern = /([?&](?:access_token|code|nonce|sig|signature|state|token)=)[^&#\s]+/gi;
const namedCredentialPattern = /\b(?:access[_ -]?token|api[_ -]?key|refresh[_ -]?token|session[_ -]?token|token)\s*[:=]\s*[^\s,;&]+/gi;

export function redactSensitiveText(value: string) {
  return value
    .replace(authorizationPattern, "Authorization [REDACTED]")
    .replace(signedQueryPattern, "$1[REDACTED]")
    .replace(namedCredentialPattern, (match) => {
      const separator = match.search(/[:=]/);
      return `${match.slice(0, separator + 1)}[REDACTED]`;
    })
    .replace(emailPattern, "[REDACTED_EMAIL]");
}

function sanitizeValue(key: string, value: string | number | boolean | null) {
  if (value === null || typeof value !== "string") return value;
  if (sensitiveKeyPattern.test(key)) return "[REDACTED]";
  return redactSensitiveText(value);
}

export function safeErrorMessage(error: unknown, fallback = "Unknown failure") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = redactSensitiveText(message).trim().slice(0, 500);
  return redacted || fallback;
}

export function logEvent(event: string, fields: Record<string, string | number | boolean | null>) {
  const sanitized = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
  console.info(JSON.stringify({ event, ...sanitized }));
}
