#!/usr/bin/env bash

set -euo pipefail

policy_path=".github/workflows/cao.json"
cao_cli="activity/cao.mjs"
cao_command="./cao.sh"
control_runtime=".github/workflows/shared/control.mjs"
materializer=".github/workflows/shared/materialize-cao.mjs"
runtime_action=".github/actions/setup-cao-runtime/action.yml"
required_gh_aw="v0.89.21"
catalog_source="${1:-githubnext/gh-aw-cao}"

if [[ "$catalog_source" == "githubnext/gh-aw-cao" && -f aw.yml ]]; then
  manifest_required_gh_aw="$(awk '$1 == "min-version:" { print $2; exit }' aw.yml)"
  if [[ -n "$manifest_required_gh_aw" ]]; then
    required_gh_aw="$manifest_required_gh_aw"
  fi
fi

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

install_gh_aw() {
  curl --fail --silent --show-error --location \
    https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh |
    bash -s -- "$required_gh_aw"
}

get_gh_aw_version() {
  gh aw version 2>/dev/null |
    awk 'match($0, /v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/) {
      print substr($0, RSTART, RLENGTH)
      exit
    }' || true
}

verify_gh_aw_version() {
  local current_version
  current_version="$(get_gh_aw_version)"
  if [[ -z "$current_version" ]] || ! version_at_least "$current_version" "$required_gh_aw"; then
    printf 'Failed to verify gh-aw installation: expected at least %s, got %s.\n' \
      "$required_gh_aw" "${current_version:-no version}" >&2
    return 1
  fi
}

upgrade_gh_aw() {
  local answer
  local upgrade_command="curl -sL https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- $required_gh_aw"
  if [[ -r /dev/tty ]]; then
    printf 'The installed gh-aw is too old for this CAO campaign. Upgrade it now with %s? [y/N] ' "$upgrade_command" > /dev/tty
    if IFS= read -r answer < /dev/tty && [[ "$answer" =~ ^[Yy]$ ]]; then
      if install_gh_aw; then
        return 0
      fi
      printf 'Failed to install gh-aw %s.\n' "$required_gh_aw" >&2
      return 1
    fi
  fi
  printf 'gh-aw was not upgraded. Run `%s`, then rerun the CAO installer.\n' "$upgrade_command"
  return 2
}

current_gh_aw="$(get_gh_aw_version)"
if [[ -z "$current_gh_aw" ]]; then
  install_gh_aw
  verify_gh_aw_version
elif ! version_at_least "$current_gh_aw" "$required_gh_aw"; then
  if upgrade_gh_aw; then
    verify_gh_aw_version
  else
    upgrade_status=$?
    if [[ "$upgrade_status" -eq 2 ]]; then
      exit 0
    fi
    exit "$upgrade_status"
  fi
fi

add_campaign() {
  gh aw add "$catalog_source" "$@"
}

if [[ ! -f "$cao_cli" || ! -f "$cao_command" || ! -f "$control_runtime" || ! -f "$materializer" || ! -f "$runtime_action" ]]; then
  add_campaign
elif [[ $# -gt 0 ]]; then
  add_campaign --force
fi
node "$materializer" materialize root

chmod +x "$cao_command"

if [[ ! -f "$policy_path" ]]; then
  "$cao_command" init
fi
