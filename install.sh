#!/usr/bin/env bash

set -euo pipefail

info() {
  if [[ -t 1 ]] && styled_prompt_enabled; then
    printf '\033[33m…\033[0m %s\n' "$1"
  else
    printf '==> %s\n' "$1"
  fi
}

note() {
  if [[ -t 1 ]] && styled_prompt_enabled; then
    printf '\033[36m•\033[0m \033[2m%s\033[0m\n' "$1"
  else
    printf '==> %s\n' "$1"
  fi
}

success() {
  if [[ -t 1 ]] && styled_prompt_enabled; then
    printf '\033[32m✓\033[0m %s\n' "$1"
  else
    printf '==> %s\n' "$1"
  fi
}

next_step() {
  if [[ -t 1 ]] && styled_prompt_enabled; then
    printf '\033[35m→\033[0m %s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

quiet_command_output=""

run_quiet_command() {
  local progress_message="$1"
  local success_message="$2"
  shift 2

  local output_file
  if ! output_file="$(mktemp "${TMPDIR:-/tmp}/cao-install.XXXXXX")"; then
    printf 'Unable to create temporary installer output.\n' >&2
    return 1
  fi

  "$@" > "$output_file" 2>&1 &
  local command_pid="$!"
  local animated=false
  local styled=false
  local frame=0
  local -a frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  trap 'kill "$command_pid" 2>/dev/null || true; rm -f "$output_file"; exit 130' INT TERM

  if [[ -t 1 ]] && styled_prompt_enabled; then
    styled=true
    sleep 0.1
    while kill -0 "$command_pid" 2>/dev/null; do
      animated=true
      printf '\r\033[2K\033[36m%s\033[0m %s' "${frames[$frame]}" "$progress_message"
      frame="$(((frame + 1) % ${#frames[@]}))"
      sleep 0.08
    done
  else
    info "$progress_message"
  fi

  local status
  if wait "$command_pid"; then
    status=0
  else
    status="$?"
  fi
  trap - INT TERM
  quiet_command_output="$(cat "$output_file")"
  rm -f "$output_file"
  if [[ "$styled" == true && "$animated" == true ]]; then
    printf '\r\033[2K'
  fi
  if [[ "$status" -eq 0 ]]; then
    [[ -z "$success_message" ]] || success "$success_message"
  fi
  return "$status"
}

usage() {
  printf '%s\n' \
    'Usage: install.sh [CATALOG_SOURCE] [--setup | --quickstart] [--create-repo [OWNER/NAME]]' \
    '' \
    'Install in the current GitHub checkout, or explicitly create and clone a private control repository.' \
    '--create-repo prompts for an eligible owner and repository name; pass OWNER/NAME for non-interactive use.' \
    '--setup opens the guided setup after installation (requires a terminal).' \
    '--quickstart creates a private control repository, runs Bug Bash in review mode (up to 700 AI credits),' \
    'commits and pushes CAO files, collects Activity, and deploys a public dashboard.' \
    'Without --quickstart, existing policy and unrelated files are preserved and no campaign is added or run.'
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

get_gh_version() {
  gh --version 2>&1 |
    awk 'match($0, /[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/) {
      print "v" substr($0, RSTART, RLENGTH)
      exit
    }' || true
}

list_repository_owners() {
  local output
  local query
  query='
query($endCursor: String) {
  viewer {
    login
    organizations(first: 100, after: $endCursor) {
      nodes {
        login
        viewerCanCreateRepositories
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}'
  if ! output="$(gh api graphql --paginate -f "query=$query" \
    --jq '.data.viewer as $viewer | $viewer.login, ($viewer.organizations.nodes[] | select(.viewerCanCreateRepositories) | .login)')"; then
    printf 'Unable to list accounts where you can create the control repository.\n' >&2
    return 1
  fi

  local owner
  local owners=""
  while IFS= read -r owner; do
    [[ -z "$owner" ]] && continue
    if [[ ! "$owner" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
      printf 'GitHub returned an invalid repository owner: %s.\n' "$owner" >&2
      return 1
    fi
    if [[ $'\n'"$owners"$'\n' != *$'\n'"$owner"$'\n'* ]]; then
      [[ -z "$owners" ]] || owners+=$'\n'
      owners+="$owner"
    fi
  done <<< "$output"
  if [[ -z "$owners" ]]; then
    printf 'GitHub returned no account where the control repository can be created.\n' >&2
    return 1
  fi
  printf '%s\n' "$owners"
}

styled_prompt_enabled() {
  local colors
  colors="$(tput colors 2>/dev/null || printf '0')"
  [[ -z "${NO_COLOR:-}" && -z "${ACCESSIBLE:-}" && -z "${CI:-}" &&
    "$colors" =~ ^[0-9]+$ && "$colors" -ge 8 ]]
}

terminal_available() {
  { : < /dev/tty; } 2>/dev/null
}

confirm_repository_creation() {
  local message="$1"
  local answer
  if styled_prompt_enabled; then
    printf '\n\033[1;35mNo GitHub control repository found\033[0m\n' > /dev/tty
    printf '%s \033[2m(y/N)\033[0m ' "$message" > /dev/tty
  else
    printf '%s [y/N] ' "$message" > /dev/tty
  fi
  if ! IFS= read -r answer < /dev/tty; then
    printf 'Repository creation cancelled. No CAO files were written.\n' >&2
    return 1
  fi
  if [[ ! "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
    printf 'Repository creation cancelled. No CAO files were written.\n'
    return 1
  fi
  repository_creation_prompt_started=true
  if styled_prompt_enabled; then
    printf '\033[32m✓\033[0m Create a private GitHub control repository\n' > /dev/tty
  fi
}

select_repository_owner_plain() {
  local -a owners=("$@")
  printf 'Choose the account that will own the private control repository:\n' > /dev/tty
  local index
  for index in "${!owners[@]}"; do
    printf '  %d) %s\n' "$((index + 1))" "${owners[$index]}" > /dev/tty
  done

  local selection
  while true; do
    printf 'Owner [1-%d]: ' "${#owners[@]}" > /dev/tty
    if ! IFS= read -r selection < /dev/tty; then
      printf 'Repository creation cancelled.\n' >&2
      return 1
    fi
    if [[ "$selection" =~ ^[0-9]+$ ]] &&
      (( selection >= 1 && selection <= ${#owners[@]} )); then
      printf '%s\n' "${owners[$((selection - 1))]}"
      return
    fi
    printf 'Choose a number from 1 to %d.\n' "${#owners[@]}" > /dev/tty
  done
}

render_repository_owners() {
  local selected="$1"
  shift
  local -a owners=("$@")
  local index
  for index in "${!owners[@]}"; do
    if (( index == selected )); then
      printf '  \033[33m>\033[0m \033[1m%s\033[0m\n' "${owners[$index]}" > /dev/tty
    else
      printf '    %s\n' "${owners[$index]}" > /dev/tty
    fi
  done
  printf '  \033[2m↑/k up • ↓/j down • enter select\033[0m\n' > /dev/tty
}

select_repository_owner_styled() {
  local -a owners=("$@")
  local selected=0
  local key
  local sequence
  local rendered_rows="$((${#owners[@]} + 1))"
  local header_rows=0

  if [[ "${repository_creation_prompt_started:-false}" != true ]]; then
    printf '\n\033[1;35mCreate a private CAO control repository\033[0m\n' > /dev/tty
    printf '\033[2mChoose the account that will own it.\033[0m\n' > /dev/tty
    header_rows=2
  fi
  render_repository_owners "$selected" "${owners[@]}"
  printf '\033[?25l' > /dev/tty
  trap 'printf "\033[?25h" > /dev/tty; exit 130' INT TERM

  while true; do
    key=""
    if ! IFS= read -rsn1 key < /dev/tty; then
      printf '\033[?25h' > /dev/tty
      trap - INT TERM
      printf 'Repository creation cancelled.\n' >&2
      return 1
    fi
    if [[ "$key" == $'\033' ]]; then
      sequence=""
      IFS= read -rsn2 -t 1 sequence < /dev/tty || true
      key+="$sequence"
    fi
    case "$key" in
      $'\033[A'|k)
        selected="$((selected > 0 ? selected - 1 : ${#owners[@]} - 1))"
        ;;
      $'\033[B'|j)
        selected="$((selected + 1 < ${#owners[@]} ? selected + 1 : 0))"
        ;;
      "")
        printf '\033[%dA\r\033[J\033[?25h' "$((rendered_rows + header_rows))" > /dev/tty
        trap - INT TERM
        printf '\033[32m✓\033[0m Repository owner  \033[1m%s\033[0m\n' "${owners[$selected]}" > /dev/tty
        printf '%s\n' "${owners[$selected]}"
        return
        ;;
      $'\033')
        printf '\033[%dA\r\033[J\033[?25h' "$((rendered_rows + header_rows))" > /dev/tty
        trap - INT TERM
        printf 'Repository creation cancelled.\n' >&2
        return 1
        ;;
      *)
        continue
        ;;
    esac
    printf '\033[%dA\r\033[J' "$rendered_rows" > /dev/tty
    render_repository_owners "$selected" "${owners[@]}"
  done
}

select_repository_owner() {
  if styled_prompt_enabled; then
    select_repository_owner_styled "$@"
  else
    select_repository_owner_plain "$@"
  fi
}

default_repository_name() {
  local owner="$1"
  local candidate="cao"
  local result
  if result="$(gh api "repos/$owner/$candidate" 2>&1 >/dev/null)"; then
    return
  fi
  if [[ "$result" == *"(HTTP 404)"* ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  printf 'Unable to check whether %s/%s is available: %s\n' "$owner" "$candidate" "$result" >&2
  return 1
}

read_repository_name_styled() {
  local default_name="$1"
  local value=""
  local key
  local selected

  printf '\033[1;35mRepository name\033[0m\n' > /dev/tty
  printf '\033[35m> \033[0m\033[2m%s\033[0m' "$default_name" > /dev/tty
  while true; do
    key=""
    if ! IFS= read -rsn1 key < /dev/tty; then
      printf 'Repository creation cancelled.\n' >&2
      return 1
    fi
    case "$key" in
      "")
        selected="${value:-$default_name}"
        if [[ -z "$selected" ]]; then
          printf '\a' > /dev/tty
          continue
        fi
        printf '\033[1A\r\033[J\033[32m✓\033[0m Repository name   \033[1m%s\033[0m\n\n' "$selected" > /dev/tty
        printf '%s\n' "$selected"
        return
        ;;
      $'\177'|$'\b')
        [[ -z "$value" ]] || value="${value%?}"
        ;;
      $'\033')
        printf '\033[1A\r\033[JRepository creation cancelled.\n' > /dev/tty
        return 1
        ;;
      [A-Za-z0-9_])
        value+="$key"
        ;;
      [.-])
        [[ -z "$value" ]] || value+="$key"
        ;;
      *)
        printf '\a' > /dev/tty
        continue
        ;;
    esac
    printf '\r\033[J\033[35m> \033[0m' > /dev/tty
    if [[ -n "$value" ]]; then
      printf '%s' "$value" > /dev/tty
    else
      printf '\033[2m%s\033[0m' "$default_name" > /dev/tty
    fi
  done
}

prompt_create_repository() {
  local owners_output
  if ! owners_output="$(list_repository_owners)"; then
    return 1
  fi

  local owner
  local first_owner=true
  local -a owners
  while IFS= read -r owner; do
    [[ -z "$owner" ]] && continue
    if [[ "$first_owner" == true ]]; then
      owners=("$owner")
      first_owner=false
    else
      owners+=("$owner")
    fi
  done <<< "$owners_output"

  if ! owner="$(select_repository_owner "${owners[@]}")"; then
    return 1
  fi

  local default_name
  if ! default_name="$(default_repository_name "$owner")"; then
    return 1
  fi
  local name
  while true; do
    if styled_prompt_enabled; then
      if ! name="$(read_repository_name_styled "$default_name")"; then
        return 1
      fi
    else
      if [[ -n "$default_name" ]]; then
        printf 'Repository name [%s]: ' "$default_name" > /dev/tty
      else
        printf 'Repository name: ' > /dev/tty
      fi
      if ! IFS= read -r name < /dev/tty; then
        printf 'Repository creation cancelled.\n' >&2
        return 1
      fi
      name="${name:-$default_name}"
    fi
    if [[ "$name" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
      break
    fi
    if styled_prompt_enabled; then
      printf '\033[31mUse letters, numbers, dots, hyphens, or underscores.\033[0m\n' > /dev/tty
    else
      printf 'Use a repository name containing letters, numbers, dots, hyphens, or underscores.\n' > /dev/tty
    fi
  done

  printf '%s/%s\n' "$owner" "$name"
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
  local required_gh="v2.68.0"
  local required_gh_aw="v0.91.5"
  local catalog_source="githubnext/gh-aw-cao"
  local explicit_source=false
  local setup=false
  local quickstart=false
  local repository_creation_prompt_started=false
  local create_repository_requested=false
  local create_repository=""
  local create_repository_in_place=false
  local control_repository
  local directory=""
  local git_remotes
  local in_git_checkout=false
  local repository_prefix
  local manifest_required_gh_aw
  local current_gh
  local current_gh_aw
  local authentication_status

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) usage; return ;;
      --setup) setup=true; shift ;;
      --quickstart) quickstart=true; shift ;;
      --create-repo)
        create_repository_requested=true
        if [[ $# -ge 2 && "$2" != -* ]]; then
          if [[ ! "$2" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
            printf 'Provide an exact OWNER/NAME after --create-repo, or omit it for interactive selection.\n' >&2
            return 1
          fi
          create_repository="$2"
          shift 2
        else
          shift
        fi
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
  if [[ "$setup" == true && "$quickstart" == true ]]; then
    printf '%s\n' '--setup and --quickstart cannot be used together.' >&2
    return 1
  fi
  if [[ "$quickstart" == true ]]; then
    create_repository_requested=true
  fi

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
  current_gh="$(get_gh_version)"
  if [[ -z "$current_gh" ]] || ! version_at_least "$current_gh" "$required_gh"; then
    printf 'CAO requires GitHub CLI %s or newer. Upgrade GitHub CLI, then rerun this command (current: %s). No CAO files were written.\n' \
      "$required_gh" "${current_gh:-unknown}" >&2
    return 1
  fi
  if { [[ "$setup" == true ]] || { [[ "$create_repository_requested" == true ]] && [[ -z "$create_repository" ]]; }; } &&
    ! terminal_available; then
    printf '%s\n' 'Interactive repository creation and --setup require a terminal. Pass --create-repo OWNER/NAME for non-interactive creation.' >&2
    return 1
  fi
  if ! run_quiet_command \
    "Checking tools and GitHub sign-in..." \
    "Prerequisites and GitHub sign-in verified." \
    gh auth status; then
    authentication_status="$quiet_command_output"
    printf '%s\n' "$authentication_status" >&2
    printf 'Sign in with gh auth login, then rerun this command. No CAO files were written.\n' >&2
    return 1
  fi
  if [[ "$quickstart" == true ]]; then
    note "Quickstart uses a private control repository, a public dashboard, and up to 700 AI credits."
  fi
  if [[ "$create_repository_requested" == false ]]; then
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      in_git_checkout=true
      if ! repository_prefix="$(git rev-parse --show-prefix 2>/dev/null)" || [[ -n "$repository_prefix" ]]; then
        printf '%s\n' \
          'Run the installer at the root of a GitHub repository checkout.' \
          'No CAO files were written.' >&2
        return 1
      fi
    elif terminal_available &&
      confirm_repository_creation 'Create and clone a new private control repository?'; then
      create_repository_requested=true
    else
      printf '%s\n' \
        'Run the installer at the root of a GitHub repository checkout, or use --create-repo OWNER/NAME.' \
        'No CAO files were written.' >&2
      return 1
    fi
  fi

  if [[ "$create_repository_requested" == false && "$in_git_checkout" == true && ! -f "$policy_path" ]]; then
    if control_repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" &&
      [[ "$control_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      :
    else
      git_remotes="$(git remote)"
      if [[ -z "$git_remotes" ]] && terminal_available &&
        confirm_repository_creation 'Create a new private GitHub repository for this checkout?'; then
        create_repository_requested=true
        create_repository_in_place=true
      else
        printf '%s\n' \
          'Open an existing GitHub repository checkout, or rerun with --create-repo OWNER/NAME to create a private control repository.' \
          'No CAO files were written.' >&2
        return 1
      fi
    fi
  fi

  if [[ "$create_repository_requested" == true && -z "$create_repository" ]]; then
    if ! create_repository="$(prompt_create_repository)"; then
      return 1
    fi
  fi
  if [[ -n "$create_repository" && "$create_repository_in_place" == false ]]; then
    directory="${create_repository#*/}"
    if [[ -e "$directory" ]]; then
      printf 'Cannot clone into existing path %s. Open that checkout or choose another repository name.\n' "$directory" >&2
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
    note "Using gh-aw $current_gh_aw."
  fi

  if [[ -n "$create_repository" ]]; then
    info "Creating private control repository $create_repository..."
    if [[ "$create_repository_in_place" == true ]]; then
      if ! gh repo create "$create_repository" --private --source=. --remote=origin; then
        printf 'Repository creation failed. No CAO files were written; check whether %s was created before retrying.\n' "$create_repository" >&2
        return 1
      fi
    else
      if ! gh repo create "$create_repository" --private --clone; then
        printf 'Creation or cloning failed. If %s was created, clone it with gh repo clone and rerun the installer inside that checkout without --create-repo.\n' "$create_repository" >&2
        return 1
      fi
      cd "$directory"
    fi
  fi

  # gh-aw's markdown scanner rejects the GitHub App manifest page embedded in
  # .github/workflows/shared/setup-github-apps.mjs, so catalog installs skip it.
  if [[ ! -f "$cao_cli" || ! -f "$cao_command" || ! -f "$control_runtime" || ! -f "$materializer" || ! -f "$runtime_action" ]]; then
    note "Resolving the catalog and installing the base workflows; this may take a minute."
    if ! run_quiet_command \
      "Installing the CAO control plane from $catalog_source..." \
      "CAO control plane installed from $catalog_source." \
      gh aw add "$catalog_source" --no-security-scanner; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  elif [[ "$explicit_source" == true ]]; then
    note "Resolving the catalog and refreshing the base workflows; this may take a minute."
    if ! run_quiet_command \
      "Refreshing the CAO control plane from $catalog_source..." \
      "CAO control plane refreshed from $catalog_source." \
      gh aw add "$catalog_source" --force --no-security-scanner; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    note "CAO control-plane files are already installed."
  fi
  if [[ -d "$catalog_source" ]]; then
    if ! run_quiet_command \
      "Materializing the CAO runtime..." \
      "CAO runtime materialized and verified." \
      node "$materializer" materialize-source root "$catalog_source"; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    if ! run_quiet_command \
      "Materializing the CAO runtime..." \
      "CAO runtime materialized and verified." \
      node "$materializer" materialize root; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  fi

  if ! chmod +x "$cao_command"; then
    printf 'Unable to make %s executable.\n' "$cao_command" >&2
    return 1
  fi

  if [[ ! -f "$policy_path" ]]; then
    if ! run_quiet_command \
      "Initializing the CAO policy..." \
      "CAO policy initialized." \
      "$cao_command" init; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    note "Existing CAO policy preserved."
  fi
  success "CAO installed and verified."
  if [[ "$setup" == true ]]; then
    "$cao_command" setup < /dev/tty
  elif [[ "$quickstart" == true ]]; then
    if [[ -d "$catalog_source" ]]; then
      "$cao_command" quickstart --campaign "$catalog_source/bug-bash"
    else
      "$cao_command" quickstart
    fi
  fi
  if [[ -n "$create_repository" && "$create_repository_in_place" == false ]]; then
    printf 'Open the new checkout: cd %q\n' "$directory"
  fi
  if [[ "$setup" == false && "$quickstart" == false ]]; then
    next_step "Next: ./cao.sh setup"
  fi
}

main "$@" </dev/null
