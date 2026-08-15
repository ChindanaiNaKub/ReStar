export type GitHubStar = {
  starred_at: string;
  repo: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
    owner: { login: string };
  };
};

export class GitHubImportFailure extends Error {
  constructor(
    message: string,
    readonly kind: "revoked" | "rate_limit" | "other",
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function nextPageUrl(link: string | null, apiOrigin: string) {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] !== "next") continue;
    const next = new URL(match[1]!);
    if (next.origin !== apiOrigin) {
      throw new GitHubImportFailure("GitHub returned an unsafe pagination link", "other", false);
    }
    return next;
  }
  return null;
}

export async function fetchStarredPage(url: URL, accessToken: string, apiOrigin: string) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github.star+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubImportFailure("GitHub access was revoked; sign in again", "revoked", false);
    }
    const rateLimited = response.status === 429 || (
      response.status === 403 && (
        response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("x-ratelimit-reset")
      )
    );
    if (rateLimited) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      throw new GitHubImportFailure(
        "GitHub rate limit reached; import will retry",
        "rate_limit",
        true,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
      );
    }
    throw new GitHubImportFailure(
      `GitHub Stars request failed (${response.status})`,
      "other",
      response.status >= 500,
    );
  }
  const body = (await response.json()) as GitHubStar[];
  if (!Array.isArray(body)) {
    throw new GitHubImportFailure("GitHub returned an invalid Stars page", "other", false);
  }
  return { stars: body, next: nextPageUrl(response.headers.get("link"), apiOrigin) };
}
