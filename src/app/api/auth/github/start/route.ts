import { NextResponse } from "next/server";

import { createPkceChallenge, hashToken, randomToken } from "@/auth/crypto";
import { withDatabaseClient } from "@/db/with-client";
import { createAuthorizationUrl } from "@/github/client";

const oauthCookieName = "restar_oauth";

export async function GET(request: Request) {
  const state = randomToken();
  const browserNonce = randomToken();
  const codeVerifier = randomToken();
  await withDatabaseClient(async (client) => {
    await client`
      insert into oauth_attempts (state_hash, browser_nonce_hash, code_verifier, expires_at)
      values (${hashToken(state)}, ${hashToken(browserNonce)}, ${codeVerifier}, ${new Date(Date.now() + 10 * 60_000)})
    `;
  });

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
