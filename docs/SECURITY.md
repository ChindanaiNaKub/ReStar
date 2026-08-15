# Security and privacy

## What ReStar stores

For each User, ReStar stores the GitHub numeric identity, login, optional
personal email and avatar URL returned by OAuth, an opaque first-party session,
Digest preferences, import and job status, Digest and Digest Item history,
Rotation state, and append-only Feedback Action history. The GitHub access
token is encrypted at rest with `GITHUB_TOKEN_ENCRYPTION_KEY`; OAuth state and
session values are stored as SHA-256 hashes. Short-lived email-action records
contain a nonce and its hash, action, expiry, and single-use state; the signed
link itself is not stored.

OAuth transactions also retain a PKCE verifier, browser-nonce hash, and expiry
until the callback completes. Import records retain sync type, sync token,
page and repository counts, status, redacted failure text, and timestamps.
Starred Repository associations retain the original star time, sync marker,
and association timestamps. Job records retain kind, JSON payload, optional
idempotency key, status, run-after and lease fields, attempt limits and count,
redacted failure text, completion time, and creation time. Payloads contain
only internal identifiers and scheduling values, not access tokens or email
content.

ReStar also stores public GitHub repository metadata needed to display a
Starred Repository: owner, name, description, language, public star count,
GitHub URL, and star timestamp. Repository metadata is global so it may remain
after one User leaves when another User still references it.

ReStar requests only the `user:email` OAuth scope and imports only public Stars.
It does not request repository access, import private repositories, modify
GitHub Stars, or store GitHub passwords.

## Leaving ReStar

Settings provides account deletion after the User types `DELETE`. The
transaction removes the User, encrypted GitHub credential, sessions, settings,
imports, Digests and Digest Items, email-action records, Rotation state,
Feedback history, Starred Repository associations, and queued jobs belonging to
that User. Shared public repository metadata is not personal account data.

## Operational protections

Structured logs redact authorization headers, cookies, tokens, signed action
URL query values, and email addresses. Persisted job and import diagnostics use
the same redaction boundary and are truncated. Keep `.env` outside version
control, use HTTPS in production, keep both encryption/signing secrets stable,
and restrict database backups to trusted operators.

Report a suspected vulnerability privately to the repository maintainers. Do
not include live tokens, signed links, or personal email addresses in a report.
