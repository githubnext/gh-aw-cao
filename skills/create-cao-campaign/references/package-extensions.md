# Campaign package extensions

Workflow creation is an agent workflow. Follow
`.github/aw/create-agentic-workflow.md`, then apply the CAO contract.

Use the upstream `github/gh-aw`
`.github/skills/operational-value-designer/SKILL.md`. Adopt a measurable worker
and its evaluator together in one commit.

## Engine authentication

CAO does not require organization-billed Copilot inference. Choose a supported
gh-aw engine and model for each workflow and configure its provider credentials
as Actions secrets. Checking
`gh api orgs/<organization>/copilot/billing` is completely optional: the user's
token may not have access to billing information. Treat an affirmative
`total_seats: 0` with `seat_management_setting: unconfigured` as Copilot runs
being unavailable, not as a blocker to authoring campaigns for other providers.
A Pi or Codex workflow using a `copilot/*` model is Copilot-backed. Do not use
`aw.yml` bootstrap `config`, `COPILOT_GITHUB_TOKEN`, or token precedence as a
workaround.

Add `<campaign-slug>/problem-clustering.mjs` only for a deterministic bounded
problem definition; do not add campaign-specific clustering steps to the
Activity workflow. Read the isolated Activity SQLite snapshot without acquiring
new evidence. Emit a JSONL sequence: zero or more newline-delimited JSON objects
with stable lowercase `id`, non-empty `title`, and an actionable `fixPrompt`
that an agent can follow. Activity runs contributors in a fault-isolated, timed,
cancelable subprocess and retains prior rows after failure.

When a worker optimizes a campaign or campaign portfolio, use the core activity
cache and canonical evidence. A campaign workflow has no dashboard browser
session; never add browser automation or Pages access merely to query IndexedDB.
coding agents may inspect the disposable cache only through the canonical
storage/query APIs or Playwright.

## Deterministic Add-on Exception

The top-level dashboard uses its unified builder and publisher. It is not an
operational campaign and receives no orchestrator, workers, campaign memory,
steering, or grader.
