#!/usr/bin/env bash

set -euo pipefail

info() {
  printf '==> %s\n' "$1"
}

usage() {
  printf '%s\n' \
    'Usage: install.sh [CATALOG_SOURCE] [--setup] [--create-repo OWNER/NAME]' \
    '' \
    'Install in the current GitHub checkout, or explicitly create and clone a private control repository.' \
    '--setup opens the guided setup after installation (requires a terminal).' \
    'Existing policy and unrelated files are preserved. No campaign is added or run.'
}

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
  info "Installing gh-aw $required_gh_aw..."
  curl --fail --show-error --location \
    https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh |
    bash -s -- "$required_gh_aw"
}

# gh-aw writes `gh aw version` to stderr.
get_gh_aw_version() {
  gh aw version 2>&1 |
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

# Asks on the controlling terminal before reinstalling an installed gh-aw. A
# declined prompt, or no usable terminal, stops the installer successfully with
# manual-upgrade guidance; a confirmed upgrade that fails still fails the run.
upgrade_gh_aw() {
  local answer
  local upgrade_command="curl --fail --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- $required_gh_aw"
  if { printf 'The installed gh-aw is too old for this CAO campaign. Upgrade it now with %s? [y/N] ' "$upgrade_command" > /dev/tty; } 2>/dev/null &&
    IFS= read -r answer < /dev/tty && [[ "$answer" =~ ^[Yy]$ ]]; then
    if ! install_gh_aw; then
      printf 'Failed to install gh-aw %s.\n' "$required_gh_aw" >&2
      return 1
    fi
    verify_gh_aw_version
    return
  fi
  printf 'gh-aw was not upgraded. Run `%s`, then rerun the CAO installer.\n' "$upgrade_command"
  exit 0
}

# Runs with stdin redirected from /dev/null: when this script is streamed into
# Bash (curl | bash), child processes must not consume the unread script lines.
main() {
  local policy_path=".github/workflows/cao.json"
  local cao_cli="activity/cao.mjs"
  local cao_command="./cao.sh"
  local control_runtime=".github/workflows/shared/control.mjs"
  local materializer=".github/workflows/shared/materialize-cao.mjs"
  local runtime_action=".github/actions/setup-cao-runtime/action.yml"
  local required_gh_aw="v0.91.5"
  local catalog_source="githubnext/gh-aw-cao"
  local explicit_source=false
  local setup=false
  local create_repository=""
  local control_repository
  local repository_prefix
  local manifest_required_gh_aw
  local current_gh_aw
  local authentication_status

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) usage; return ;;
      --setup) setup=true; shift ;;
      --create-repo)
        if [[ $# -lt 2 || ! "$2" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
          printf 'Provide an exact OWNER/NAME after --create-repo.\n' >&2
          return 1
        fi
        create_repository="$2"
        shift 2
        ;;
      -*)
        printf 'Unknown option: %s\n' "$1" >&2
        usage >&2
        return 1
        ;;
      *)
        if [[ "$explicit_source" == true ]]; then
          printf 'Only one catalog source may be specified.\n' >&2
          return 1
        fi
        catalog_source="$1"
        explicit_source=true
        shift
        ;;
    esac
  done

  for tool in node gh git curl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'CAO needs %s. Install it, then rerun this command. No CAO files were written.\n' "$tool" >&2
      return 1
    fi
  done
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    printf 'CAO requires Node.js 24 or newer. Upgrade Node.js, then rerun this command.\n' >&2
    return 1
  fi
  if [[ "$setup" == true ]] && ! { : < /dev/tty; } 2>/dev/null; then
    printf '%s\n' '--setup requires a terminal. Install without --setup, then run ./cao.sh setup from a terminal.' >&2
    return 1
  fi
  info "Checking tools and GitHub sign-in..."
  if ! authentication_status="$(gh auth status 2>&1)"; then
    printf '%s\n' "$authentication_status" >&2
    printf 'Sign in with gh auth login, then rerun this command. No CAO files were written.\n' >&2
    return 1
  fi
  if [[ -n "$create_repository" ]]; then
    local directory="${create_repository#*/}"
    if [[ -e "$directory" ]]; then
      printf 'Cannot clone into existing path %s. Open that checkout or choose another repository name.\n' "$directory" >&2
      return 1
    fi
  else
    if ! repository_prefix="$(git rev-parse --show-prefix 2>/dev/null)" || [[ -n "$repository_prefix" ]]; then
      printf '%s\n' \
        'Run the installer at the root of a GitHub repository checkout, or use --create-repo OWNER/NAME.' \
        'No CAO files were written.' >&2
      return 1
    fi
  fi
  if [[ -z "$create_repository" && ! -f "$policy_path" ]]; then
    if ! control_repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" ||
      [[ ! "$control_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      printf '%s\n' \
        'Open an existing GitHub repository checkout, or rerun with --create-repo OWNER/NAME to create a private control repository.' \
        'No CAO files were written.' >&2
      return 1
    fi
  fi

  if [[ -d "$catalog_source" ]]; then
    catalog_source="$(cd "$catalog_source" && pwd)"
  fi
  if [[ "$catalog_source" == "githubnext/gh-aw-cao" && -f aw.yml ]]; then
    manifest_required_gh_aw="$(awk '$1 == "min-version:" { print $2; exit }' aw.yml)"
    if [[ -n "$manifest_required_gh_aw" ]]; then
      required_gh_aw="$manifest_required_gh_aw"
    fi
  fi

  current_gh_aw="$(get_gh_aw_version)"
  if [[ -z "$current_gh_aw" ]]; then
    install_gh_aw
    verify_gh_aw_version
  elif ! version_at_least "$current_gh_aw" "$required_gh_aw"; then
    upgrade_gh_aw
  else
    info "Using gh-aw $current_gh_aw."
  fi

  if [[ -n "$create_repository" ]]; then
    info "Creating private control repository $create_repository..."
    if ! gh repo create "$create_repository" --private --clone; then
      printf 'Creation or cloning failed. If %s was created, clone it with gh repo clone and rerun the installer inside that checkout without --create-repo.\n' "$create_repository" >&2
      return 1
    fi
    cd "$directory"
  fi

  # gh-aw's markdown scanner rejects the GitHub App manifest page embedded in
  # .github/workflows/shared/setup-github-apps.mjs, so catalog installs skip it.
  if [[ ! -f "$cao_cli" || ! -f "$cao_command" || ! -f "$control_runtime" || ! -f "$materializer" || ! -f "$runtime_action" ]]; then
    info "Installing the CAO campaign from $catalog_source..."
    gh aw add "$catalog_source" --no-security-scanner
  elif [[ "$explicit_source" == true ]]; then
    info "Refreshing the CAO campaign from $catalog_source..."
    gh aw add "$catalog_source" --force --no-security-scanner
  else
    info "The CAO campaign files are already installed."
  fi
  info "Materializing the CAO runtime..."
  if [[ -d "$catalog_source" ]]; then
    node "$materializer" materialize-source root "$catalog_source"
  else
    node "$materializer" materialize root
  fi

  info "Making the CAO launcher executable..."
  chmod +x "$cao_command"

  if [[ ! -f "$policy_path" ]]; then
    info "Initializing the CAO policy..."
    "$cao_command" init
  else
    info "Keeping the existing CAO policy."
  fi
  info "CAO installation complete."
  if [[ "$setup" == true ]]; then
    "$cao_command" setup < /dev/tty
  fi
  if [[ -n "$create_repository" ]]; then
    printf 'Open the new checkout: cd %q\n' "$directory"
  fi
  if [[ "$setup" == false ]]; then
    printf 'Next: ./cao.sh setup\n'
  fi
}

main "$@" </dev/null
