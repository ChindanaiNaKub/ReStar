import { getSessionUserId } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";
import { getDigestPreferences, InvalidDigestPreferencesError, updateDigestPreferences } from "@/digest/preferences";

export async function GET(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    return Response.json(await getDigestPreferences(client, userId, request.headers.get("x-time-zone") ?? undefined));
  });
}

async function update(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    }

    try {
      return Response.json(await updateDigestPreferences(client, userId, body));
    } catch (error) {
      if (error instanceof InvalidDigestPreferencesError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  });
}

export const PUT = update;
export const PATCH = update;
