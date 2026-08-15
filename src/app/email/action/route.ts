import { withDatabaseClient } from "@/db/with-client";
import { emailActionErrorMessage, emailActionErrorStatus, applyEmailActionRequest, previewEmailAction } from "@/email/http";
import { escapeEmailHtml, renderEmailActionResult, renderEmailActionConfirmation } from "@/email/views";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
};

export async function GET(request: Request) {
  try {
    const preview = await withDatabaseClient((client) => previewEmailAction(client, request));
    return new Response(renderEmailActionConfirmation(preview, new URL(request.url).searchParams.get("token")!), { headers: noStoreHeaders });
  } catch (error) {
    return new Response(`<main><h1>Link unavailable</h1><p>${escapeEmailHtml(emailActionErrorMessage(error))}</p></main>`, {
      status: emailActionErrorStatus(error),
      headers: noStoreHeaders,
    });
  }
}

export async function POST(request: Request) {
  try {
    const applied = await withDatabaseClient((client) => applyEmailActionRequest(client, request));
    return new Response(renderEmailActionResult(applied), { headers: noStoreHeaders });
  } catch (error) {
    return new Response(`<main><h1>Action unavailable</h1><p>${escapeEmailHtml(emailActionErrorMessage(error))}</p></main>`, {
      status: emailActionErrorStatus(error),
      headers: noStoreHeaders,
    });
  }
}
