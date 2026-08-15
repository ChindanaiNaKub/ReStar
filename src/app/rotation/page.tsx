import { cookies } from "next/headers";

import { getSessionUserIdFromToken, sessionCookieName } from "@/auth/session";
import { withDatabaseClient } from "@/db/with-client";
import { getEligibleRotation } from "@/rotation/service";
import RotationView from "./rotation-view";

export default async function RotationPage() {
  const cookieStore = await cookies();
  return withDatabaseClient(async (client) => {
    const userId = await getSessionUserIdFromToken(client, cookieStore.get(sessionCookieName)?.value);
    if (!userId) {
      return (
        <main className="shell">
          <section className="hero" aria-labelledby="rotation-heading">
            <h1 id="rotation-heading">Sign in required</h1>
            <p className="lede">Start from the ReStar home page to review your Rotation.</p>
          </section>
        </main>
      );
    }

    const repositories = await getEligibleRotation(client, userId, new Date());
    return (
      <main className="shell shell-wide">
        <section className="rotation-page" aria-labelledby="rotation-heading">
          <p className="eyebrow">Your Rotation</p>
          <h1 id="rotation-heading">A few forgotten Stars, back in view.</h1>
          <p className="lede">Review each repository while it is useful. Your feedback sets when it can return.</p>
          <RotationView initialRepositories={repositories} />
        </section>
      </main>
    );
  });
}
