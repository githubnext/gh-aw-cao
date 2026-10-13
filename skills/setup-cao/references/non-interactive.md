# Non-interactive setup

Load this reference when no user is available, `CI` is set, or `./cao.sh setup`
cannot run in an interactive terminal. This is a constrained fallback, not a
second setup flow.

## No user available

Take the safe default without asking questions or waiting for input. An
explicitly requested bare installation in the selected control checkout may
use `install.sh` (with or without `--setup`); guided setup defaults to **No**
and reports a successful skip. Fresh policy scopes Activity to only that
control repository using its workflow token and leaves campaigns empty.
Preserve an existing policy; do not infer authority to narrow or expand it.

Do not create a repository without an explicitly authorized exact coordinate,
configure credentials or Pages, open a browser, commit, push, install or enable
campaigns, or dispatch workflows. Missing prerequisites, unclear repository
selection, and incompatible existing scope/authentication are blockers, not
permission to guess or broaden access. An outdated installed gh-aw must be
upgraded explicitly before retrying. Report the skipped configuration and any
blocker plainly.

## Explicit broader setup with a user available

1. Run `gh auth status` and resolve the control repository with `gh repo view`.
2. Ask for the exact comma-separated `OWNER/REPOSITORY` read scope.
3. Inspect every entry with:

   ```bash
   gh repo view OWNER/REPOSITORY --json nameWithOwner,visibility
   ```

4. Fail closed if any repository is inaccessible, malformed, or if a public
   control repository would handle non-public evidence.
5. Show the canonical repositories, owners, visibility, authentication
   prerequisites, review-output write scope, and campaign state. Stop if
   `control-plane.campaigns` is not empty; do not remove existing campaigns.
   Obtain approval before mutation.
6. Edit only `control-plane.scope.allowed-owners` and
   `control-plane.scope.allowed-repositories`; keep
   `control-plane.campaigns` as an empty object.
7. Use the matching repository-local command, following
   [authentication](authentication.md) and the
   [authentication profile guide](../../../docs/control-plane-authentication.md).
   Enterprise Apps must already exist, and their selected organizations must
   belong to the same enterprise. The client IDs below are required but are not
   secrets:

   ```bash
   ./cao.sh setup-auth github-app --repo OWNER/CONTROL-REPOSITORY --dry-run
   ./cao.sh setup-auth enterprise-app --repo OWNER/CONTROL-REPOSITORY --read-client-id READ_APP_CLIENT_ID --write-client-id WRITE_APP_CLIENT_ID --policy .github/workflows/cao.json --dry-run
   ./cao.sh setup-auth token --repo OWNER/CONTROL-REPOSITORY --policy .github/workflows/cao.json --dry-run
   ```

   These commands preview the selected profile; they do not configure
   credentials. After the user reviews the preview and approves the changes,
   rerun only the selected command without `--dry-run`. Keep write scope at the
   control repository unless the user explicitly approves another safe-output
   destination. Ask before opening credential pages or storing variables and
   secrets. Never put private keys or tokens in command arguments.
8. Configure Pages in the control repository's settings to use GitHub Actions;
   for a private repository, restrict access to repository readers. Verify
   visibility and stop if the plan cannot restrict a private site's access.
9. Run `./cao.sh validate`, `gh aw doctor --repo
   OWNER/CONTROL_REPOSITORY --dir .`, and `git diff --check`; inspect the policy
   and diff before asking to commit or push.

Do not manually copy runtime files, invent a new credential profile, install a
campaign, enable a workflow, or dispatch work.
