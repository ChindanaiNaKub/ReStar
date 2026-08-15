import { cookies } from "next/headers";

import { getSessionUserIdFromToken, sessionCookieName } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";
import DigestPreferencesView from "./preferences-view";

export default async function SettingsPage() {
  const cookieStore = await cookies();
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserIdFromToken(client, cookieStore.get(sessionCookieName)?.value);
    if (!userId) {
      return (
        <main className="shell">
          <section className="hero" aria-labelledby="settings-heading">
            <h1 id="settings-heading">Sign in required</h1>
            <p className="lede">Start from the ReStar home page to configure your Digest.</p>
          </section>
        </main>
      );
    }

    return (
      <main className="shell shell-wide">
        <section className="settings-page" aria-labelledby="settings-heading">
          <p className="eyebrow">Digest settings</p>
          <h1 id="settings-heading">Shape your weekly Digest.</h1>
          <p className="lede">Choose when ReStar brings forgotten Starred Repositories back to you.</p>
          <DigestPreferencesView />
        </section>
      </main>
    );
  });
}
