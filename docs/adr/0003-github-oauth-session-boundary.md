# Keep GitHub OAuth and sessions inside the monolith

ReStar implements its narrow GitHub OAuth and session boundary directly instead of adding a general authentication framework. The application needs one identity provider, server-held OAuth transactions with state and PKCE, opaque first-party sessions, and encrypted GitHub credentials for background jobs. Keeping these records in PostgreSQL preserves the self-hosted monolith and lets the worker use the same durable identity boundary.

OAuth state and session tokens are random values stored only as SHA-256 hashes. GitHub access tokens are encrypted with AES-256-GCM under an operator-supplied key before persistence. Cookies are HTTP-only, SameSite=Lax, scoped narrowly where possible, and secure on HTTPS. Routes revalidate GitHub identity at every callback and never log credentials.

This choice carries maintenance responsibility. Security-sensitive changes require application-seam tests and review; key rotation and global session revocation are not yet automated. ReStar should reconsider a maintained authentication library if it adds another provider, more session policy, or hosted multi-tenant requirements.
