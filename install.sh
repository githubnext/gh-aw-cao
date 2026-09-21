#!/usr/bin/env bash

set -euo pipefail

policy_path=".github/workflows/cao.json"
cao_cli=".github/aw/activity/cao.mjs"
cao_source=".github/aw/cao.sh"
cao_command="./cao.sh"
control_runtime=".github/workflows/shared/control.mjs"

if ! gh aw version >/dev/null 2>&1; then
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh |
    bash
fi

if [[ ! -f "$cao_cli" || ! -f "$cao_source" || ! -f "$control_runtime" ]]; then
  gh aw add githubnext/gh-aw-cao
fi

cp "$cao_source" "$cao_command"
chmod +x "$cao_command"

if [[ ! -f "$policy_path" ]]; then
  "$cao_command" init
fi
