# ReStar

ReStar turns GitHub Stars from passive bookmarks into an active memory system. It is an early, self-hostable MVP under active development.

## Development

Requirements: Node.js 22+, pnpm 11, Docker, and Docker Compose.

```sh
cp .env.example .env
pnpm install
docker compose up --build
```

Open `https://localhost`. Caddy uses a local certificate for the default local domain, so the browser may require local trust configuration.

Run checks directly:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
docker compose config --quiet
```

Application tests start isolated PostgreSQL containers and therefore require a working Docker daemon.

## Architecture

- Next.js serves the web application and HTTP routes.
- PostgreSQL stores durable application and job state.
- A worker built from the same source image claims scheduled jobs from PostgreSQL.
- Caddy terminates HTTPS and proxies to the application.

See [the MVP spec](docs/specs/restar-mvp.md), [domain language](CONTEXT.md), and [architectural decisions](docs/adr/).
