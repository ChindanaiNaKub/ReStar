# ReStar

ReStar turns GitHub Stars from passive bookmarks into an active memory system. It is an early, self-hostable MVP under active development.

## Development

Requirements: Node.js 22+, pnpm 11, Docker, and Docker Compose.

```sh
cp .env.example .env
# Fill in the GitHub OAuth credentials and generate GITHUB_TOKEN_ENCRYPTION_KEY.
pnpm install
docker compose up --build
```

Open `https://localhost`. Caddy uses a local certificate for the default local domain, so the browser may require local trust configuration.

Create a GitHub OAuth App with callback URL `https://<APP_DOMAIN>/api/auth/github/callback`. ReStar requests only `user:email`, never a repository scope. Keep `GITHUB_TOKEN_ENCRYPTION_KEY` stable after Users sign in; changing it makes stored GitHub tokens unreadable.

Run checks directly:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
docker compose config --quiet
```

Application tests start isolated PostgreSQL containers and therefore require a working Docker daemon.

For host-based development, start only PostgreSQL, apply migrations, then run the web and worker processes in separate terminals:

```sh
docker compose up --detach database
pnpm db:migrate
pnpm dev
pnpm worker
```

The Compose database port binds to `127.0.0.1` only. `DATABASE_URL` in `.env` must use the same password and `POSTGRES_PORT` values as the database service.

## Architecture

- Next.js serves the web application and HTTP routes.
- PostgreSQL stores durable application and job state.
- A worker built from the same source image claims scheduled jobs from PostgreSQL.
- Caddy terminates HTTPS and proxies to the application.

See [the MVP spec](docs/specs/restar-mvp.md), [domain language](CONTEXT.md), and [architectural decisions](docs/adr/).
