# ReStar MVP

## Problem Statement

People star GitHub repositories because they are useful or interesting in the moment, but a growing Stars collection becomes a passive archive. Older repositories disappear from memory, and the user rarely returns to evaluate, try, or discard them.

The MVP must validate whether periodically Resurfacing forgotten Starred Repositories causes people to engage with their collection again. Its primary success signal is that at least 25–30% of Users who receive a Digest record a Feedback Action on at least one Digest Item each week during the first four weeks.

## Solution

ReStar imports a User's public GitHub Stars, places old enough repositories into Rotation, and sends a weekly email Digest containing four Eligible Repositories. The User can respond with Still Interested, Snooze, Done, or Forget. Each Feedback Action updates whether and when the Starred Repository can be Resurfaced again.

ReStar is personal-first, open source, and self-hostable. Its schema supports multiple Users from the beginning, but the MVP does not include teams, organizations, an admin panel, or growth features.

## User Stories

1. As a GitHub user, I want to sign in with GitHub, so that I do not need to create another password.
2. As a privacy-conscious user, I want ReStar to request only the permissions it needs, so that it cannot access private repositories or modify my GitHub account.
3. As a new User, I want ReStar to import my public Starred Repositories, so that I do not need to recreate my collection.
4. As a User with hundreds or thousands of Stars, I want the initial import to run in the background, so that a long import does not block the web page.
5. As a User waiting for import, I want to see progress and failure status, so that I know whether ReStar is working.
6. As a User, I want GitHub's original star timestamp retained when available, so that old repositories can be distinguished from recent interests.
7. As a User, I want repositories starred fewer than 30 days ago excluded from Resurfacing, so that ReStar does not repeat things still fresh in my memory.
8. As a User, I want ReStar to sync my Stars before preparing a weekly Digest, so that its Rotation reflects GitHub.
9. As a User, I want a rate-limited Sync now action, so that I can refresh ReStar after changing my Stars without creating excessive API traffic.
10. As a User who unstars a repository on GitHub, I want it removed from Rotation after sync, so that ReStar respects my current collection.
11. As a User who stars the same repository again later, I want ReStar to reactivate it after sync, so that the new interest is respected without losing prior history.
12. As a User, I want one weekly Digest by default, so that resurfacing is useful without becoming noisy.
13. As a User, I want the Digest scheduled for Monday at 09:00 in my IANA timezone by default, so that it arrives at a predictable local time.
14. As a User, I want four repositories in each Digest by default, so that review remains quick while still offering variety.
15. As a User, I want to configure three, four, or five Digest Items, so that I can adjust the review load modestly.
16. As a User, I want to pause and resume Digests, so that I control whether ReStar sends email.
17. As a User, I want ReStar to prefer repositories never shown before, so that my collection is explored broadly.
18. As a User, I want previously shown repositories ordered by the longest time since presentation, so that the same items do not dominate Rotation.
19. As a User, I want the selected Digest Items fixed before email delivery, so that retries cannot silently replace the selection.
20. As a User, I want to view current Resurfaced Repositories on the web, so that email is not the only place I can review them.
21. As a User, I want repository name, owner, description, language, star count, and GitHub link shown, so that I can evaluate a repository quickly.
22. As a User, I want to mark a repository Still Interested, so that it stays in Rotation but does not return for 90 days.
23. As a User, I want to Snooze a repository, so that it can return after 30 days.
24. As a User, I want to mark a repository Done, so that it leaves Rotation after I have tried or completed it.
25. As a User, I want to Forget a repository, so that it leaves Rotation and disappears from my active view.
26. As a User, I want Feedback Actions from web and email to have the same effect, so that state remains consistent across channels.
27. As an email recipient, I want an action link to work without signing in again, so that responding to a Digest has low friction.
28. As an email recipient, I want a signed action link to expire and be usable for only one effective action, so that forwarded or leaked links have limited power.
29. As an email recipient, I want a confirmation step before an email action is applied, so that link scanners cannot change my Rotation.
30. As a User who acted by mistake, I want to Undo the most recent action from its result page, so that mistakes are recoverable.
31. As a User, I want repeated delivery retries to produce at most one email and one effective Feedback Action, so that transient failures do not corrupt my experience.
32. As a User who records no Feedback Action for three consecutive Digests, I want automatic delivery paused and one final notice sent, so that ReStar does not become spam.
33. As a User, I want every Digest to include a pause or unsubscribe route, so that email control is always accessible.
34. As a self-hoster, I want email delivery configurable through Resend or standard SMTP, so that the core application is not tied to one provider.
35. As a self-hoster, I want the application, worker, database, and HTTPS proxy deployable with Docker Compose, so that installation has one operational shape.
36. As a self-hoster, I want configuration supplied through environment variables with an example file, so that secrets are not committed.
37. As a User, I want my GitHub token encrypted at rest, so that a database leak alone cannot expose my GitHub authorization.
38. As a User, I want to delete my account and personal data, so that I can leave ReStar completely.
39. As an operator, I want failed sync and Digest jobs to retry with bounded backoff and visible error state, so that temporary outages recover safely.
40. As an operator, I want structured logs without tokens or signed links, so that failures can be diagnosed without leaking credentials.

## Implementation Decisions

- Build a TypeScript monolith using Next.js for web pages and HTTP endpoints, PostgreSQL for durable state, and a worker process built from the same application image for scheduled and background work.
- Package the application, worker, PostgreSQL, and Caddy in Docker Compose. Caddy terminates HTTPS for a production self-hosted instance.
- Use Drizzle ORM with explicit SQL migrations. Do not add Redis; use a PostgreSQL jobs table with leases, attempts, run-after timestamps, and idempotency keys.
- Use GitHub OAuth App authorization-code flow with `state` and PKCE. Request `user:email` but no repository scopes. Revalidate the GitHub identity after every callback.
- Encrypt the GitHub access token before persistence using an application encryption key supplied outside the database.
- Import public Stars from GitHub's authenticated-user starring endpoint with pages of up to 100 and the star media type that includes `starred_at`.
- Model repositories globally and associate them with Users through Starred Repository records. Keep presentation state separate from GitHub repository metadata.
- A successful full sync stamps every observed Starred Repository with the current sync identifier. Only after every page succeeds may records not observed in the run become unstarred. A failed partial sync never marks records unstarred.
- Initial import runs as a background job. Weekly sync occurs before Digest preparation. Manual sync is limited to once per User per hour.
- An Eligible Repository must be active on GitHub, at least 30 days old, active in Rotation, and at or past its next eligible time.
- Selection orders never-presented repositories first, then repositories with the oldest presentation time, then oldest star time, with a stable tie-breaker. The MVP does not use AI or behavioral ranking.
- Generate and persist a Digest and its four default Digest Items before delivery. Enforce an idempotency key per User and scheduled Digest period.
- Still Interested sets the next eligible time to 90 days after action. Snooze sets it to 30 days. Done and Forget remove the repository from Rotation; Forget additionally hides it from the active view.
- Store Feedback Actions as append-only events while maintaining current Rotation state for efficient selection. Undo records a compensating event and restores the preceding state when valid.
- Email action links carry a signed, short-lived token bound to the User, Digest Item, intended action, nonce, and expiry. A GET validates and displays confirmation; a POST applies the action. Only one effective action may be recorded per Digest Item without Undo.
- Store User timezone as an IANA identifier. The default schedule is Monday at 09:00 local time. A scheduler checks due Users at a short fixed interval and computes the next UTC occurrence after each run.
- After three consecutive sent Digests without any Feedback Action, pause future Digests and send one pause notice. Any action resets the inactivity counter.
- Define one email interface with Resend and SMTP adapters. Development can use a capture server; provider-specific details do not enter domain behavior.
- Expose HTTP contracts for authentication, current User, sync status and trigger, active Resurfaced Repositories, Feedback Actions and Undo, settings, email action confirmation, and account deletion.
- Support multi-user ownership in every User-specific table, but omit public signup controls, teams, organizations, roles, and an admin UI.
- Publish under the MIT license.

## Testing Decisions

- Use one high application seam: exercise HTTP routes and scheduled-job entrypoints against a real PostgreSQL test container while substituting fake GitHub and Email adapters.
- Tests assert externally visible behavior—HTTP results, persisted User-visible state, selected Digest Items, and sent email intent—rather than ORM calls or private functions.
- Contract-test the GitHub adapter against representative paginated API fixtures, including `starred_at`, rate-limit responses, revoked tokens, and failure midway through a full sync.
- Verify the initial import and full-sync safety rule: no missing Starred Repository becomes unstarred until the full run succeeds.
- Verify selection boundaries at 30 days, ordering fairness, cooldowns, Done and Forget removal, unstar/reactivation, and Digest-size preferences.
- Verify scheduler behavior across timezones and daylight-saving transitions using a controlled clock.
- Verify Digest and job idempotency under retries and concurrent workers.
- Verify signed email token expiry, tampering, action mismatch, repeated submission, scanner-safe GET behavior, and Undo.
- Verify three inactive Digests pause delivery and that Feedback Action resets inactivity.
- Verify account deletion removes tokens and User-owned data.
- No prior test patterns exist because this is a greenfield repository; the first tracer ticket establishes the reusable application test harness.

## Out of Scope

- Private repositories and private Stars
- GitHub organizations or team accounts
- Telegram, Discord, mobile push, or browser notifications
- AI summaries, embeddings, semantic search, or personalized recommendation models
- Tags, folders, notes, full-text search, or bulk collection management
- Custom per-repository snooze durations
- More schedule choices than weekly delivery or paused delivery
- Admin dashboard, billing, subscriptions, invitations, and public growth features
- Hosted multi-tenant production service guarantees
- Writing star or unstar changes back to GitHub
- Importing bookmarks from services other than GitHub

## Further Notes

- The MVP targets GitHub power users with at least 50 Stars who already use email regularly.
- Product validation comes before ranking sophistication. If weekly action participation misses 25–30%, investigate selection, timing, and perceived value before adding AI or more notification channels.
- Open rate is supporting telemetry, not the primary success metric; email privacy features make it unreliable in isolation.
- Public-only access is an intentional MVP boundary. A later version may adopt a GitHub App with fine-grained permissions if real demand for private repositories appears.
