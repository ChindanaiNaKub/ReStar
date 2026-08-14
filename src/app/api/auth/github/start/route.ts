import postgres from "postgres";
import { NextResponse } from "next/server";

import { createPkceChallenge, hashToken, randomToken } from "@/auth/crypto";
import { createAuthorizationUrl } from "@/github/client";

const oauthCookieName = "restar_oauth";

export async function GET(request: Request) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const state = randomToken();
  const browserNonce = randomToken();
  const codeVerifier = randomToken();
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await client`
      insert into oauth_attempts (state_hash, browser_nonce_hash, code_verifier, expires_at)
      values (${hashToken(state)}, ${hashToken(browserNonce)}, ${codeVerifier}, ${new Date(Date.now() + 10 * 60_000)})
    `;
  } finally {
    await client.end();
  }

  const redirectUri = new URL("/api/auth/github/callback", request.url).toString();
  const response = NextResponse.redirect(
    createAuthorizationUrl({ state, codeChallenge: createPkceChallenge(codeVerifier), redirectUri }),
  );
  response.cookies.set(oauthCookieName, browserNonce, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/api/auth/github/callback",
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
  });
  return response;
}
