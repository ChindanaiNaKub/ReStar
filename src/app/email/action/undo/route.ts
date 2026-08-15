import { withDatabaseClient } from "@/db/with-client";
import { emailActionErrorMessage, emailActionErrorStatus, undoEmailActionRequest } from "@/email/http";
import { escapeEmailHtml } from "@/email/views";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
};

export async function POST(request: Request) {
  try {
    await withDatabaseClient((client) => undoEmailActionRequest(client, request));
    return new Response(`<main><h1>Feedback Action undone</h1><p>Rotation restored for this Digest Item.</p></main>`, { headers: noStoreHeaders });
  } catch (error) {
    return new Response(`<main><h1>Undo unavailable</h1><p>${escapeEmailHtml(emailActionErrorMessage(error))}</p></main>`, {
      status: emailActionErrorStatus(error),
      headers: noStoreHeaders,
    });
  }
}
