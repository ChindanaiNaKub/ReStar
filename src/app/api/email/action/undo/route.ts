import { withDatabaseClient } from "@/db/with-client";
import { emailActionErrorMessage, emailActionErrorStatus, undoEmailActionRequest } from "@/email/http";

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

export async function POST(request: Request) {
  try {
    return await withDatabaseClient(async (client) => Response.json(await undoEmailActionRequest(client, request), { headers: noStore }));
  } catch (error) {
    return Response.json({ error: emailActionErrorMessage(error) }, { status: emailActionErrorStatus(error), headers: noStore });
  }
}
