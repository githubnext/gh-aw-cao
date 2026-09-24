---
name: add-operational-value
description: "Design and optionally evaluate a deterministic operational-value measure for a GitHub Agentic Workflow using pre-adoption evidence. Use for workflow or campaign-scoped selection, outcome contracts, value functions, baseline comparison, and attainment evaluation. Usage: /add-operational-value OWNER/REPO [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]."
argument-hint: "OWNER/REPO [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]"
allowed-tools: bash node gh
metadata:
  version: "0.1.0"
---

# Add Operational Value

## Operational Value

**Operational value is the degree to which the workflow's intended repository outcome is attained across eligible opportunities, demonstrated by accepted evidence under a fixed measurement contract.**

- An **eligible opportunity** is a repository event or state to which the intended outcome could apply.
- The **intended outcome** is the repository state the workflow exists to advance.
- **Accepted evidence** is a repository-observable fact that proves an eligible opportunity reached that state after any maturation period.
- Value is outcome attainment, not workflow execution, output volume, or the agent's assessment. Count evidence of attainment regardless of whether a workflow, person, or other system produced it.
- A baseline-comparable evaluation may report change in the same attainment measure around adoption. An attainment-only evaluation reports post-adoption attainment. Neither establishes that the workflow caused the result.

Design the evidence contract only from information available by adoption. Never use post-adoption results to choose evidence, formulas, targets, or classification.

## Inputs

Use `/add-operational-value OWNER/REPO` to list repository workflows or `/add-operational-value OWNER/REPO WORKFLOW-NAME` to design one. Add `--campaign CAMPAIGN-SLUG` to restrict selection to workflows directly included by one campaign and place the resulting module under that campaign.

- `OWNER/REPO`: repository containing the workflow. Outcome evidence may come from other affected repositories.
- `WORKFLOW-NAME`: filename stem using lowercase letters, numbers, and single hyphens, such as `daily-file-diet`. Do not accept a path or `.md` suffix.
- `CAMPAIGN-SLUG`: optional top-level campaign directory containing `aw.yml`. It scopes workflow selection and owns the shared CAO adapter. Never infer it from a workflow name.
- After validation, set `WORKFLOW-PATH` to `.github/workflows/WORKFLOW-NAME.md` and use `WORKFLOW-NAME` unchanged as the slug.
- Never infer the repository, workflow, or campaign from the workspace, environment, or Git remotes.

## Workflow

1. **Resolve the workflow.**
  - Without `WORKFLOW-NAME`, run `.github/skills/add-operational-value/scripts/list-repository-workflows.mjs OWNER/REPO`, appending `--campaign CAMPAIGN-SLUG` when supplied. Reproduce every returned name in the assistant response as a Markdown list, ask the user to select one, and stop. Tool output is not user-visible; never say the list is "shown above." Do not summarize or truncate it.
  - With `WORKFLOW-NAME`, run the same command with `WORKFLOW-NAME` before the optional campaign flag. Use its output as `WORKFLOW-PATH`. Campaign-scoped resolution must reject workflows not directly included by that campaign. If resolution fails, ask for a valid name.
  - Design exactly one selected workflow per invocation. A campaign scopes ownership and selection; it does not combine distinct workflow outcome contracts.

2. **Protect an existing design.** Run `.github/skills/add-operational-value/scripts/value-function-path.mjs OWNER/REPO WORKFLOW-NAME [CAMPAIGN-SLUG]`. Without a campaign, the default package is `WORKFLOW-NAME`. With a campaign, the canonical module is `CAMPAIGN-SLUG/operational-value/WORKFLOW-NAME.mjs` and the shared adapter is `CAMPAIGN-SLUG/operational-value.mjs`. If the module exists, verify it with `.github/skills/add-operational-value/scripts/verify-value-function.mjs --cao-adapter <adapter> <path>`, report that it was left unchanged, and continue at step 7. Do not inspect post-adoption evidence or redesign it.

3. **Recover adoption-time intent.** Run `.github/skills/add-operational-value/scripts/extract-workflow-intent.mjs OWNER/REPO WORKFLOW-PATH`. Treat its adoption commit as adoption and its first parent as the baseline; if there is no parent, no historical baseline exists. Infer intent from adoption-time frontmatter, imports, instructions, and compiled workflow. Use triggers and skip rules to identify opportunities, and checkout, tools, permissions, and safe outputs to identify accessible or affected repositories.

4. **Design and test once.** From adoption-time intent and pre-adoption facts, form one provisional contract and test it with one batched pre-adoption probe. Fetch only cutoffs at or before the baseline commit time; never fetch, inspect, or compare recent or post-adoption outcomes during design. One valid baseline observation is enough to establish comparability. Resolve discoverable facts without asking the user. The contract must include:
  - operational value stated as "For [eligible opportunities], attain [repository outcome], demonstrated by [accepted evidence]";
  - eligible opportunity population;
  - accepted evidence and evidence repositories;
  - deterministic opportunity/outcome matching rule and maturation period;
  - observation window, cadence, evidence shape, and zero-versus-missing rule;
  - whether the outcome can occur without the workflow;
  - proposed primary and diagnostic measures;
  - classification as baseline-comparable, attainment-only, or not measurable.

  Apply this test: **if a person achieved the intended outcome without the workflow, would the primary measure record success?** If not, it measures mechanism rather than operational value. Use one workspace-local temporary directory for the entire probe, reuse downloaded evidence, and remove it afterward. Use `gh api` for GitHub data; do not use `/tmp`, `${TMPDIR}`, `curl`, or `wget`.

  Classify the tested contract:
  - **Baseline-comparable:** valid comparable outcome evidence exists. Apply one symmetric measure before and after adoption.
  - **Attainment-only:** the future outcome contract is valid, but comparable history cannot be reconstructed. Begin at adoption and report no improvement.
  - **Not measurable:** no deterministic opportunity population, repository outcome, or accepted-evidence rule can be defined. State what is missing and stop without creating a function.

  Eligible opportunities plus evidence that none attained the outcome may establish zero; absent evidence does not. Never treat missing workflow-generated traces as zero when the outcome could occur another way.

5. **Confirm once.** Present the tested operational value, complete contract, retained and rejected metrics, and classification in one concise response. Ask one confirmation question covering the whole design. Stop there; do not inspect implementation scripts or begin implementation until the user confirms. Do not ask separate outcome, contract, metric, or classification questions. Ask earlier only when one unresolved decision prevents a valid pre-adoption probe.

6. **Implement and freeze.** For a confirmed measurable design:
  - Freeze the confirmed evidence object, collection plan, metric roles, formulas, and classification. Do not reconsider or replace them during implementation.
  - Select exactly one direct primary metric using outcome relevance plus pre-adoption observations and validation examples. Never use post-adoption results to compare metric sensitivity. Do not use a population-wide rate dominated by unaffected items when a direct severity or attainment measure better exposes the intended change. For thresholded populations, compare worst-violation severity, compliant opportunity share, and compliant mass share when the same snapshot supports them; retain only dimensions that can meaningfully disagree. Do not normalize raw counts with arbitrary transforms. Never invent normalization caps, targets, or weights absent from pre-adoption evidence.
  - Create the canonical shared module directly from the Module Interface below. Do not search report directories for examples or conventions.
  - The module owns the frozen contract, batch collector, and scoring functions. It must not read stdin, emit output, or depend on the CAO or report adapters.
  - Reuse the standard package-level `operational-value.mjs` adapter for every workflow in a campaign. It discovers all modules under the campaign's `operational-value/` directory, collects one current observation per supported repository and module, and emits namespaced CAO JSONL IDs in the form `WORKFLOW-SLUG.METRIC-ID`. Namespacing prevents collisions between workflows in the same campaign.
  - For a campaign, run `.github/skills/add-operational-value/scripts/wire-campaign.mjs CAMPAIGN-SLUG WORKFLOW-NAME`. It creates the standard adapter only when absent, refuses to overwrite a nonstandard adapter, and idempotently includes the adapter and selected module in `aw.yml`. Resolve a nonstandard existing adapter deliberately; never replace it automatically.
  - Without a campaign manifest, create the standard adapter beside the module but do not create or enroll a campaign solely to host an evaluation example.
  - Run `.github/skills/add-operational-value/scripts/verify-value-function.mjs --collector --cao-adapter <adapter> <path>` and do not report success unless it passes.
  - Report the outcome contract, evidence shape, metrics and roles, agreement or disagreement, rejected metrics, limitations, selected model, generated module and adapter, and successful verification command. Do not create evaluation artifacts yet.

7. **Offer deterministic evaluation.** Ask whether to evaluate the verified function now. If declined, stop. If accepted, capture one UTC endpoint and run:

  ```bash
  END_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  .github/skills/add-operational-value/scripts/evaluate.mjs --end "$END_AT" [--campaign CAMPAIGN-SLUG] OWNER/REPO WORKFLOW-NAME
  ```

  Use the repository and slug from the verified definition. Never let evaluation evidence alter the frozen function, contract, formulas, targets, roles, or classification. Use `--refresh` only when explicitly requested. Report the endpoint and artifact paths. Describe baseline-comparable results as association, attainment-only results as attainment, and neither as causation. State that evaluation artifacts were generated deterministically from the frozen function. Offer AI interpretation only with explicit consent and label it as interpretation.

## Design Invariants

### Evidence

- Design ex ante: use only outcome facts known by the baseline commit. Use the adoption commit only for the workflow and contemporaneous repository context.
- Use files, history, pull requests, issues, and other relevant data from the repository or repositories where the outcome occurs. For mutable records, reconstruct state at the baseline cutoff; do not use current fields or later events.
- Document the observation window before scoring. Every collected window must use the same duration, filters, opportunity denominator, maturation period, evidence shape, and formulas. Baseline-comparable designs apply this contract on both sides of adoption; attainment-only designs begin at adoption.
- Use the least dense evidence sampling that directly measures the outcome. For repository-state outcomes, prefer one immutable cutoff snapshot per observation window; use daily or per-event assessments only when the accepted-outcome matching rule requires them.
- Prefer `gh api` queries with immutable refs. Use archive streams only when repository-wide file inspection is necessary.
- Temporary checkouts and extracted evidence must remain under the workspace and be removed by the command that creates them.

### Metrics

- Safe-output creation is activity, not acceptance. When relevant, classify its later repository state as `accepted`, `rejected`, `pending`, `ignored`, or normal lifecycle behavior after the fixed maturation period.
- Use the same evidence shape and formula for every window. The function scores one window; it never accepts `{before, after}` or calculates improvement.
- Preserve both the native measure and normalized target attainment. Higher normalized scores always mean better goal attainment, including native decrease goals.
- Derive metrics, targets, normalization, and weights only from the workflow goal, documented repository standards, and pre-adoption evidence. Never tune them using post-adoption results.
- Prefer direct outcomes and opportunity-normalized rates over raw counts and weak proxies.
- Treat metric disagreement as evidence; do not average it away.
- Use composites only for distinct dimensions; document weights, gates, overlap, and missing-data behavior.
- For baseline-comparable designs, require a non-null score from collected baseline evidence for every retained metric and reject metrics whose opportunity population is empty at baseline. If defensible baseline evidence is unavailable but the future contract is valid, classify the design as attainment-only and state the missing historical interface. Do not fabricate evidence or convert absence of workflow-generated traces into zero outcome attainment.

### Shared Module Interface

- The value function is a self-contained importable ECMAScript module and uses only Node.js built-in modules plus the `gh` CLI.
- It exports `definition`, the current JSON contract containing `schemaVersion`, repository, workflow, adoption, `evaluation.mode`, frozen evidence contract, model, summary, metrics, and validation examples. Mode is `baseline-comparable` or `attainment-only`. `schemaVersion` is the only interface version; do not add separate collector version or command metadata.
- It exports `collectBatch(requests, context)`, which accepts every requested `{windowStart, windowEnd, observedAt}` object as one array and returns one collection result per window in the same order. A CAO adapter may additionally supply `repository` on each request and `database` in context.
- Collect repository state at the last immutable commit at or before `windowEnd`; `observedAt` records when matured evidence is available and is not the repository-state cutoff.
- Batch remote queries across all windows. Fetch each immutable commit, archive, issue set, pull-request set, or event stream at most once, then derive every observation locally. Apply date and state filters in GitHub API queries whenever the API supports them.
- Each collection result contains `evidence`, non-empty immutable `provenance`, and an optional `commit`. Do not make one API request per window when one paginated or GraphQL query can supply the shared source data.
- `evidence` includes non-empty `key`, `repositories`, `opportunity`, `filters`, `collection`, and `window` fields. `window` defines positive `durationDays` and `cadenceDays` plus non-negative `maturationDays`.
- Each metric records `id`, `name`, `role`, normalized `formula`, native `direction`, and presentation. Use `identity` for increase goals and `complement` for decrease goals; name complemented measures honestly. Exactly one metric is primary.
- It exports `scoreMetric(id, evidence)`, which returns a deterministic number in `0..1`, or `null` for missing or wholly malformed evidence. Clamp and round only at the output boundary.
- Include `targetAttained`, `targetMissed`, `missing`, and `malformed` validation examples for every metric. `targetAttained` must score higher than `targetMissed`.
- The collector acceptance gate must validate evidence and provenance. Temporary evidence must be removed in `finally` cleanup.

### CAO Adapter Interface

- The package-level adapter reads one `{schemaVersion: 1, timestamp, repositories, database}` request from stdin and discovers every slug-named `.mjs` module directly under its `operational-value/` directory.
- For each module, it derives one current observation window per supported repository from the frozen duration and maturation period. Routine CAO collection must never rebuild historical windows.
- It calls each module's `collectBatch` once for all supported repositories and calls `scoreMetric` for every metric using the returned evidence.
- It emits one JSONL record per non-null metric with exactly `timestamp`, `repository`, namespaced `valueId` (`WORKFLOW-SLUG.METRIC-ID`), and finite numeric `value`.
- It emits no record for unsupported repositories and fails closed on malformed requests, inaccessible evidence, or invalid collection results.
- Historical evaluation and CAO collection must import the same shared module so evidence and scoring cannot drift.
  