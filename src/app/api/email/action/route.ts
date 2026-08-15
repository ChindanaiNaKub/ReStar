import {
  emailActionErrorMessage,
  emailActionErrorStatus,
  applyEmailActionRequest,
  previewEmailAction,
} from "@/email/http";
import { withDatabaseClient } from "@/db/with-client";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function GET(request: Request) {
  try {
    return await withDatabaseClient(async (client) => Response.json(await previewEmailAction(client, request), { headers: noStore }));
  } catch (error) {
    return Response.json({ error: emailActionErrorMessage(error) }, { status: emailActionErrorStatus(error), headers: noStore });
  }
}

export async function POST(request: Request) {
  try {
    return await withDatabaseClient(async (client) => Response.json(await applyEmailActionRequest(client, request), { headers: noStore }));
  } catch (error) {
    return Response.json({ error: emailActionErrorMessage(error) }, { status: emailActionErrorStatus(error), headers: noStore });
  }
}
