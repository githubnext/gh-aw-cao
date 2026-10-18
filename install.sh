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
  local started_at="$SECONDS"
  local last_elapsed=-1
  local -a frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  trap 'kill "$command_pid" 2>/dev/null || true; rm -f "$output_file"; exit 130' INT TERM

  if [[ -t 1 ]] && styled_prompt_enabled; then
    styled=true
    sleep 0.1
    while kill -0 "$command_pid" 2>/dev/null; do
      local elapsed="$((SECONDS - started_at))"
      if [[ "$elapsed" -ne "$last_elapsed" ]]; then
        animated=true
        printf '\r\033[2K\033[36m%s\033[0m %s \033[2m· %ss elapsed\033[0m' \
          "${frames[$frame]}" "$progress_message" "$elapsed"
        frame="$(((frame + 1) % ${#frames[@]}))"
        last_elapsed="$elapsed"
      fi
      sleep 0.1
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
    'Usage: install.sh [CATALOG_SOURCE] [--setup | --quickstart] [--create-repo [OWNER/NAME]] [--target OWNER/REPO]' \
    '' \
    'Install in the current GitHub checkout, or explicitly create and clone a private control repository.' \
    '--create-repo requires typing an eligible OWNER and NAME with no defaults; pass OWNER/NAME for non-interactive use.' \
    '--setup opens guided setup; without a terminal or in CI, it applies exact public-repository workflow-token defaults.' \
    '--quickstart requires explicit --target OWNER/REPO for an accessible public repository and pins the latest stable CAO release.' \
    'Use a clean connected control checkout, or explicitly request --create-repo [OWNER/NAME]; no owner or repository is suggested.' \
    'It configures and commits the review-only control plane, then stops with Repo Assist paused; no campaign or Activity run is dispatched.' \
    'Continue with gh cao quickstart --step run, --step collect, and --step dashboard; remote jobs run in Actions without a long terminal wait.' \
    'Starting Repo Assist can use up to 1,250 AI credits under default limits; proposals are optional, not requirements for using CAO.' \
    'The default budget includes 250 orchestration + 600 maintenance + 400 output checking; configured output-check limits may differ.' \
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
  [[ -z "${CI:-}" ]] || return 1
  { : < /dev/tty; } 2>/dev/null
}

run_cao_quickstart() {
  local node_options="${NODE_OPTIONS:-}"
  if [[ " $node_options " != *" --disable-warning=ExperimentalWarning "* ]]; then
    node_options="${node_options:+$node_options }--disable-warning=ExperimentalWarning"
  fi
  if terminal_available; then
    NODE_OPTIONS="$node_options" "$@" < /dev/tty
  else
    NODE_OPTIONS="$node_options" "$@"
  fi
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
  if styled_prompt_enabled; then
    printf '\033[32m✓\033[0m Create a private GitHub control repository\n' > /dev/tty
  fi
}

select_repository_owner() {
  local -a owners=("$@")
  printf 'Create a private CAO control repository. Type its eligible owner; no owner is preselected.\n' > /dev/tty
  local selection
  local owner
  while true; do
    printf 'Repository owner (OWNER): ' > /dev/tty
    if ! IFS= read -r selection < /dev/tty; then
      printf 'Repository creation cancelled.\n' >&2
      return 1
    fi
    if [[ "$selection" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then
      for owner in "${owners[@]}"; do
        if [[ "$(printf '%s' "$selection" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]')" ]]; then
          printf '%s\n' "$owner"
          return
        fi
      done
    fi
    printf 'Type an account where you can create repositories; blank input does not choose an owner.\n' > /dev/tty
  done
}

assert_repository_available() {
  local repository="$1"
  local result
  if result="$(gh api "repos/$repository" 2>&1 >/dev/null)"; then
    printf 'Repository %s already exists. Choose an unused explicit OWNER/NAME. No CAO files were written.\n' "$repository" >&2
    return 1
  fi
  if [[ "$result" == *"(HTTP 404)"* ]]; then
    return 0
  fi
  printf 'Unable to check whether %s is available: %s\n' "$repository" "$result" >&2
  return 1
}

read_repository_name_styled() {
  local value=""
  local key
  local selected

  printf '\033[1;35mRepository name\033[0m\n' > /dev/tty
  printf '\033[35m> \033[0m' > /dev/tty
  while true; do
    key=""
    if ! IFS= read -rsn1 key < /dev/tty; then
      printf 'Repository creation cancelled.\n' >&2
      return 1
    fi
    case "$key" in
      "")
        selected="$value"
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

  local name
  while true; do
    if styled_prompt_enabled; then
      if ! name="$(read_repository_name_styled)"; then
        return 1
      fi
    else
      printf 'Repository name (NAME): ' > /dev/tty
      if ! IFS= read -r name < /dev/tty; then
        printf 'Repository creation cancelled.\n' >&2
        return 1
      fi
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

resolve_latest_cao_release() {
  local releases
  local draft
  local prerelease
  local release
  if releases="$(gh api --hostname github.com --paginate \
    'repos/githubnext/gh-aw-cao/releases?per_page=100' \
    --jq '.[] | [.draft, .prerelease, .tag_name] | @tsv')"; then
    while IFS=$'\t' read -r draft prerelease release; do
      if [[ "$draft" == false && "$prerelease" == false &&
        "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        printf '%s\n' "$release"
        return
      fi
    done <<< "$releases"
  fi
  printf '%s\n' \
    'Unable to resolve the latest stable CAO release with a vX.Y.Z tag.' \
    'Retry after GitHub release access is restored, or pass an explicit published tag such as githubnext/gh-aw-cao@vX.Y.Z.' \
    'No CAO files were written.' >&2
  return 1
}

install_cao_extension() (
  set -euo pipefail
  local release="$1"
  local os arch suffix="" data_dir asset directory binary expected actual installed_version
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows; suffix=.exe ;;
    *) printf 'Unsupported CAO extension operating system.\n' >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) printf 'Unsupported CAO extension architecture.\n' >&2; exit 1 ;;
  esac
  if [[ -n "${XDG_DATA_HOME:-}" ]]; then
    data_dir="$XDG_DATA_HOME/gh"
  elif [[ "$os" == windows && -n "${LOCALAPPDATA:-}" ]]; then
    data_dir="$LOCALAPPDATA/GitHub CLI"
  else
    data_dir="${HOME:?HOME is required to install gh cao}/.local/share/gh"
  fi
  directory="$data_dir/extensions/gh-cao"
  if [[ -L "$directory" || -e "$directory/.git" ]]; then
    printf 'Refusing to replace a linked or source-installed gh cao extension at %s.\n' "$directory" >&2
    exit 1
  fi
  if [[ -L "$directory/gh-cao$suffix" || -d "$directory/gh-cao$suffix" ]]; then
    printf 'Refusing to replace a linked or non-file gh cao executable at %s.\n' "$directory/gh-cao$suffix" >&2
    exit 1
  fi
  mkdir -p "$directory"
  staged="$(mktemp -d "$directory/.install.XXXXXX")"
  binary="$staged/gh-cao$suffix"
  trap 'rm -rf -- "$staged"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  asset="gh-cao-$os-$arch$suffix"
  info "Downloading gh cao $release for $os-$arch..."
  local base_url="https://github.com/githubnext/gh-aw-cao/releases/download/$release"
  curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
    "$base_url/$asset" -o "$binary"
  curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 60 \
    "$base_url/checksums.txt" -o "$staged/checksums.txt"
  expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$staged/checksums.txt")"
  if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'Release checksums must contain exactly one SHA-256 digest for %s.\n' "$asset" >&2
    exit 1
  fi
  # Hash stdin so Windows path separators cannot trigger escaped-filename output.
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum -b < "$binary" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 -b < "$binary" | awk '{print $1}')"
  else
    printf 'Installing gh cao requires sha256sum or shasum for checksum verification.\n' >&2
    exit 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'CAO extension checksum verification failed for %s.\n' "$asset" >&2
    exit 1
  fi
  chmod +x "$binary"
  installed_version="$("$binary" --version)"
  if [[ "$installed_version" != "gh cao version $release" ]]; then
    printf 'CAO extension version verification failed; expected %s.\n' "$release" >&2
    exit 1
  fi
  mv -f "$binary" "$directory/gh-cao$suffix"
  success "Installed gh cao $release."
)

# Asks on the controlling terminal before reinstalling an installed gh-aw. A
# declined prompt stops successfully with manual-upgrade guidance; no usable
# terminal or a confirmed upgrade that fails still fails the run.
upgrade_gh_aw() {
  local answer
  local upgrade_command="curl --fail --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- $required_gh_aw"
  if ! terminal_available; then
    printf 'gh-aw was not upgraded. Run `%s`, then rerun the CAO installer.\n' "$upgrade_command" >&2
    return 1
  fi
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
  local control_runtime=".github/workflows/shared/control.mjs"
  local materializer=".github/workflows/shared/materialize-cao.mjs"
  local runtime_action=".github/actions/setup-cao-runtime/action.yml"
  local required_gh="v2.68.0"
  local required_gh_aw="v0.92.5"
  local catalog_source="githubnext/gh-aw-cao"
  local package_source
  local explicit_source=false
  local setup=false
  local quickstart=false
  local create_repository_requested=false
  local create_repository=""
  local target_repository=""
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
  local quickstart_status
  local quickstart_release
  local extension_release=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) usage; return ;;
      --setup) setup=true; shift ;;
      --quickstart) quickstart=true; shift ;;
      --target)
        if [[ $# -lt 2 || "$2" == -* ||
          ! "$2" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]]; then
          printf 'Provide an exact public OWNER/REPOSITORY after --target.\n' >&2
          return 1
        fi
        target_repository="$2"
        shift 2
        ;;
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
  if [[ -n "$target_repository" && "$quickstart" == false ]]; then
    printf '%s\n' '--target requires --quickstart.' >&2
    return 1
  fi
  if [[ "$quickstart" == true && -z "$target_repository" ]]; then
    printf '%s\n' '--quickstart requires explicit --target OWNER/REPO. No CAO files were written.' >&2
    return 1
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
  if [[ "$create_repository_requested" == true && -z "$create_repository" ]] &&
    ! terminal_available; then
    printf '%s\n' 'Interactive repository creation requires a terminal outside CI. Pass --create-repo OWNER/NAME for non-interactive creation.' >&2
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
    note "Quickstart configures review-only Repo Assist for $target_repository and public Pages, commits and pushes, then stops with the orchestrator paused."
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
    elif [[ "$quickstart" == true ]]; then
      printf '%s\n' 'Quickstart requires a connected GitHub checkout or explicit --create-repo OWNER/NAME (or interactive --create-repo). No CAO files were written.' >&2
      return 1
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

  if [[ "$create_repository_requested" == false && "$in_git_checkout" == true ]] &&
    { [[ "$quickstart" == true ]] || [[ ! -f "$policy_path" ]]; }; then
    if control_repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" &&
      [[ "$control_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
      :
    else
      git_remotes="$(git remote)"
      if [[ -z "$git_remotes" && "$quickstart" == true ]]; then
        printf '%s\n' 'Quickstart requires a connected GitHub checkout or explicit --create-repo OWNER/NAME (or interactive --create-repo). No CAO files were written.' >&2
        return 1
      elif [[ -z "$git_remotes" ]] && terminal_available &&
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
  if [[ "$quickstart" == true && "$create_repository_requested" == false ]]; then
    if ! quickstart_status="$(git status --porcelain=v1 --untracked-files=all)"; then
      printf '%s\n' 'Unable to inspect the current checkout before quickstart. No CAO files were written.' >&2
      return 1
    fi
    if [[ -n "$quickstart_status" ]]; then
      printf '%s\n' \
        'Quickstart requires a clean control-repository checkout before installation.' \
        'Commit, stash, or remove existing changes, then rerun --quickstart.' \
        'No CAO files were written.' >&2
      return 1
    fi
  fi

  if [[ "$create_repository_requested" == true && -z "$create_repository" ]]; then
    if ! create_repository="$(prompt_create_repository)"; then
      return 1
    fi
  fi
  if [[ -n "$create_repository" && "$create_repository_in_place" == false ]]; then
    directory="${create_repository#*/}"
    if [[ -e "$directory" || -L "$directory" ]]; then
      printf 'Cannot clone into existing path %s. Open that checkout or choose another repository name.\n' "$directory" >&2
      return 1
    fi
  fi
  if [[ -n "$create_repository" ]] && ! assert_repository_available "$create_repository"; then
    return 1
  fi

  if [[ "$quickstart" == true && "$explicit_source" == false ]]; then
    if ! quickstart_release="$(resolve_latest_cao_release)"; then
      return 1
    fi
    catalog_source="githubnext/gh-aw-cao@$quickstart_release"
    explicit_source=true
    note "Quickstart selected stable CAO release $quickstart_release."
  fi

  if [[ "$catalog_source" =~ ^githubnext/gh-aw-cao@(v[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    extension_release="${BASH_REMATCH[1]}"
  elif ! extension_release="$(resolve_latest_cao_release)"; then
    return 1
  fi

  if [[ -d "$catalog_source" ]]; then
    catalog_source="$(cd "$catalog_source" && pwd)"
  fi
  if [[ -d "$catalog_source" ]]; then
    package_source="$catalog_source/aw.yml"
  else
    package_source="$catalog_source"
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
  install_cao_extension "$extension_release"

  if [[ -n "$create_repository" ]]; then
    if [[ "$create_repository_in_place" == true ]]; then
      if ! run_quiet_command \
        "Creating private control repository..." \
        "Created private control repository $create_repository." \
        gh repo create "$create_repository" --private --source=. --remote=origin; then
        [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
        printf 'Repository creation failed. No CAO files were written; check whether %s was created before retrying.\n' "$create_repository" >&2
        return 1
      fi
    else
      if ! run_quiet_command \
        "Creating private control repository..." \
        "Created private control repository $create_repository." \
        gh repo create "$create_repository" --private --clone; then
        [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
        printf 'Creation or cloning failed. If %s was created, clone it with gh repo clone and rerun the installer inside that checkout without --create-repo.\n' "$create_repository" >&2
        return 1
      fi
      cd "$directory"
    fi
  fi

  # gh-aw's markdown scanner rejects the GitHub App manifest page embedded in
  # .github/workflows/shared/setup-github-apps.mjs, so catalog installs skip it.
  if [[ ! -f "$cao_cli" || ! -f "$control_runtime" || ! -f "$materializer" || ! -f "$runtime_action" ]]; then
    note "Installs 3 workflows, 5 shared control plane resources, and project settings."
    if ! run_quiet_command \
      "Installing control plane components..." \
      "CAO control plane components installed from $catalog_source." \
      gh aw add "$package_source" --no-security-scanner; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  elif [[ "$explicit_source" == true ]]; then
    note "Refreshes 3 workflows, 5 shared control plane resources, and project settings."
    if ! run_quiet_command \
      "Refreshing control plane components..." \
      "CAO control plane components refreshed from $catalog_source." \
      gh aw add "$package_source" --force --no-security-scanner; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    note "CAO control plane components are already installed."
  fi
  if [[ -d "$catalog_source" ]]; then
    if ! run_quiet_command \
      "Materializing CAO runtime..." \
      "CAO runtime materialized and verified." \
      node "$materializer" materialize-source root "$catalog_source"; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    note "A newly published catalog revision may wait for its exact verified runtime build."
    if ! run_quiet_command \
      "Verifying exact CAO runtime..." \
      "CAO runtime materialized and verified." \
      node "$materializer" materialize root; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  fi

  if [[ ! -f "$policy_path" ]]; then
    if ! run_quiet_command \
      "Initializing the CAO policy..." \
      "CAO policy initialized." \
      gh cao init; then
      [[ -z "$quiet_command_output" ]] || printf '%s\n' "$quiet_command_output" >&2
      return 1
    fi
  else
    note "Existing CAO policy preserved."
  fi
  success "CAO installed and verified."
  if [[ "$setup" == true ]]; then
    if terminal_available; then
      gh cao setup < /dev/tty
    else
      gh cao setup
    fi
  elif [[ "$quickstart" == true ]]; then
    local -a quickstart_arguments=(quickstart)
    if [[ -n "$target_repository" ]]; then
      quickstart_arguments+=(--target "$target_repository")
    fi
    if [[ -d "$catalog_source" ]]; then
      quickstart_arguments+=(--campaign "$catalog_source/repo-assist")
      run_cao_quickstart gh cao "${quickstart_arguments[@]}"
    else
      run_cao_quickstart gh cao "${quickstart_arguments[@]}"
    fi
  fi
  if [[ -n "$create_repository" && "$create_repository_in_place" == false ]]; then
    printf 'Open the new checkout: cd %q\n' "$directory"
  fi
  if [[ "$setup" == false && "$quickstart" == false ]]; then
    next_step "Next: gh cao setup"
  fi
}

main "$@" </dev/null
