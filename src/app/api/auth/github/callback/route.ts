import postgres from "postgres";
import { NextResponse } from "next/server";

import { encryptAccessToken, hashToken, randomToken } from "@/auth/crypto";
import { sessionCookieName } from "@/auth/session";
import { exchangeAuthorizationCode, fetchGitHubIdentity } from "@/github/client";

const oauthCookieName = "restar_oauth";

function readCookie(request: Request, name: string) {
  return request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([candidate]) => candidate === name)?.[1];
}

export async function GET(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const browserNonce = readCookie(request, oauthCookieName);
  if (!state || !code || !browserNonce) return Response.json({ error: "Invalid OAuth callback" }, { status: 400 });

  const client = postgres(databaseUrl, { max: 1 });
  try {
    const attempts = await client<{ code_verifier: string; browser_nonce_hash: string }[]>`
      delete from oauth_attempts
      where state_hash = ${hashToken(state)} and expires_at > now()
      returning code_verifier, browser_nonce_hash
    `;
    const attempt = attempts[0];
    if (!attempt || attempt.browser_nonce_hash !== hashToken(browserNonce)) {
      return Response.json({ error: "Invalid or expired OAuth state" }, { status: 400 });
    }

    const redirectUri = new URL("/api/auth/github/callback", request.url).toString();
    const accessToken = await exchangeAuthorizationCode({ code, codeVerifier: attempt.code_verifier, redirectUri });
    const identity = await fetchGitHubIdentity(accessToken);
    const encryptedAccessToken = encryptAccessToken(accessToken);
    const sessionToken = randomToken();

    await client.begin(async (transaction) => {
      const existing = await transaction<{ id: number }[]>`
        select id from users where github_user_id = ${String(identity.id)}
      `;
      let userId = existing[0]?.id;
      const isFirstLogin = userId === undefined;
      if (userId === undefined) {
        const inserted = await transaction<{ id: number }[]>`
          insert into users (github_user_id, github_login, avatar_url)
          values (${String(identity.id)}, ${identity.login}, ${identity.avatar_url})
          returning id
        `;
        userId = inserted[0]!.id;
      } else {
        await transaction`
          update users set github_login = ${identity.login}, avatar_url = ${identity.avatar_url}, updated_at = now()
          where id = ${userId}
        `;
      }

      await transaction`
        insert into github_credentials (user_id, encrypted_access_token)
        values (${userId}, ${encryptedAccessToken})
        on conflict (user_id) do update
        set encrypted_access_token = excluded.encrypted_access_token, updated_at = now()
      `;
      await transaction`
        insert into sessions (token_hash, user_id, expires_at)
        values (${hashToken(sessionToken)}, ${userId}, ${new Date(Date.now() + 30 * 24 * 60 * 60_000)})
      `;

      if (isFirstLogin) {
        const createdImports = await transaction<{ id: number }[]>`
          insert into imports (user_id) values (${userId}) returning id
        `;
        await transaction`
          insert into jobs (kind, payload, run_after)
          values ('github-stars-import', ${transaction.json({ importId: createdImports[0]!.id, userId })}, now())
        `;
      }
    });

    const response = NextResponse.redirect(new URL("/import", request.url));
    response.cookies.set(sessionCookieName, sessionToken, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
      sameSite: "lax",
      secure: url.protocol === "https:",
    });
    response.cookies.set(oauthCookieName, "", { maxAge: 0, path: "/api/auth/github/callback" });
    return response;
  } finally {
    await client.end();
  }
}
