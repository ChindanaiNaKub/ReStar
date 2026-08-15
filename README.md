# ReStar

ReStar turns GitHub Stars from passive bookmarks into an active memory system.
It is a self-hostable MVP: Next.js, PostgreSQL, a scheduled worker, and Caddy
run as one Docker Compose deployment.

## Quick start

Requirements: Node.js 22+, pnpm 11, Docker, and Docker Compose.

```sh
cp .env.example .env
openssl rand -base64 32 # put one value in GITHUB_TOKEN_ENCRYPTION_KEY
openssl rand -base64 32 # put a different value in EMAIL_ACTION_TOKEN_SECRET
pnpm install
docker compose up --build
```

Create a GitHub OAuth App with callback URL
`https://<APP_DOMAIN>/api/auth/github/callback`. ReStar requests only
`user:email` and imports public Stars; it never requests private repository
access. Configure either Resend or standard SMTP in `.env` before using
Digest delivery. Open `APP_URL` after the stack is healthy.

The complete deployment, migration, HTTPS, backup, and smoke-test procedure is
in [docs/OPERATIONS.md](docs/OPERATIONS.md). Data handling, account deletion,
and the security boundary are in [docs/SECURITY.md](docs/SECURITY.md).

## Development

For host-based development, start PostgreSQL, migrate, then run the web and
worker in separate terminals:

```sh
docker compose up --detach database
pnpm db:migrate
pnpm dev
pnpm worker
```

Run the checks used by CI and releases:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
docker compose config --quiet
```

Tests use disposable PostgreSQL containers and require a working Docker daemon.
Contributor workflow is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

ReStar is available under the [MIT License](LICENSE).
