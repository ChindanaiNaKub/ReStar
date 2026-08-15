# Contributing to ReStar

ReStar is a self-hostable TypeScript monolith. Keep changes small, use the
domain terms in [CONTEXT.md](CONTEXT.md), and update the relevant ADR or
operator documentation when a decision changes.

## Development

Install Node.js 22+, pnpm 11, Docker, and Docker Compose. Copy `.env.example`
to `.env`, configure GitHub OAuth and email, then run:

```sh
pnpm install
docker compose up --build
```

Before opening a pull request, run `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm build`, and `docker compose config --quiet`. The tests use disposable
PostgreSQL containers, so Docker must be running.

## Changes and tests

Test behavior at HTTP or scheduled-worker seams. Pure helper tests are also
appropriate for security invariants such as redaction and cryptography. Add a
focused regression test with a feature or bug fix, then run the complete suite
before handing off.
Never commit `.env`, credentials, access tokens, generated build output, or
database dumps. Pull requests should explain operational or migration impact.

Security issues should not be opened as public bug reports; follow
[SECURITY.md](docs/SECURITY.md).
