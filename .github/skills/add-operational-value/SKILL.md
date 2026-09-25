---
name: add-operational-value
description: "Design and optionally evaluate a deterministic operational-value measure for a GitHub Agentic Workflow using pre-adoption evidence. Use for workflow or campaign-scoped selection, outcome contracts, value functions, baseline comparison, and attainment evaluation. Usage: /add-operational-value OWNER/REPO [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]."
argument-hint: "OWNER/REPO [WORKFLOW-NAME] [--campaign CAMPAIGN-SLUG]"
allowed-tools: bash node gh
metadata:
  version: "0.6.0"
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

Do not confuse workflow adoption with creation of the measured phenomenon. Before classifying any measure, ask: **Could this exact repository outcome and native measure exist before the workflow was adopted?** AIC per successful run, failure rate, file size, issue resolution, and other repository outcomes often predate the workflow even when the workflow-specific recommendation, trace, or output does not. Test the outcome measure itself, not the workflow mechanism.

## Inputs

Use `/add-operational-value OWNER/REPO` to list repository workflows or `/add-operational-value OWNER/REPO WORKFLOW-NAME` to design one. Add `--campaign CAMPAIGN-SLUG` to restrict selection to workflows directly included by one campaign and place the resulting module under that campaign.

- `OWNER/REPO`: repository containing the workflow. Outcome evidence may come from other affected repositories.
- `WORKFLOW-NAME`: filename stem using lowercase letters, numbers, and single hyphens, such as `daily-file-diet`. Do not accept a path or `.md` suffix.
- `CAMPAIGN-SLUG`: optional top-level campaign directory containing `aw.yml`. It scopes workflow selection to directly included workers and owns the shared CAO adapter. Never infer it from a workflow name.
- After validation, set `WORKFLOW-PATH` to `.github/workflows/WORKFLOW-NAME.md` and use `WORKFLOW-NAME` unchanged as the slug.
- Never infer the repository, workflow, or campaign from the workspace, environment, or Git remotes.

## Workflow

1. **Resolve the workflow.**
  - Without `WORKFLOW-NAME`, run `.github/skills/add-operational-value/scripts/list-repository-workflows.mjs OWNER/REPO`, appending `--campaign CAMPAIGN-SLUG` when supplied. Campaign-scoped results contain only directly included worker workflows; never offer an orchestrator as a choice. Reproduce every returned name in the assistant response as a Markdown list, ask the user to select one, and stop. Tool output is not user-visible; never say the list is "shown above." Do not summarize or truncate it.
  - With `WORKFLOW-NAME`, run the same command with `WORKFLOW-NAME` before the optional campaign flag. Use its output as `WORKFLOW-PATH`. Campaign-scoped resolution must reject orchestrators and workflows not directly included by that campaign. If resolution fails, ask for a valid name.
  - Design exactly one selected workflow per invocation. A campaign scopes ownership and selection; it does not combine distinct workflow outcome contracts.

2. **Protect an existing design.** Run `.github/skills/add-operational-value/scripts/value-function-path.mjs OWNER/REPO WORKFLOW-NAME [CAMPAIGN-SLUG]`. Without a campaign, the default package is `WORKFLOW-NAME`. With a campaign, the canonical module is `CAMPAIGN-SLUG/operational-value/WORKFLOW-NAME.mjs` and the shared adapter is `CAMPAIGN-SLUG/operational-value.mjs`. If the module exists, verify it with `.github/skills/add-operational-value/scripts/verify-value-function.mjs --cao-adapter <adapter> <path>`, report that it was left unchanged, and continue at step 7. Do not inspect post-adoption evidence or redesign it.

3. **Recover adoption-time intent and measurements.** Run `.github/skills/add-operational-value/scripts/extract-workflow-intent.mjs OWNER/REPO WORKFLOW-PATH`. Treat its adoption commit as adoption and its first parent as the baseline; if there is no parent, no historical baseline exists. Infer intent from adoption-time frontmatter, imports, instructions, and compiled workflow. Use triggers and skip rules to identify opportunities, and checkout, tools, permissions, and safe outputs to identify accessible or affected repositories.
  - Inventory every measure that adoption-time deterministic setup or precompute calculates, gates, ranks, or passes to the agent.
  - Inventory every measure the workflow instructions explicitly require the agent to calculate, compare, preserve, or use as an acceptance check.
  - Inventory which required facts already exist in canonical CAO collections and can be selected with a declarative query. Record the collection, fields, relationships, authoritative timestamps, and source-retention limit.
  - Inventory which required facts exist only in repository history or content, such as files, syntax, dependencies, ownership, commits, diffs, issue state, or pull-request state. Record the repository and immutable cutoff needed to reconstruct them.
  - Preserve each measure's exact target repository, population, grain, evidence window, filters, comparison rule, and missing-data behavior. A target checkout is strong evidence that the measured outcome belongs to that target, not to the repository hosting the workflow.
  - Treat these workflow-native measures as the first operational-value candidates. They are not automatically value: classify each as a direct repository outcome, an acceptance gate, a diagnostic, or a mechanism/output proxy.
  - For every direct-outcome candidate, perform an **antecedent-existence test** before choosing an evaluation mode:
    1. Could the same eligible opportunity and repository outcome occur before adoption, including through human or other automation?
    2. Could the same native formula, unit, population, grain, filters, and window be applied before adoption without referring to a workflow-generated artifact?
    3. Which authoritative facts would reconstruct that pre-adoption measure, and were those facts retained, preserved, or immutable?
  - Record one result per candidate: `pre-existing-and-reconstructable`, `pre-existing-but-not-reconstructable`, or `created-at-adoption`. Never infer `created-at-adoption` merely because the current collector, event type, recommendation, or workflow trace begins at adoption.

4. **Design and test once.** From adoption-time intent and pre-adoption facts, form one provisional contract and test it with one batched pre-adoption probe. The probe is mandatory for every candidate classified `pre-existing-and-reconstructable`; do not skip it because the workflow was not yet installed or because current reports begin at adoption. Fetch only cutoffs at or before the baseline commit time; never fetch, inspect, or compare recent or post-adoption outcomes during design. One valid baseline observation is enough to establish comparability. Resolve discoverable facts without asking the user. The contract must include:
  - operational value stated as "For [eligible opportunities], attain [repository outcome], demonstrated by [accepted evidence]";
  - eligible opportunity population;
  - accepted evidence and evidence repositories;
  - deterministic opportunity/outcome matching rule and maturation period;
  - observation window, cadence, evidence shape, and zero-versus-missing rule;
  - evidence source plan, including canonical queries, immutable repository facts, source retention, and historical backfill capability;
  - whether the outcome can occur without the workflow;
  - the antecedent-existence result and evidence for every proposed primary or diagnostic measure;
  - disposition of every workflow-native measure as primary, diagnostic, gate, or rejected proxy;
  - proposed primary and diagnostic measures;
  - classification as baseline-comparable, attainment-only, or not measurable.

  Test workflow-native measures before inventing a new metric. Prefer their established evidence grain, windows, filters, and safeguards whenever they directly measure the intended repository outcome. A proposed estimate, self-assessment, recommendation, or produced report remains a mechanism proxy until repository-observable evidence demonstrates attainment.

  Choose evidence sources in this order:
  1. Use a declarative query over canonical CAO data when it contains the authoritative facts and its retention covers the observation being collected.
  2. Use `gh api` at immutable commits or historical event cutoffs for GitHub and repository facts that canonical data does not contain.
  3. Use an archive or temporary checkout of the target repository at the immutable cutoff only when repository-wide file or code inspection is necessary.
  4. Combine queried activity facts with immutable repository facts when the outcome contract requires both. Join them inside the collector's evidence object; do not derive business state in dashboard or presentation code.

  Source convenience never changes the outcome contract. Do not replace missing code, Git, issue, pull-request, or acceptance evidence with an available run metric. Do not clone or inspect the control repository when the outcome occurs in a dispatched target repository.

  Apply this test: **if a person achieved the intended outcome without the workflow, would the primary measure record success?** If not, it measures mechanism rather than operational value. Use one workspace-local temporary directory for the entire probe, reuse downloaded evidence, and remove it afterward. Use `gh api` for GitHub data; do not use `/tmp`, `${TMPDIR}`, `curl`, or `wget`.

  Classify the tested contract:
  - **Baseline-comparable:** the measured phenomenon existed before adoption and valid comparable outcome evidence can be reconstructed. Apply one symmetric measure before and after adoption. This is the required classification whenever at least one valid baseline observation exists.
  - **Attainment-only:** the future outcome contract is valid, but either the measured phenomenon was genuinely created at adoption or it pre-existed and the same measure cannot be reconstructed after exhausting canonical, preserved, and immutable evidence. Begin at adoption and report no improvement. State which of those two reasons applies; “the workflow did not exist yet” is not sufficient.
  - **Not measurable:** no deterministic opportunity population, repository outcome, or accepted-evidence rule can be defined. State what is missing and stop without creating a function.

  Eligible opportunities plus evidence that none attained the outcome may establish zero; absent evidence does not. Never treat missing workflow-generated traces as zero when the outcome could occur another way.

5. **Confirm once.** Present the tested operational value, complete contract, retained and rejected metrics, and classification in one concise response. Ask one confirmation question covering the whole design. Stop there; do not inspect implementation scripts or begin implementation until the user confirms. Do not ask separate outcome, contract, metric, or classification questions. Ask earlier only when one unresolved decision prevents a valid pre-adoption probe.

6. **Implement and freeze.** For a confirmed measurable design:
  - Freeze the confirmed evidence object, collection plan, metric roles, formulas, and classification. Do not reconsider or replace them during implementation.
  - Reuse deterministic adoption-time measurement logic when it is still the confirmed source of a retained measure. Extract a shared helper when practical so workflow precompute and repository-level evaluation cannot drift; otherwise port the exact grain, window, filters, and missing-data behavior and test their parity.
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
- Always separate **phenomenon existence** from **evidence availability**. First decide whether the exact outcome and native measure existed before adoption; then decide whether its facts can be reconstructed. A missing historical source can justify `pre-existing-but-not-reconstructable`, but it cannot turn a pre-existing measure into a post-adoption-only phenomenon.
- Apply the same-formula counterfactual: remove the workflow from the historical picture and ask whether the metric still has a coherent numerator, denominator, unit, population, and timestamp. If yes, probe it before adoption. Workflow-specific recommendations, traces, and outputs may disappear in this test; the repository outcome must not.
- Prefer baseline comparison whenever the measured phenomenon predates adoption. Attainment-only is a fallback after an explicit failed reconstruction, not the default for a newly installed workflow.
- Evaluate evidence in the repository where the intended outcome occurs. When the workflow checks out or names a target repository, do not substitute the workflow-owning or control repository merely because execution happens there.
- Use files, history, pull requests, issues, and other relevant data already present in canonical CAO data, persisted precomputations, or an available target-repository checkout. For mutable records, reconstruct state at the baseline cutoff; do not use current fields or later events.
- Treat canonical CAO queries as the preferred access path for facts they authoritatively contain. Query retention is a source limitation, not the operational-value history window.
- Operational-value history begins at adoption for attainment-only designs and includes the fixed pre-adoption baseline for baseline-comparable designs. Routine CAO collection publishes only the current observation; explicit historical evaluation incrementally fills every reconstructable cadence-aligned observation and preserves accepted snapshots in the evidence archive.
- A short-lived source such as a rolling Activity database may support current observations without supporting historical backfill. If an older observation can be reconstructed from immutable Git or GitHub history, reconstruct it. If it depended on expired run, usage, artifact, queue, or tool-call facts, report that interval as missing unless a contemporaneous accepted snapshot was preserved. Never shorten the claimed history to the source-retention window or synthesize older values from the oldest available record.
- Record enough provenance to distinguish a live canonical query, an immutable repository reconstruction, and a preserved contemporaneous snapshot. Historical evaluation must reuse a preserved snapshot rather than reinterpret old evidence under a newer contract.
- Document the observation window before scoring. Every collected window must use the same duration, filters, opportunity denominator, maturation period, evidence shape, and formulas. Baseline-comparable designs apply this contract on both sides of adoption; attainment-only designs begin at adoption.
- Attainment-only collection may publish observations from adoption onward before a full window has matured. During that interval, collect the bounded partial post-adoption window from adoption through observation time rather than a pre-adoption window. Mark every such observation `maturityStatus: "interim"` and `dubious: true`, and describe its score as provisional rather than accepted attainment. Do not suppress an otherwise valid early observation solely because its window or outcomes are still maturing.
- Early observations must use the frozen formula and the evidence available at their observation time. Distinguish provisional zero from missing evidence, preserve unresolved counts, and never relabel an interim score as matured or use it to claim improvement.
- Use the least dense evidence sampling that directly measures the outcome. For repository-state outcomes, prefer one immutable cutoff snapshot per observation window; use daily or per-event assessments only when the accepted-outcome matching rule requires them.
- Do not call GitHub APIs to evaluate an interactive or historical window. API acquisition is too costly and rate-limited for arbitrary comparison. Precompute missing Git or repository facts during bounded Activity collection and persist them canonically; if a required fact was not preserved and is not available in a local checkout, mark that interval missing.
- Temporary checkouts and extracted evidence must remain under the workspace and be removed by the command that creates them.
- Every evaluator accepts explicit inclusive `windowStart` and exclusive `windowEnd` inputs. A dashboard may request any bounded windows covered by retained canonical data, preserved observations, persisted precomputations, or a local checkout; the evaluator must not hard-code a 30-day analytical limit.
- For `baseline-comparable` workflows, support two user-selected windows: one wholly before adoption and one at or after adoption. Apply the same metric formula, eligibility rules, and unit to both windows, then report the direction-aware native delta. If either window lacks sufficient evidence, the comparison is missing.
- For `attainment-only` workflows, never invent a pre-adoption baseline. Evaluate the selected post-adoption window as a temporal series at the declared cadence and report direction-aware trend only when at least two complete observations exist. A single observation is attainment, not a trend.
- If pre-adoption evidence later becomes available for an attainment-only workflow, require a reviewed contract change before reclassifying it as baseline-comparable; do not silently change evaluation mode from a dashboard interaction. Treat discovery that the phenomenon predated adoption as a classification-review trigger even when evidence is still incomplete.

### Metrics

- Workflow-native measures from deterministic precompute and explicit workflow instructions are presumptive candidates. Retain them when they directly measure the intended repository outcome; otherwise preserve them only as gates or diagnostics, or reject them with a specific reason.
- Do not silently replace an established workflow-native grain, denominator, evidence window, safeguard, or missing-data rule with a convenient dashboard or collector proxy.
- Safe-output creation is activity, not acceptance. When relevant, classify its later repository state as `accepted`, `rejected`, `pending`, `ignored`, or normal lifecycle behavior after the fixed maturation period.
- Use the same evidence shape and formula for every window. The function scores one window; it never accepts `{before, after}` or calculates improvement.
- Preserve the native measure and its unit. Do not normalize operational value to `0..1`, complement decrease goals, or invent a dimensionless score solely to make unlike measures share an axis. Use `direction` to state whether higher, lower, maintenance, or proximity to a target is better.
- Derive metrics, targets, units, and weights only from the workflow goal, documented repository standards, and pre-adoption evidence. Never tune them using post-adoption results.
- Prefer direct outcomes and opportunity-normalized rates over raw counts and weak proxies.
- Treat metric disagreement as evidence; do not average it away.
- A repository-scoped metric may declare additive rollup numerator and denominator evidence fields only when summing those fields and dividing the totals is mathematically identical to measuring the combined eligible-opportunity population in the metric's native unit. Never average repository ratios to produce a campaign value.
- Use composites only for distinct dimensions; document weights, gates, overlap, and missing-data behavior.
- For baseline-comparable designs, require a non-null score from collected baseline evidence for every retained metric and reject metrics whose opportunity population is empty at baseline. If defensible baseline evidence is unavailable but the future contract is valid, classify the design as attainment-only and state the missing historical interface. Do not fabricate evidence or convert absence of workflow-generated traces into zero outcome attainment.

### Shared Module Interface

- The value function is a self-contained importable ECMAScript module and uses only Node.js built-in modules plus repository-local deterministic tools. Window evaluation does not call GitHub APIs.
- It exports `definition`, the current JSON contract containing `schemaVersion`, repository, workflow, adoption, `evaluation.mode`, frozen evidence contract, model, summary, metrics, and validation examples. Mode is `baseline-comparable` or `attainment-only`. `schemaVersion` is the only interface version; do not add separate collector version or command metadata.
- It exports `collectBatch(requests, context)`, which accepts every requested `{windowStart, windowEnd, observedAt}` object as one array and returns one collection result per window in the same order. A CAO adapter may additionally supply `repository` on each request and `database` in context.
- When `context.database` contains the authoritative facts, execute bounded canonical queries for all requested windows. Use persisted precomputations or an available immutable target-repository checkout for evidence absent from that database; otherwise return missing evidence.
- Collect repository state at the last immutable commit at or before `windowEnd`; `observedAt` records when matured evidence is available and is not the repository-state cutoff.
- Batch local evidence reads across all windows. Reuse each canonical projection, preserved snapshot, or checked-out immutable commit, then derive every observation locally.
- Each collection result contains `evidence`, non-empty immutable `provenance`, and an optional `commit`. Never make one remote request per selected window.
- `evidence` includes non-empty `key`, `repositories`, `opportunity`, `filters`, `collection`, and `window` fields. `window` defines positive `durationDays` and `cadenceDays` plus non-negative `maturationDays`.
- Each metric records `id`, `name`, `role`, native `formula`, `direction`, `unit`, and presentation. Presentation uses `identity`; consumers format the native unit and interpret movement using `direction`. Exactly one metric is primary.
- A metric that supports a campaign rollup may additionally declare `rollup: { numeratorField, denominatorField }`. Both fields must identify non-negative additive evidence values and the denominator must be positive. Their quotient must have the metric's declared native unit; the numerator may exceed the denominator.
- It exports `scoreMetric(id, evidence)`, which returns a deterministic finite native-unit number, or `null` for missing or wholly malformed evidence. Round only at the output boundary; do not clamp to a normalized range.
- A metric may return a provisional number for valid interim evidence. The evidence must carry `maturityStatus: "interim"` and `dubious: true`; adapters and reports must preserve that status wherever the number is shown.
- Include `targetAttained`, `targetMissed`, `missing`, and `malformed` validation examples for every metric. `targetAttained` must score higher than `targetMissed`.
- The collector acceptance gate must validate evidence and provenance. Temporary evidence must be removed in `finally` cleanup.

### CAO Adapter Interface

- The package-level adapter reads one `{schemaVersion: 1, timestamp, repositories, database}` request from stdin and discovers every slug-named `.mjs` module directly under its `operational-value/` directory.
- For each module, it derives one current observation window per supported repository from the frozen duration and maturation period. Routine CAO collection must never rebuild historical windows.
- It calls each module's `collectBatch` once for all supported repositories and calls `scoreMetric` for every metric using the returned evidence.
- It emits one JSONL record per non-null metric with required `timestamp`, `repository`, namespaced `valueId` (`WORKFLOW-SLUG.METRIC-ID`), finite native-unit numeric `value`, and `metricUnit`, plus the metric and maturity metadata needed by consumers.
- For a metric with a declared rollup, it also emits finite `rollupNumerator` and `rollupDenominator` values from the same accepted evidence. Consumers may derive a campaign value only as the sum of numerators divided by the sum of denominators.
- It may emit provisional pre-maturity values, but must include their interim maturity status and workflow adoption timestamp so consumers can mark them dubious and place adoption in temporal plots.
- It emits no record for unsupported repositories and fails closed on malformed requests, inaccessible evidence, or invalid collection results.
- Historical evaluation and CAO collection must import the same shared module so evidence and scoring cannot drift.
