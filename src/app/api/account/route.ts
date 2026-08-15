import { NextResponse } from "next/server";

import { deleteUserAccount } from "@/account/deletion";
import { getSessionUserId, sessionCookieName } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";

export async function DELETE(request: Request) {
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserId(client, request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Type DELETE to confirm account deletion" }, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      (body as { confirmation?: unknown }).confirmation !== "DELETE"
    ) {
      return Response.json({ error: "Type DELETE to confirm account deletion" }, { status: 400 });
    }

    const deleted = await deleteUserAccount(client, userId);
    if (!deleted) return Response.json({ error: "Account was already deleted" }, { status: 401 });

    const response = NextResponse.json({ deleted: true });
    response.cookies.set(sessionCookieName, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: new URL(request.url).protocol === "https:",
    });
    return response;
  });
}
