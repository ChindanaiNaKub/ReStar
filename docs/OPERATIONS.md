# Self-hosting and operations

## First deployment

1. Install Docker Engine with Compose, choose a DNS name, and create a GitHub
   OAuth App. Set its callback to
   `https://APP_DOMAIN/api/auth/github/callback`.
2. Copy `.env.example` to `.env`. Set `APP_DOMAIN`, `APP_URL`, the GitHub
   client credentials, a generated 32-byte
   `GITHUB_TOKEN_ENCRYPTION_KEY`, a different
   `EMAIL_ACTION_TOKEN_SECRET`, and `EMAIL_FROM`.
3. Choose `EMAIL_PROVIDER=resend` with `RESEND_API_KEY`, or
   `EMAIL_PROVIDER=smtp` with `SMTP_HOST`, `SMTP_PORT`, optional credentials,
   and `SMTP_SECURE=true` when required by the server.
4. Change `POSTGRES_PASSWORD`. Keep `.env` private and make sure `APP_URL`
   uses the public HTTPS origin.
5. Start the stack and apply migrations:

   ```sh
   docker compose up --build --detach
   docker compose ps
   curl --fail --insecure "$APP_URL/api/health"
   ```

   The `migrate` service runs before the app and worker. Caddy terminates HTTPS
   and proxies the app; replace its local certificate behavior with a trusted
   DNS-backed certificate in production.

## Upgrade and rollback

Pull the new source, review `drizzle/` migrations, then run
`docker compose up --build --detach`. Compose applies migrations before the new
app and worker become ready. Keep the previous image available until the
health check and worker logs show the new version is running. Take a backup
before upgrades; application rollback cannot safely undo an already-applied
schema migration without a separately tested down plan.

## Encrypted backups

Stop writes or use a database-consistent snapshot, then encrypt the dump before
leaving the host. For example, with `age` installed:

```sh
docker compose exec -T database pg_dump -U restar -d restar \
  | age -r "$BACKUP_AGE_RECIPIENT" > "restar-$(date -u +%Y%m%dT%H%M%SZ).sql.age"
```

Restore only into a trusted database after testing the procedure:

```sh
age -d -i "$BACKUP_AGE_IDENTITY" restar-backup.sql.age \
  | docker compose exec -T database psql -U restar -d restar
```

Backups contain encrypted GitHub credentials and personal data. Store the
database backup key separately from `GITHUB_TOKEN_ENCRYPTION_KEY`, and test a
restore on a disposable instance.

## Health, worker, and email checks

`GET /api/health` checks the web process and database connection. The worker
emits a structured `worker.cycle` event every cycle; inspect it with
`docker compose logs worker`. A failed import or Digest retains a retry/failed
status and a redacted diagnostic for the User or operator. Email provider
configuration is validated when a delivery job runs.

Run the clean-machine smoke test after configuring `.env`:

```sh
./scripts/smoke-production.sh
```

It validates login prerequisites and email settings, renders the Compose
configuration, starts the production services, checks health, confirms the
worker executes, and prints the OAuth callback prerequisite.
