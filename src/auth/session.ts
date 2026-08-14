import type postgres from "postgres";

import { hashToken } from "./crypto";

export const sessionCookieName = "restar_session";

export async function getSessionUserIdFromToken(client: ReturnType<typeof postgres>, token: string | undefined) {
  if (!token) return null;
  const rows = await client<{ user_id: number }[]>`
    select user_id
    from sessions
    where token_hash = ${hashToken(token)} and expires_at > now()
  `;
  return rows[0]?.user_id ?? null;
}

export async function getSessionUserId(client: ReturnType<typeof postgres>, request: Request) {
  const token = request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === sessionCookieName)?.[1];
  return getSessionUserIdFromToken(client, token);
}
