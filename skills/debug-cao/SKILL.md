---
name: debug-cao
description: "Diagnose a Central Agentic Ops (CAO) deployment failure across policy, credentials, GitHub Agentic Workflows, activity collection, dashboard builds, and safe outputs; preserve exact versions and produce an evidence-rich issue optimized for another agent."
argument-hint: "Provide the control repository and, when available, a failing run URL, issue URL, failure code, or symptom"
---

# Debug Central Agentic Ops

Diagnose a CAO deployment from the control repository outward. Preserve the failing revision, narrow the fault to one system boundary, and leave a reproducible issue that another agent can act on without rediscovering context.

## Safety

- Start read-only. Do not rerun, update, recompile, rotate credentials, change policy, enable a campaign, or promote `review` to `live` until evidence from the failing run is captured.
- Never print, copy, attach, or request secret values. Record only whether a repository variable or secret is configured, which credential type was selected, and any non-sensitive App installation or permission metadata.
- Redact tokens, private keys, authorization headers, signed URLs, prompts containing private source, and private target data. If a log may contain a secret, describe the error and its location instead of quoting it.
- Keep CAO authority separate from gh-aw execution capability. A credential, compiled permission, or successful API call does not widen `.github/workflows/cao.json`.
- If the report concerns a vulnerability or exposed credential, stop public issue creation and follow [private security reporting](https://github.com/githubnext/gh-aw-cao/security/policy).

## Dispatcher

Choose the narrowest path that matches the first failed job or observed symptom.

| Symptom | Inspect first | Reference |
| --- | --- | --- |
| Installation, update, or missing runtime file | package/campaign record, its `resolvedCommit`, and materialized files | [CAO setup](https://githubnext.github.io/gh-aw-cao/getting-started/), [CAO catalog source](https://github.com/githubnext/gh-aw-cao), [`aw.yml`](https://github.com/githubnext/gh-aw-cao/blob/main/aw.yml) |
| Policy rejection, wrong target, disabled campaign, or wrong mode | `.github/workflows/cao.json`, resolved control summary, dispatch inputs | [Configuration](https://githubnext.github.io/gh-aw-cao/configuration/), [rollout and routing](https://githubnext.github.io/gh-aw-cao/rollout-and-routing/), [admission](https://githubnext.github.io/gh-aw-cao/admission/) |
| Missing, invalid, or under-scoped credentials | selected authentication profile, variable/secret presence, App installation scope and permissions | [CAO authentication](https://githubnext.github.io/gh-aw-cao/authentication/), [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-in-a-github-actions-workflow) |
| Agent does not start, model/catalog returns 403, or Copilot billing fails | organization billing, `copilot-requests: write`, compiled token mapping, gh-aw version | [CAO Copilot authentication](https://githubnext.github.io/gh-aw-cao/authentication/#copilot-engine-authentication), [gh-aw engines](https://github.github.com/gh-aw/reference/engines/) |
| Workflow syntax, compilation, lock, tool, network, or safe-output failure | editable `.md` source, generated `.lock.yml`, compiler diagnostics, exact gh-aw version | [gh-aw documentation](https://github.github.com/gh-aw/), [gh-aw source](https://github.com/github/gh-aw), [workflow syntax](https://github.github.com/gh-aw/reference/workflow-structure/) |
| Orchestrator selects or dispatches incorrectly | orchestrator source, resolved policy, inventory, rollout and dispatch summary | [Execution and safety](https://githubnext.github.io/gh-aw-cao/execution-and-safety/), [CAO architecture](https://githubnext.github.io/gh-aw-cao/architecture/) |
| Worker sees the wrong target or cannot write a safe output | dispatch envelope, worker source, effective mode, review destination, write App scope | [Execution and safety](https://githubnext.github.io/gh-aw-cao/execution-and-safety/), [authentication](https://githubnext.github.io/gh-aw-cao/authentication/) |
| `CAO_ACTIVITY_*` failure or stale/missing dashboard data | `.github/workflows/cao-activity.yml`, failed job logs, cache/artifact, `activity/` source | [Activity source](https://github.com/githubnext/gh-aw-cao/tree/main/activity), [dashboard data model](https://githubnext.github.io/gh-aw-cao/dashboard-data-model/) |
| `CAO_DASHBOARD_*` failure, Pages failure, or broken dashboard build | `.github/workflows/cao-dashboard.yml`, Activity dependency, build/deploy job, `dashboard/` source | [Dashboard source](https://github.com/githubnext/gh-aw-cao/tree/main/dashboard), [GitHub Pages Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) |
| GitHub API rate limit or inaccessible evidence | admission summary, exact credential selected, rate-limit reset and target visibility | [CAO API capacity admission](https://githubnext.github.io/gh-aw-cao/authentication/#api-capacity-admission), [GitHub API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| Runner, checkout, action, Node, npm, or build failure | failed step logs, runner image, pinned action SHA/version, lockfile and runtime version | [GitHub Actions troubleshooting](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows) |

## Source Map

Inspect files at the failing workflow commit, not `main`.

| Concern | Control-repository path | Upstream CAO source |
| --- | --- | --- |
| Rollout authority | `.github/workflows/cao.json` | [policy documentation](https://githubnext.github.io/gh-aw-cao/configuration/) |
| Shared admission and authentication | `.github/workflows/shared/control.md`, `control.mjs`, `policy.mjs` | [shared workflow source](https://github.com/githubnext/gh-aw-cao/tree/main/.github/workflows/shared) |
| Agentic workflow source | `.github/workflows/<workflow>.md` | [catalog workflow sources](https://github.com/githubnext/gh-aw-cao/tree/main/.github/workflows) |
| Compiled workflow | `.github/workflows/<workflow>.lock.yml` | generated by the pinned gh-aw compiler; never edit directly |
| Installed source identity | `.github/aw/packages/*.json`, `.github/aw/campaigns/*.json` | `resolvedCommit` identifies the exact catalog tree |
| Activity workflow and runtime | `.github/workflows/cao-activity.yml`, `activity/` | [Activity source](https://github.com/githubnext/gh-aw-cao/tree/main/activity) |
| Dashboard workflow and runtime | `.github/workflows/cao-dashboard.yml`, `dashboard/` | [Dashboard source](https://github.com/githubnext/gh-aw-cao/tree/main/dashboard) |
| Campaign declaration | `<campaign>/aw.yml`, `<campaign>/cao.json` | [CAO catalog](https://github.com/githubnext/gh-aw-cao) |
| CAO architecture and contracts | `CODEBASE.yml`, `ARCHITECTURE.md`, `specs/` | [architecture source](https://github.com/githubnext/gh-aw-cao/blob/main/ARCHITECTURE.md), [specifications](https://github.com/githubnext/gh-aw-cao/tree/main/specs) |
| gh-aw implementation | installed `gh aw` extension and generated lock metadata | [github/gh-aw](https://github.com/github/gh-aw), [documentation](https://github.github.com/gh-aw/) |

When linking a source file in an issue, replace `main` with the full 40-character CAO `resolvedCommit`, workflow SHA, gh-aw commit, or action SHA whenever one is known.

## Procedure

### 1. Freeze the failing identity

Record:

- control repository, workflow name, run URL and ID, run attempt, event, ref, head SHA, and full `GITHUB_WORKFLOW_SHA`;
- failing job and step, UTC start/end time, runner OS/image/architecture, and whether a rerun differs;
- CAO package or campaign `resolvedCommit` from the matching `.github/aw/packages/*.json` or `.github/aw/campaigns/*.json`;
- `.github/workflows/cao.json` `version` and `gh-aw-version`;
- `gh aw --version`, `gh --version`, `node --version`, and relevant package version or lockfile hash;
- every referenced action's tag comment and full pinned commit SHA;
- target repository and target commit, effective campaign/worker, `review` or `live` mode, and review destination.

Do not describe a deployment only as "latest", "main", or an action tag. Include the immutable SHA beside every friendly version.

### 2. Capture bounded evidence

Read the run summary and annotation before the raw log. Download logs and artifacts only from the exact failed attempt. Capture the smallest excerpt that includes the first error, its step, and preceding causal message; later cancellation noise is not the root cause.

For a gh-aw workflow, compare the `.md` source and `.lock.yml` from `GITHUB_WORKFLOW_SHA`. Confirm that the lock was generated by the `gh-aw-version` pinned in policy. Run read-only diagnostics from the same checkout when available:

```bash
gh aw --version
gh aw doctor --repo OWNER/CONTROL-REPOSITORY --dir .
npm run compile
```

For deterministic CAO workflows, inspect the exact Activity or Dashboard job logs and the artifact/cache handoff. Do not infer that a dashboard symptom originated in the dashboard: first prove whether the Activity snapshot was complete, fresh, and restored successfully.

### 3. Classify the first broken boundary

Classify the issue as exactly one primary category, with secondary effects listed separately:

1. **installation/version drift** — missing or mixed files, package records, compiler, or generated artifacts;
2. **policy/admission** — scope, campaign enablement, worker mapping, mode, rollout, budget, or dispatch is denied or incorrect;
3. **authentication/authorization** — credential absent, invalid, expired, installed on the wrong repository, or missing a required permission;
4. **Copilot inference** — billing, `copilot-requests`, model catalog, or engine authentication fails before agent execution;
5. **gh-aw compile/runtime** — source syntax, compiler, generated lock, tools, network, engine, or safe-output runtime;
6. **campaign logic** — admitted workflow runs but orchestrator/worker behavior is wrong;
7. **Activity data** — collection, normalization, ingestion, cache, or artifact publication;
8. **Dashboard build/deploy** — Activity restore, site build, artifact, cache, Pages configuration, or deployment;
9. **GitHub Actions/platform** — runner, service incident, action download, checkout, npm registry, Pages, or API outage.

State the evidence that excludes the adjacent category. For example, distinguish "secret is not configured" from "configured App cannot access target", and "workflow compiles" from "compiled workflow fails at runtime".

### 4. Reproduce without widening authority

Prefer a diagnostic or `review` run against one exact target. Preserve the same workflow SHA, inputs, policy SHA, compiler version, and target SHA. Do not change credentials and code in the same experiment. Change one boundary at a time and record the resulting run URL.

If reproduction would write to a target, expose private data, consume substantial resources, or require a credential change, stop and document the proposed reproduction rather than executing it.

### 5. Form and test a falsifiable hypothesis

Write one sentence:

> At `<first failing step>`, `<component@version-or-sha>` fails because `<specific boundary condition>`; `<single controlled observation>` would confirm or reject this.

Prefer evidence from the first failure over a speculative fix. If evidence is incomplete, say which exact permission, artifact, log, or version is unavailable and why.

### 6. Create or enrich the issue

Search [existing CAO issues](https://github.com/githubnext/gh-aw-cao/issues) and the control repository first. Add evidence to an exact existing match; otherwise create one issue for one root cause. Use a title such as:

`[component@version] concise failure at boundary (FAILURE_CODE)`

Use this body:

```markdown
## Summary
One sentence describing the observed failure and affected boundary.

## Impact and safety
- Affected control repository / campaign / targets:
- Effective mode and safe-output destination:
- Writes observed (or confirmation that none occurred):
- First occurrence and frequency:

## Immutable versions
| Component | Version | Full commit SHA / digest | Evidence |
| --- | --- | --- | --- |
| CAO package/campaign | ... | ... | package record link |
| Workflow | ... | ... | source permalink |
| gh-aw | ... | ... | policy / command output |
| Action, runner, runtime | ... | ... | run step |
| Target | ... | ... | commit permalink |

## Reproduction
1. Preconditions with credential type and scope, never values.
2. Exact event/inputs and policy revision.
3. Exact command or run URL.
4. First failing job and step.

## Expected behavior
...

## Actual behavior
...

## Evidence
- Failed run and attempt:
- First causal annotation or redacted log excerpt:
- Relevant source permalinks:
- Artifact/cache state:
- Related successful run at an exact SHA:

## Boundary analysis
- Primary category:
- Last known-good boundary:
- First broken boundary:
- Adjacent causes excluded and evidence:

## Hypothesis
Falsifiable one-sentence hypothesis.

## Proposed next diagnostic
One bounded, review-safe observation; no speculative broad fix.

## Redaction statement
No credentials, private keys, authorization headers, signed URLs, or private target data are included.
```

Do not paste an entire log, omit versions, link mutable branches when a SHA is available, combine unrelated failures, or instruct an agent only to "investigate". End with the exact acceptance condition that proves the root cause is fixed and that existing policy and safe-output boundaries remain unchanged.

## Completion

Report:

- primary category and first broken boundary;
- immutable CAO, workflow, gh-aw, action, runtime, and target versions gathered;
- run, source, and issue URLs;
- what was redacted or unavailable;
- whether reproduction was performed and stayed in `review`;
- hypothesis, next diagnostic, and acceptance condition.

If no root cause is proven, report the diagnosis as incomplete rather than guessing.
