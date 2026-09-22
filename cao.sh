#!/bin/sh
set -eu

root="$(CDPATH= cd -P "$(dirname "$0")" && pwd)"

cli="$root/activity/cao.mjs"
if [ ! -f "$cli" ]; then
  echo "cao CLI is unavailable; install the Central Agentic Ops root campaign." >&2
  exit 1
fi

exec node "$cli" "$@"
