#!/bin/sh
# Starts the read-only CAO MCP server inside the container.
#
# The downloaded snapshot is mounted read-only at /data. SQLite needs a writable
# database handle even for reads, so the snapshot is copied into the container's
# own writable scratch directory at startup and the mounted evidence is never
# modified.
set -eu

snapshot="${CAO_DATABASE:-/data/gh-aw-logs.sqlite}"
runtime_database="${CAO_RUNTIME_DATABASE:-/tmp/cao/gh-aw-logs.sqlite}"
host="${CAO_MCP_HOST:-0.0.0.0}"
port="${CAO_MCP_PORT:-8443}"
certificate="${CAO_MCP_CERT:-/run/cao/tls.crt}"
key="${CAO_MCP_KEY:-/run/cao/tls.key}"

if [ ! -f "${snapshot}" ]; then
  echo "Error: CAO snapshot ${snapshot} is missing; mount it read-only at /data" >&2
  exit 1
fi

mkdir -p "$(dirname "${runtime_database}")"
cp "${snapshot}" "${runtime_database}"

set -- mcp \
  --database "${runtime_database}" \
  --host "${host}" \
  --port "${port}"

if [ -f "${certificate}" ] && [ -f "${key}" ]; then
  set -- "$@" --cert "${certificate}" --key "${key}"
elif [ "${host}" != "127.0.0.1" ] && [ "${host}" != "localhost" ] && [ "${host}" != "::1" ]; then
  echo "Error: TLS material is required to bind ${host}; mount ${certificate} and ${key} read-only at /run/cao" >&2
  exit 1
fi

exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /app/activity/cao.mjs "$@"
