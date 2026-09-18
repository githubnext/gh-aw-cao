#!/bin/sh
set -eu

root="$(CDPATH= cd -P "$(dirname "$0")" && pwd)"

if [ -f "$root/activity/cao.mjs" ]; then
  cli="$root/activity/cao.mjs"
else
  echo "cao CLI is unavailable; install the Central Agentic Ops root campaign." >&2
  exit 1
fi

exec node "$cli" "$@"
