import { sql } from "drizzle-orm";

import { getDatabase } from "@/db/connection";

export async function GET() {
  try {
    const { db } = getDatabase();
    await db.execute(sql`select 1`);

    return Response.json({
      status: "ok",
      database: "connected",
    });
  } catch {
    return Response.json(
      {
        status: "unavailable",
        database: "disconnected",
      },
      { status: 503 },
    );
  }
}
