type GitHubIdentity = { id: number; login: string; avatar_url: string | null; email?: string | null };

function oauthBaseUrl() {
  return process.env.GITHUB_OAUTH_BASE_URL ?? "https://github.com";
}

function apiBaseUrl() {
  return process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
}

export function createAuthorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("GITHUB_CLIENT_ID is required");

  const url = new URL("/login/oauth/authorize", oauthBaseUrl());
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GitHub OAuth client credentials are required");

  const response = await fetch(new URL("/login/oauth/access_token", oauthBaseUrl()), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) throw new Error(body.error ?? "GitHub token exchange failed");
  return body.access_token;
}

export async function fetchGitHubIdentity(accessToken: string) {
  const response = await fetch(new URL("/user", apiBaseUrl()), {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("GitHub identity revalidation failed");
  const identity = (await response.json()) as GitHubIdentity;
  if (!identity.id || !identity.login) throw new Error("GitHub returned an invalid identity");
  if (!identity.email) {
    const emailsResponse = await fetch(new URL("/user/emails", apiBaseUrl()), {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}` },
    });
    if (emailsResponse.ok) {
      const emails = await emailsResponse.json() as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
      identity.email = emails.find((email) => email.primary && email.verified)?.email
        ?? emails.find((email) => email.verified)?.email;
    }
  }
  return identity;
}
