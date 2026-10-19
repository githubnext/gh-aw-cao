# Reusable-call cohort: reproducible receipt and limitations

Cohort: `github/gh-aw` — `smoke-workflow-call` (worker, `workflow_call`-context checkout) and
`smoke-call-workflow` (orchestrator, `call-workflow` safe-output invocation/input reachability).
Frozen source revision `c86377ec47b38f0b5af463277ee55d1d03d08da8`, cutoff `2026-10-18T15:00:12Z`,
repository ID `1036865607`.

## 1. Source grounding (independently reproducible)

Acquired via plain, unauthenticated `git` smart-HTTP against
`https://github.com/github/gh-aw.git` (reachable in this environment; `api.github.com` was not —
see §3). No `gh api`, browser, or MCP GitHub tool was used for this step.

```sh
git init --bare gh-aw.git
git -C gh-aw.git -c safe.bareRepository=explicit fetch --filter=blob:none --unshallow \
  origin c86377ec47b38f0b5af463277ee55d1d03d08da8
```

Verified facts (all reproducible by re-running the commands shown):

| Fact | Value |
|---|---|
| `smoke-workflow-call.md` blob | `4c18d992aaa8ceee3bcc4b0a5bcb505d7a79758b` |
| `smoke-call-workflow.md` blob | `7e126368cd292d93519d66aa3a317c46db414a51` |
| `smoke-workflow-call.lock.yml` blob | `8a4ebdd786a55296e7d7f5beeb09cade276b4db9` |
| `smoke-call-workflow.lock.yml` blob | `631f36c009524dfbf35a1244ad07f012e2343de0` |
| Worker adoption commit / time | `90f9f26129d3964aeee669d782d3adf2244c57d5` / `2026-02-27T18:15:46Z` |
| Worker baseline commit / time (file absent) | `23d39f6bb5af0cebff381500b6cacabde8229466` / `2026-02-27T18:15:38Z` |
| Orchestrator adoption commit / time | `01de4d31085d484d9106892609ac17da2ba09f2d` / `2026-03-13T20:15:06Z` |
| Orchestrator baseline commit / time (file absent) | `45de2430ee97a2ab208d963703f071bf6ee664ef` / `2026-03-13T19:39:24Z` |

Reproduce with:

```sh
git -C gh-aw.git ls-tree c86377ec47b38f0b5af463277ee55d1d03d08da8 -- \
  .github/workflows/smoke-workflow-call.md .github/workflows/smoke-call-workflow.md \
  .github/workflows/smoke-workflow-call.lock.yml .github/workflows/smoke-call-workflow.lock.yml
git -C gh-aw.git log --first-parent --diff-filter=A --format=%H%x09%cI -- \
  .github/workflows/smoke-workflow-call.md
git -C gh-aw.git log --first-parent --diff-filter=A --format=%H%x09%cI -- \
  .github/workflows/smoke-call-workflow.md
```

## 2. Architecture read from the compiled lock files, not inferred

`smoke-call-workflow.lock.yml` compiles the `call-workflow` safe output into a **compile-time
fan-out**: a job named `call-smoke-workflow-call` with
`uses: ./.github/workflows/smoke-workflow-call.lock.yml`, receiving `aw_context`, `payload`, and
`task-description` from `fromJSON(needs.safe_outputs.outputs.call_workflow_payload)`. This runs
the worker **nested inside the orchestrator's own run id**, not as a new independent
`workflow_call`-triggered run of the worker. Consequently the worker's own run list (observed via
the production run-history evidence below: 70 runs, all `schedule`/`workflow_dispatch`) never
contains a `workflow_call`-context execution — a worker "opportunity" is only knowable from the
orchestrator's own independently verified dispatch, which both modules preserve via
`orchestratorDispatched`/role-conditional eligibility rather than reading it off the worker's own
triggers.

The orchestrator's agent instructions (full `smoke-call-workflow.md` body) require passing the
literal string `"smoke test checkout validation"` as `task-description`; the worker's own default
(`workflow_call.inputs.task-description`) is `"validate workflow_call checkout"` — these are
deliberately distinct, so a correctly-coupled invocation is only confirmable by checking the
*orchestrator's resolved* `task-description` value against the *orchestrator's own* literal, not
by reading the worker's default back.

## 3. Acquisition attempts in this measurement session (all failed, honestly recorded)

```
$ gh api repos/github/gh-aw
gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.
(exit 4; no GH_TOKEN/GITHUB_TOKEN available in this sandbox)

$ curl -sS --fail --max-time 20 https://api.github.com/repos/github/gh-aw
curl: (22) The requested URL returned error: 403
(body: "Blocked by DNS monitoring proxy" — an infrastructure-level block in this sandbox,
not a GitHub-side error; raw.githubusercontent.com and git smart-HTTP to github.com remained
reachable throughout)
```

These exact three attempts (`gh api repos/...`, `gh api .../actions/workflows/.../runs`,
`curl https://api.github.com/repos/github/gh-aw`) are reproduced programmatically by
`collectReusableCallEvidence()` in `scripts/collect-reusable-call-value.mjs` and are recorded
verbatim (`detail` strings above) in both
`docs/operational-value/proof/reusable-call/{smoke-workflow-call,smoke-call-workflow}/index.json`
under `acquisitionAttempts`, each with `ok: false`. No GitHub Actions run, job, log, or comment for
either workflow was read or fabricated. `classification: "blocked-acquisition"` and
`inventoryRuns: 0` / `inventoryComplete: false` are the honest result — not a zero outcome, a
**missing-evidence** state, kept distinct per the skill's "unknown is null, not zero" rule.

The shared, complete production `readOutputHistory` evidence
(346 partitions, 58,048 entities) was consulted only for **discovery** (confirming the worker's
70-run schedule/workflow_dispatch-only trigger mix, i.e. that no independent `workflow_call` runs
exist in its own history) — not as a substitute source of run/job-level outcome evidence for
either module, consistent with the "comments/run success are discovery, not outcome" instruction.

## 4. Deterministic modules and controls

Both `reusableCallOpportunity`/`assessReusableCallReceipt`/`scoreReusableCallMetric` (role-
parameterized for `"worker"` and `"orchestrator"` from the same frozen contract) are pure,
no-model, no-network functions. `tests/unit/operational-value-reusable-call.test.mjs` (14 tests,
all passing) exercises:

- **Positive controls**: exact head/ref + clean Git-state conjunction (worker); exact declared
  lock file + literal task-description (orchestrator) → `attained: true`.
- **Negative controls**: wrong head/ref, wrong declared file, wrong resolved task-description,
  `dispatched: false` → `attained: false` (a verified miss, not `null`).
- **Partial-evidence preservation**: deleting only `clean` (worker) or only
  `taskDescriptionActual` (orchestrator) keeps `headMatches: true` while collapsing only
  `attained` to `null` — partial independent evidence is retained rather than erased.
- **Missing evidence**: absent/blocked acquisition → every snapshot metric is `null` end-to-end
  through `evaluate.mjs --refresh` (confirmed over all ~32–34 periods in both timelines).
  Disjoint periods replay identically (`null`, never `0`).
- **Tampered custody**: 9 field-deletion/mutation scenarios across both roles (run identity,
  source policy admission, nested-lock blob identity) each collapse to `attained: null`/
  `eligible` unaffected as appropriate — never a false positive.
- **Frozen-interpreter / frozen-contract self-checks**: a post-authoring byte change to
  `scripts/collect-reusable-call-value.mjs` is rejected (`Frozen reusable-call interpreter
  changed`); a changed or missing on-disk evidence file is rejected
  (`ERR_MODULE_NOT_FOUND`/digest-mismatch) rather than silently scored.

## 5. Validations run (all passing after final fixes)

```sh
node --check scripts/collect-reusable-call-value.mjs
node .github/skills/add-operational-value/scripts/verify-value-function.mjs \
  docs/operational-value/proof/functions/smoke-workflow-call.mjs
node .github/skills/add-operational-value/scripts/verify-value-function.mjs \
  docs/operational-value/proof/functions/smoke-call-workflow.mjs
node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector \
  docs/operational-value/proof/functions/smoke-workflow-call.mjs
node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector \
  docs/operational-value/proof/functions/smoke-call-workflow.mjs
node .github/skills/add-operational-value/scripts/evaluate.mjs --root . \
  --end 2026-10-18T15:00:12Z \
  --function docs/operational-value/proof/functions/smoke-workflow-call.mjs --refresh \
  github/gh-aw smoke-workflow-call
node .github/skills/add-operational-value/scripts/evaluate.mjs --root . \
  --end 2026-10-18T15:00:12Z \
  --function docs/operational-value/proof/functions/smoke-call-workflow.mjs --refresh \
  github/gh-aw smoke-call-workflow
node --test tests/unit/operational-value-reusable-call.test.mjs   # 14/14 pass
npm run typecheck:cao                                             # clean
npm test                                                           # 21 pre-existing baseline
                                                                    # failures, unchanged;
                                                                    # 14 new tests added, all pass
```

All artifacts in `docs/operational-value/proof/reusable-call/**` and the generated reports in
`docs/operational-value/reports/github-gh-aw/{smoke-workflow-call,smoke-call-workflow}-*` are
≤68KB (well under the 256KiB per-artifact limit); `index.json`/`contract.json` use
`writeCensusJson`, which auto-partitions above 256KiB (not needed here).

## 6. Limitations (explicit, not papered over)

- **No real run/job/log evidence was acquired** for either workflow in this session: the sandbox's
  network restrictions (confirmed `api.github.com` → HTTP 403 "Blocked by DNS monitoring proxy";
  `gh api` → exit 4, no `GH_TOKEN`) made Actions API acquisition impossible. Both modules are
  therefore fully built, source-grounded, and validated, but currently report `null` for every
  metric at every period — an honest **evidence-unavailable** gap report, not a measured zero.
- **Readiness for integration**: both modules' `collectBatch` provenance entries
  (`{repository, kind: "worker-run-inventory"|"orchestrator-run-inventory", ref: censusDigest(index)}`)
  satisfy the portfolio script's `nativeGapReportReady` shape (all-null primary metric + matching
  provenance digest) for the parent to wire in without further changes from me.
  Once run with authenticated `gh` access to `github/gh-aw` (e.g. in CI with `GH_TOKEN`), re-running
  `node scripts/collect-reusable-call-value.mjs collect` will acquire and score real evidence
  without any module-logic change.
- **Attribution and cost** remain explicitly **not measured** (no workflow-linked attribution or
  cost-per-outcome accounting exists yet for this cohort).
- New predicates in this receipt (e.g. the exact architecture/coupling facts) were derived by
  reading the frozen Markdown and compiled lock/effective executor directly, and are retrospective
  only — they describe what the frozen source already specifies, not a newly authored acceptance
  rule applied backward.
