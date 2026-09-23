#!/usr/bin/env bash

set -euo pipefail

policy_path=".github/workflows/cao.json"
cao_cli="activity/cao.mjs"
cao_command="./cao.sh"
control_runtime=".github/workflows/shared/control.mjs"
materializer=".github/workflows/shared/materialize-cao.mjs"
runtime_action=".github/actions/setup-cao-runtime/action.yml"
required_gh_aw="v0.89.20"
catalog_source="${1:-githubnext/gh-aw-cao}"

version_at_least() {
  node -e '
const parse = (value) => {
  const match = value.match(/^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) process.exit(2);
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || "" };
};
const [current, required] = process.argv.slice(1).map(parse);
for (let index = 0; index < 3; index += 1) {
  if (current.numbers[index] !== required.numbers[index]) {
    process.exit(current.numbers[index] > required.numbers[index] ? 0 : 1);
  }
}
if (current.prerelease === required.prerelease || !current.prerelease) process.exit(0);
process.exit(1);
' "$1" "$2"
}

current_gh_aw="$(gh aw version 2>/dev/null | awk '{print $NF}' || true)"
if [[ -z "$current_gh_aw" ]] || ! version_at_least "$current_gh_aw" "$required_gh_aw"; then
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh |
    bash -s -- "$required_gh_aw"
fi

if [[ ! -f "$cao_cli" || ! -f "$cao_command" || ! -f "$control_runtime" || ! -f "$materializer" || ! -f "$runtime_action" ]]; then
  gh aw add "$catalog_source"
elif [[ $# -gt 0 ]]; then
  gh aw add "$catalog_source" --force
fi
node "$materializer" materialize root

chmod +x "$cao_command"

if [[ ! -f "$policy_path" ]]; then
  "$cao_command" init
fi
