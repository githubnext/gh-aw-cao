#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${AZURE_LOCAL_STATE_DIR:-"$ROOT/.tmp/azure-local/default"}"
LOG_DIR="$STATE_DIR/logs"
APP_DIR="$STATE_DIR/function-app"
RUNTIME_ENV="$STATE_DIR/runtime.env"
RUNTIME_JSON="$STATE_DIR/runtime.json"
HARNESS_VERSION=1
CORE_TOOLS_VERSION=4.15.1
CORE_TOOLS_SHA256=9b982efb4047c717c9b1c26beb2269c2ac41b29bf8d21f4df1130c1586cc81cd
REDIS_IMAGE=redis:7.4.7-alpine
AZURITE_IMAGE=mcr.microsoft.com/azure-storage/azurite:3.37.0
WAIT_TIMEOUT="${AZURE_LOCAL_WAIT_TIMEOUT:-120}"

fail() {
  printf 'azure-local: %s\n' "$*" >&2
  exit 1
}

require_linux() {
  [[ "$(uname -s)" == Linux ]] || fail "this harness supports Linux only"
}

require_commands() {
  local command
  for command in curl docker go node npm python3 setsid sha256sum unzip; do
    command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
  done
  docker info >/dev/null 2>&1 || fail "Docker is not available"
}

load_runtime() {
  [[ -f "$RUNTIME_ENV" ]] || fail "no harness state found at $STATE_DIR; run start first"
  # shellcheck disable=SC1090
  source "$RUNTIME_ENV"
}

write_env_value() {
  printf '%s=%q\n' "$1" "$2" >>"$RUNTIME_ENV"
}

free_port() {
  python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    print(listener.getsockname()[1])
PY
}

container_port() {
  docker port "$1" "$2/tcp" | awk -F: 'END { print $NF }'
}

install_core_tools() {
  local tools_dir archive
  tools_dir="$ROOT/.tmp/azure-local/tools/core-tools-$CORE_TOOLS_VERSION"
  if [[ -x "$tools_dir/func" ]]; then
    FUNC_BIN="$tools_dir/func"
    return
  fi
  mkdir -p "$tools_dir"
  archive="$tools_dir/core-tools.zip"
  curl -fsSL \
    "https://github.com/Azure/azure-functions-core-tools/releases/download/$CORE_TOOLS_VERSION/Azure.Functions.Cli.linux-x64.$CORE_TOOLS_VERSION.zip" \
    -o "$archive"
  printf '%s  %s\n' "$CORE_TOOLS_SHA256" "$archive" | sha256sum --check --status ||
    fail "Azure Functions Core Tools checksum verification failed"
  unzip -q -o "$archive" -d "$tools_dir"
  chmod +x "$tools_dir/func"
  rm -f "$archive"
  FUNC_BIN="$tools_dir/func"
}

capture_container_logs() {
  local id name
  id="$1"
  name="$2"
  if [[ -n "$id" ]] && docker inspect "$id" >/dev/null 2>&1; then
    docker logs "$id" >"$LOG_DIR/$name.log" 2>&1 || true
  fi
}

stop_internal() {
  mkdir -p "$LOG_DIR"
  if [[ -f "$RUNTIME_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$RUNTIME_ENV"
  fi
  if [[ -n "${FUNCTIONS_PID:-}" ]] && kill -0 "$FUNCTIONS_PID" 2>/dev/null; then
    kill -TERM -- "-$FUNCTIONS_PID" 2>/dev/null || kill -TERM "$FUNCTIONS_PID" 2>/dev/null || true
    for _ in {1..50}; do
      kill -0 "$FUNCTIONS_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$FUNCTIONS_PID" 2>/dev/null || true
  fi
  capture_container_logs "${AZURITE_CONTAINER_ID:-}" azurite
  capture_container_logs "${REDIS_CONTAINER_ID:-}" redis
  [[ -z "${AZURITE_CONTAINER_ID:-}" ]] || docker rm -f "$AZURITE_CONTAINER_ID" >/dev/null 2>&1 || true
  [[ -z "${REDIS_CONTAINER_ID:-}" ]] || docker rm -f "$REDIS_CONTAINER_ID" >/dev/null 2>&1 || true
  rm -f "$STATE_DIR/functions.pid" "$STATE_DIR/azurite.container" "$STATE_DIR/redis.container"
}

poll() {
  local label command_text deadline
  label="$1"
  command_text="$2"
  deadline=$((SECONDS + WAIT_TIMEOUT))
  while (( SECONDS < deadline )); do
    if eval "$command_text" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'azure-local: timed out waiting for %s\n' "$label" >&2
  logs >&2 || true
  return 1
}

prepare_application() {
  mkdir -p "$APP_DIR/site" "$LOG_DIR"
  if [[ ! -d "$ROOT/dashboard/site/node_modules" ]]; then
    npm --prefix "$ROOT/dashboard/site" ci >"$LOG_DIR/npm-install.log" 2>&1
  fi
  node "$ROOT/dashboard/site/scripts/build.mjs" \
    "$APP_DIR/site" "$ROOT/.github/workflows/cao.json" >"$LOG_DIR/dashboard-build.log" 2>&1
  go -C "$ROOT/server" build -o "$APP_DIR/cao-functions" ./cmd/cao-functions \
    >"$LOG_DIR/functions-build.log" 2>&1
  go -C "$ROOT/server" build -o "$APP_DIR/cao-dashboard" ./cmd/cao-dashboard \
    >"$LOG_DIR/server-build.log" 2>&1
  cat >"$APP_DIR/host.json" <<'JSON'
{
  "version": "2.0",
  "customHandler": {
    "description": {
      "defaultExecutablePath": "cao-functions"
    },
    "enableForwardingHttpRequest": true
  },
  "extensions": {
    "http": {
      "routePrefix": ""
    }
  }
}
JSON
  mkdir -p "$APP_DIR/cao"
  cat >"$APP_DIR/cao/function.json" <<'JSON'
{
  "bindings": [
    {
      "authLevel": "anonymous",
      "direction": "in",
      "methods": ["delete", "get", "head", "options", "patch", "post", "put"],
      "name": "request",
      "route": "{*path}",
      "type": "httpTrigger"
    },
    {
      "direction": "out",
      "name": "$return",
      "type": "http"
    }
  ]
}
JSON
}

start() {
  require_linux
  require_commands
  mkdir -p "$STATE_DIR" "$LOG_DIR"
  if [[ -f "$RUNTIME_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$RUNTIME_ENV"
    if [[ "${STATE_HARNESS_VERSION:-}" == "$HARNESS_VERSION" ]] &&
      [[ -n "${FUNCTIONS_PID:-}" ]] && kill -0 "$FUNCTIONS_PID" 2>/dev/null; then
      printf 'azure-local: matching stack is already running at %s\n' "$STATE_DIR"
      return
    fi
    stop_internal
  fi

  : >"$RUNTIME_ENV"
  trap 'stop_internal' EXIT
  local run_id redis_name azurite_name function_port redis_port blob_port queue_port table_port namespace
  local azurite_account azurite_key
  run_id="$(basename "$STATE_DIR" | tr -cd 'a-zA-Z0-9_.-' | cut -c1-40)"
  [[ -n "$run_id" ]] || run_id="run-$$"
  redis_name="cao-azure-local-$run_id-redis"
  azurite_name="cao-azure-local-$run_id-azurite"
  namespace="azure-local-$(printf '%s' "$STATE_DIR" | sha256sum | cut -c1-16)"
  azurite_account="caoazurelocal"
  azurite_key="$(python3 -c 'import base64,hashlib; print(base64.b64encode(hashlib.sha256(b"cao-azure-local").digest()).decode())')"

  REDIS_CONTAINER_ID="$(docker run -d --name "$redis_name" -p 127.0.0.1::6379 "$REDIS_IMAGE")"
  write_env_value STATE_HARNESS_VERSION "$HARNESS_VERSION"
  write_env_value REDIS_CONTAINER_ID "$REDIS_CONTAINER_ID"
  printf '%s\n' "$REDIS_CONTAINER_ID" >"$STATE_DIR/redis.container"
  redis_port="$(container_port "$REDIS_CONTAINER_ID" 6379)"

  AZURITE_CONTAINER_ID="$(docker run -d --name "$azurite_name" \
    -p 127.0.0.1::10000 -p 127.0.0.1::10001 -p 127.0.0.1::10002 \
    -e "AZURITE_ACCOUNTS=$azurite_account:$azurite_key" \
    "$AZURITE_IMAGE" azurite --blobHost 0.0.0.0 --queueHost 0.0.0.0 \
    --tableHost 0.0.0.0 --location /data --debug /data/debug.log)"
  write_env_value AZURITE_CONTAINER_ID "$AZURITE_CONTAINER_ID"
  printf '%s\n' "$AZURITE_CONTAINER_ID" >"$STATE_DIR/azurite.container"
  blob_port="$(container_port "$AZURITE_CONTAINER_ID" 10000)"
  queue_port="$(container_port "$AZURITE_CONTAINER_ID" 10001)"
  table_port="$(container_port "$AZURITE_CONTAINER_ID" 10002)"
  function_port="$(free_port)"

  write_env_value REDIS_PORT "$redis_port"
  write_env_value AZURITE_BLOB_PORT "$blob_port"
  write_env_value AZURITE_QUEUE_PORT "$queue_port"
  write_env_value AZURITE_TABLE_PORT "$table_port"
  write_env_value FUNCTIONS_PORT "$function_port"
  write_env_value REDIS_NAMESPACE "$namespace"

  prepare_application
  install_core_tools
  write_env_value FUNC_BIN "$FUNC_BIN"
  poll Redis "docker exec '$REDIS_CONTAINER_ID' redis-cli ping | grep -qx PONG"
  poll Azurite "status=\$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$blob_port/$azurite_account?comp=list'); [[ \$status -lt 500 ]]"

  "$APP_DIR/cao-dashboard" ingest \
    --source "$ROOT/server/testdata/deployed-subset" \
    --redis-url "redis://127.0.0.1:$redis_port/0" \
    --redis-namespace "$namespace" \
    --database-queries "$ROOT/dashboard/site/src/data/queries/database.json" \
    >"$LOG_DIR/ingest.log" 2>&1

  local storage_connection
  storage_connection="DefaultEndpointsProtocol=http;AccountName=$azurite_account;AccountKey=$azurite_key;BlobEndpoint=http://127.0.0.1:$blob_port/$azurite_account;QueueEndpoint=http://127.0.0.1:$queue_port/$azurite_account;TableEndpoint=http://127.0.0.1:$table_port/$azurite_account;"
  cat >"$APP_DIR/local.settings.json" <<JSON
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "custom",
    "AzureWebJobsStorage": "$storage_connection",
    "CAO_AZURE_ALLOWED_HOSTS": "127.0.0.1,localhost",
    "CAO_AZURE_LOCAL_SIMULATION": "1",
    "CAO_GITHUB_ALLOWED_ORGS": "example",
    "CAO_GITHUB_CLIENT_ID": "local-client",
    "CAO_GITHUB_CLIENT_SECRET": "local-client-secret",
    "CAO_GITHUB_REDIRECT_URL": "http://127.0.0.1:$function_port/auth/callback",
    "CAO_REDIS_NAMESPACE": "$namespace",
    "CAO_REDIS_URL": "redis://127.0.0.1:$redis_port/0",
    "CAO_SESSION_SECRET": "local-simulation-session-secret-0000000000000000",
    "OTEL_SDK_DISABLED": "true"
  }
}
JSON
  cat >"$RUNTIME_JSON" <<JSON
{
  "stateDirectory": "$STATE_DIR",
  "applicationDirectory": "$APP_DIR",
  "baseUrl": "http://127.0.0.1:$function_port",
  "redisContainerId": "$REDIS_CONTAINER_ID",
  "redisNamespace": "$namespace"
}
JSON

  (
    cd "$APP_DIR"
    setsid "$FUNC_BIN" start --port "$function_port" --verbose >"$LOG_DIR/functions.log" 2>&1 &
    FUNCTIONS_PID=$!
    printf '%s\n' "$FUNCTIONS_PID" >"$STATE_DIR/functions.pid"
    write_env_value FUNCTIONS_PID "$FUNCTIONS_PID"
  )
  trap - EXIT
  printf 'azure-local: started stack at %s\n' "$STATE_DIR"
}

wait_for_stack() {
  load_runtime
  poll Redis "docker exec '$REDIS_CONTAINER_ID' redis-cli ping | grep -qx PONG"
  poll Azurite "status=\$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$AZURITE_BLOB_PORT/'); [[ \$status -lt 500 ]]"
  poll "Azure Functions host" "curl -fsS 'http://127.0.0.1:$FUNCTIONS_PORT/api/readiness'"
  printf 'azure-local: stack is ready\n'
}

test_stack() {
  load_runtime
  set +e
  node "$ROOT/tests/integration/azure-local-functions.test.mjs" "$RUNTIME_JSON" \
    > >(tee "$LOG_DIR/integration-test.log") 2>&1
  local status=$?
  set -e
  return "$status"
}

logs() {
  mkdir -p "$LOG_DIR"
  if [[ -f "$RUNTIME_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$RUNTIME_ENV"
    capture_container_logs "${AZURITE_CONTAINER_ID:-}" azurite
    capture_container_logs "${REDIS_CONTAINER_ID:-}" redis
  fi
  local file
  for file in "$LOG_DIR"/*.log; do
    [[ -e "$file" ]] || continue
    printf '\n===== %s =====\n' "$(basename "$file")"
    cat "$file"
  done
  printf '\nazure-local: logs retained at %s\n' "$LOG_DIR"
}

stop() {
  stop_internal
  printf 'azure-local: stopped stack; logs retained at %s\n' "$LOG_DIR"
}

run_all() {
  if [[ -z "${AZURE_LOCAL_STATE_DIR:-}" ]]; then
    STATE_DIR="$ROOT/.tmp/azure-local/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    LOG_DIR="$STATE_DIR/logs"
    APP_DIR="$STATE_DIR/function-app"
    RUNTIME_ENV="$STATE_DIR/runtime.env"
    RUNTIME_JSON="$STATE_DIR/runtime.json"
  fi
  trap 'status=$?; trap - EXIT INT TERM; stop_internal; exit "$status"' EXIT INT TERM
  start
  wait_for_stack
  test_stack
}

case "${1:-}" in
  start) start ;;
  wait) wait_for_stack ;;
  test) test_stack ;;
  logs) logs ;;
  stop) stop ;;
  run) run_all ;;
  *) fail "usage: $0 {start|wait|test|logs|stop|run}" ;;
esac
