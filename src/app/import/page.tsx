import { cookies } from "next/headers";
import postgres from "postgres";

import { getSessionUserIdFromToken, sessionCookieName } from "@/auth/session";
import { getCurrentImportStatus } from "@/imports/status";

const statusCopy: Record<string, { heading: string; detail: string }> = {
  pending: { heading: "Import pending", detail: "Your initial GitHub Stars import is waiting for a worker." },
  running: { heading: "Import in progress", detail: "ReStar is importing your public Starred Repositories." },
  retrying: { heading: "Import retrying", detail: "GitHub could not complete the request. ReStar will try again automatically." },
  completed: { heading: "Import complete", detail: "Your public Starred Repositories are ready." },
  failed_revoked: { heading: "GitHub access revoked", detail: "Sign in with GitHub again to restart the import." },
  failed_rate_limit: { heading: "GitHub rate limit reached", detail: "The automatic retries were exhausted. Sign in again to retry." },
  failed: { heading: "Import failed", detail: "The import could not finish after retrying." },
};

export default async function ImportPage() {
  const cookieStore = await cookies();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const userId = await getSessionUserIdFromToken(client, cookieStore.get(sessionCookieName)?.value);
    if (!userId) {
      return (
        <main className="shell"><section className="hero"><h1>Sign in required</h1><p className="lede">Start again from the ReStar home page.</p></section></main>
      );
    }
    const status = await getCurrentImportStatus(client, userId);
    const copy = statusCopy[status?.status ?? ""] ?? { heading: "Import not started", detail: "No GitHub Stars import is available." };
    const refresh = status && ["pending", "running", "retrying"].includes(status.status);
    return (
      <main className="shell">
        {refresh ? <meta httpEquiv="refresh" content="3" /> : null}
        <section className="hero" aria-labelledby="import-heading">
          <p className="eyebrow">GitHub Stars</p>
          <h1 id="import-heading">{copy.heading}</h1>
          <p className="lede">{copy.detail}</p>
          {status ? (
            <div className="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {status.importedRepositories} repositories across {status.pagesCompleted} pages · attempt {status.attempts}
            </div>
          ) : null}
          {status?.error ? <p className="lede">{status.error}</p> : null}
        </section>
      </main>
    );
  } finally {
    await client.end();
  }
}
