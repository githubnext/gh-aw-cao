#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$root/activity/cao.mjs" ]]; then
  cli="$root/activity/cao.mjs"
else
  echo "cao CLI is unavailable; install the Central Agentic Ops root package." >&2
  exit 1
fi

exec node "$cli" "$@"
