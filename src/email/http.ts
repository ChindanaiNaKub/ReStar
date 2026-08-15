import type postgres from "postgres";

import {
  applyEmailAction,
  getEmailActionPreview,
  type AppliedEmailAction,
  type EmailActionPreview,
  EmailActionTokenError,
  getEmailActionTokenSecret,
  undoEmailAction,
} from "./actions";

export function emailActionErrorStatus(error: unknown) {
  if (!(error instanceof EmailActionTokenError)) return 500;
  if (error.reason === "invalid") return 400;
  if (error.reason === "expired") return 410;
  return 409;
}

export function emailActionErrorMessage(error: unknown) {
  if (!(error instanceof EmailActionTokenError)) return "Email action failed";
  if (error.reason === "expired") return "This email action link has expired.";
  if (error.reason === "used" || error.reason === "already_applied") {
    return "This Digest Item already has an effective Feedback Action.";
  }
  if (error.reason === "not_undoable") return "This Feedback Action can no longer be undone.";
  return "This email action link is invalid.";
}

export function requestToken(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (token) return token;
  return null;
}

export async function bodyToken(request: Request) {
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await request.json() as { token?: unknown };
      return typeof body.token === "string" ? body.token : null;
    }
    const form = await request.formData();
    const token = form.get("token");
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export async function previewEmailAction(
  client: ReturnType<typeof postgres>,
  request: Request,
): Promise<EmailActionPreview> {
  const token = requestToken(request);
  if (!token) throw new EmailActionTokenError("invalid");
  return getEmailActionPreview(client, token, getEmailActionTokenSecret());
}

export async function applyEmailActionRequest(
  client: ReturnType<typeof postgres>,
  request: Request,
): Promise<AppliedEmailAction> {
  const token = await bodyToken(request);
  if (!token) throw new EmailActionTokenError("invalid");
  return applyEmailAction(client, token, getEmailActionTokenSecret());
}

export async function undoEmailActionRequest(
  client: ReturnType<typeof postgres>,
  request: Request,
) {
  const token = await bodyToken(request);
  if (!token) throw new EmailActionTokenError("invalid");
  return undoEmailAction(client, token, getEmailActionTokenSecret());
}
