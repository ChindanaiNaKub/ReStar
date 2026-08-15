import { afterEach, expect, it, vi } from "vitest";

import { logEvent, safeErrorMessage } from "../src/observability/log";

afterEach(() => {
  vi.restoreAllMocks();
});

it("writes structured events without authorization, email, or signed-link values", () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => undefined);

  logEvent("security.example", {
    authorization: "Bearer github-secret-token",
    email: "person@example.com",
    actionUrl: "https://restar.example/api/email/action?token=signed-secret&action=forget",
    message: "contact person@example.com after token=raw-token",
    count: 2,
  });

  expect(output).toHaveBeenCalledOnce();
  expect(output.mock.calls[0]![0]).toBe(JSON.stringify({
    event: "security.example",
    authorization: "[REDACTED]",
    email: "[REDACTED]",
    actionUrl: "https://restar.example/api/email/action?token=[REDACTED]&action=forget",
    message: "contact [REDACTED_EMAIL] after token=[REDACTED]",
    count: 2,
  }));
});

it("keeps job diagnostics useful while redacting secrets from error messages", () => {
  expect(safeErrorMessage(new Error("GitHub rejected Bearer abc123 for person@example.com")))
    .toBe("GitHub rejected Authorization [REDACTED] for [REDACTED_EMAIL]");
  expect(safeErrorMessage(null, "Fallback failure")).toBe("Fallback failure");
});
