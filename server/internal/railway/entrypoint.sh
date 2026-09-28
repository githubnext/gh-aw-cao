#!/bin/sh
set -eu

: "${CAO_PUBLIC_HOST:?CAO_PUBLIC_HOST is required}"
: "${CAO_GITHUB_CLIENT_ID:?CAO_GITHUB_CLIENT_ID is required}"
: "${CAO_GITHUB_CLIENT_SECRET:?CAO_GITHUB_CLIENT_SECRET is required}"
: "${CAO_SESSION_SECRET:?CAO_SESSION_SECRET is required}"
: "${CAO_GITHUB_ADMIN_USERS:?CAO_GITHUB_ADMIN_USERS is required}"
: "${CAO_GITHUB_WEBHOOK_SECRET:?CAO_GITHUB_WEBHOOK_SECRET is required}"
: "${REDIS_URL:?REDIS_URL is required}"

export CAO_ALLOWED_HOSTS="${CAO_ALLOWED_HOSTS:-${CAO_PUBLIC_HOST}}"
export CAO_GITHUB_REDIRECT_URL="${CAO_GITHUB_REDIRECT_URL:-https://${CAO_PUBLIC_HOST}/auth/callback}"
export CAO_TRUSTED_PROXY_CIDRS="127.0.0.0/8,::1/128"
export PORT="${PORT:-8080}"

caddy run --config /app/Caddyfile --adapter caddyfile &
proxy_pid=$!

/app/cao-dashboard serve-hosted \
  --listen 127.0.0.1:8081 \
  --site /app/site \
  --dashboard-queries /app/dashboard.json \
  --database-queries /app/queries/database.json &
dashboard_pid=$!

shutdown() {
  kill "${proxy_pid}" "${dashboard_pid}" 2>/dev/null || true
  wait "${proxy_pid}" "${dashboard_pid}" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

while kill -0 "${proxy_pid}" 2>/dev/null && kill -0 "${dashboard_pid}" 2>/dev/null; do
  sleep 1
done

exit 1
