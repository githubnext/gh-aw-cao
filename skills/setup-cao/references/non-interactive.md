# Non-interactive setup

Load this reference only when `./cao.sh setup` cannot run in an interactive
terminal. This is a constrained fallback, not a second setup flow.

1. Run `gh auth status` and resolve the control repository with `gh repo view`.
2. Ask for the exact comma-separated `OWNER/REPOSITORY` read scope.
3. Inspect every entry with:

   ```bash
   gh repo view OWNER/REPOSITORY --json nameWithOwner,visibility
   ```

4. Fail closed if any repository is inaccessible, malformed, or if a public
   control repository would handle non-public evidence.
5. Show the canonical repositories, owners, visibility, compatible
   authentication profiles, review-output write scope, and empty campaign state.
   Obtain approval before mutation.
6. Edit only `control-plane.scope.allowed-owners` and
   `control-plane.scope.allowed-repositories`; keep
   `control-plane.campaigns` as an empty object.
7. Use the matching repository-local command, following
   [authentication](authentication.md):

   ```bash
   ./cao.sh setup-auth github-app --repo OWNER/CONTROL-REPOSITORY --dry-run
   ./cao.sh setup-auth enterprise-app --repo OWNER/CONTROL-REPOSITORY --policy .github/workflows/cao.json --dry-run
   ./cao.sh setup-auth token --repo OWNER/CONTROL-REPOSITORY --policy .github/workflows/cao.json --dry-run --acknowledge-token-risks
   ```

   Supply profile-specific options shown by `./cao.sh setup-auth --help`. Keep
   write scope at the control repository unless the user explicitly approves
   another safe-output destination. Ask before opening credential pages or
   storing variables and secrets.
8. Run `./cao.sh validate`, `gh aw doctor --repo
   OWNER/CONTROL-REPOSITORY --dir .`, and `git diff --check`; inspect the policy
   and diff before asking to commit or push.

Do not manually copy runtime files, invent a new credential profile, install a
campaign, enable a workflow, or dispatch work.

