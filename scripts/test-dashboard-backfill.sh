#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
else
  compose=(docker-compose)
fi
project="cao-backfill-$(openssl rand -hex 6)"
compose+=(-p "$project" -f server/backfill-compose.yml)
export CAO_LOCAL_POSTGRES_PASSWORD
export CAO_LOCAL_OTEL_EMAIL=backfill@example.test
export CAO_LOCAL_OTEL_PASSWORD
CAO_LOCAL_POSTGRES_PASSWORD=$(openssl rand -hex 16)
CAO_LOCAL_OTEL_PASSWORD="Aa1!$(openssl rand -hex 16)"

report_dir="${CAO_BACKFILL_REPORT_DIR:-.tmp/go-backfill}"
mkdir -p "$report_dir"
cleanup() {
  status=$?
  trap - EXIT
  if ! "${compose[@]}" logs --no-color > "$report_dir/services.log" 2>&1; then
    echo "Could not collect backfill service logs" >&2
    status=1
  fi
  if ! "${compose[@]}" down --volumes --remove-orphans; then
    echo "Could not remove the isolated backfill services" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up -d --wait --wait-timeout 120

redis_address=$("${compose[@]}" port redis 6379)
postgres_address=$("${compose[@]}" port postgres 5432)
observe_address=$("${compose[@]}" port openobserve 5080)
export REDIS_URL="redis://$redis_address/0"
export CAO_POSTGRES_URL="postgres://cao_backfill:$CAO_LOCAL_POSTGRES_PASSWORD@$postgres_address/cao_backfill?sslmode=disable"
export CAO_BACKFILL_OPENOBSERVE_URL="http://$observe_address"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="$CAO_BACKFILL_OPENOBSERVE_URL/api/default/v1/traces"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="$CAO_BACKFILL_OPENOBSERVE_URL/api/default/v1/metrics"
export OTEL_EXPORTER_OTLP_HEADERS
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$(printf '%s' "$CAO_LOCAL_OTEL_EMAIL:$CAO_LOCAL_OTEL_PASSWORD" | base64 | tr -d '\n')"
export CAO_BACKFILL_INTEGRATION=1

ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --fail --silent --output /dev/null "$CAO_BACKFILL_OPENOBSERVE_URL/healthz"; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "OpenObserve did not become ready" >&2
  exit 1
fi

go -C server test ./internal/server -run '^TestPostgresBackfillIntegration$' \
  -count=1 -timeout=5m -v 2>&1 | tee "$report_dir/go-test.txt"
