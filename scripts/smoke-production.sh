#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ ! -f .env ]]; then
  echo "Create .env from .env.example before running the production smoke test." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ./.env
set +a

required=(APP_DOMAIN APP_URL POSTGRES_PASSWORD GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_TOKEN_ENCRYPTION_KEY EMAIL_ACTION_TOKEN_SECRET EMAIL_PROVIDER EMAIL_FROM)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required setting: $name" >&2
    exit 1
  fi
done

case "$EMAIL_PROVIDER" in
  resend)
    [[ -n "${RESEND_API_KEY:-}" ]] || { echo "RESEND_API_KEY is required for Resend." >&2; exit 1; }
    curl --fail --silent --show-error \
      -H "Authorization: Bearer ${RESEND_API_KEY}" \
      https://api.resend.com/domains >/dev/null
    ;;
  smtp)
    [[ -n "${SMTP_HOST:-}" ]] || { echo "SMTP_HOST is required for SMTP." >&2; exit 1; }
    timeout 10 bash -c "</dev/tcp/${SMTP_HOST}/${SMTP_PORT:-587}"
    ;;
  *)
    echo "EMAIL_PROVIDER must be resend or smtp." >&2
    exit 1
    ;;
esac

docker compose config --quiet
cleanup() { docker compose down --remove-orphans; }
trap cleanup EXIT
docker compose up --build --detach database migrate app worker caddy

for _ in {1..30}; do
  if curl --fail --silent --show-error --insecure "${APP_URL%/}/api/health" | grep -q '"status":"ok"'; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error --insecure "${APP_URL%/}/api/health" | grep -q '"status":"ok"'

docker compose ps --status running app worker caddy
for _ in {1..30}; do
  if docker compose logs --no-color --tail=200 worker 2>&1 | grep -q '"event":"worker.cycle"'; then
    break
  fi
  sleep 1
done
docker compose logs --no-color --tail=200 worker 2>&1 | grep -q '"event":"worker.cycle"'

echo "Production smoke test passed."
echo "GitHub OAuth callback: https://${APP_DOMAIN}/api/auth/github/callback"
echo "Email provider configured: ${EMAIL_PROVIDER}"
