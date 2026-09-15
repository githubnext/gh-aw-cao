#!/usr/bin/env bash

set -euo pipefail

policy_path=".github/workflows/cao.json"
cao_cli=".github/aw/activity/cao.mjs"
control_runtime=".github/workflows/shared/control.mjs"

if ! gh aw version >/dev/null 2>&1; then
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh |
    bash
fi

if [[ -f "$policy_path" && -f "$cao_cli" && -f "$control_runtime" ]]; then
  exit 0
fi

if [[ ! -f "$cao_cli" || ! -f "$control_runtime" ]]; then
  gh aw add githubnext/gh-aw-cao
fi

if [[ ! -f "$policy_path" ]]; then
  node "$cao_cli" init
fi
