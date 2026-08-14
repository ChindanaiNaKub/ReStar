import postgres from "postgres";

import { getSessionUserId } from "@/auth/session";
import { getCurrentImportStatus } from "@/imports/status";

export async function GET(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const current = await getCurrentImportStatus(client, userId);
    if (!current) return Response.json({ status: "not_started" });
    return Response.json(current);
  } finally {
    await client.end();
  }
}
