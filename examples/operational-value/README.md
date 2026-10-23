# Operational-value reference prototype

**Design reference only.** This standalone storyboard and dependency-free
synthetic model explore later repository observations and optional
linked-integration diagnostics. They are not a production collector, dashboard
view, forecasting engine, or replacement for gh-aw execution, safe outputs,
native queues, per-run graders, or native replay.

Nothing here acquires live evidence, changes registration or policy, enrolls a
repository, or deploys a service. The JSON is a synthetic study and replay
fixture, not a canonical CAO evidence packet.

## Artifacts

| File | Purpose |
| --- | --- |
| [value-storyboard.html](value-storyboard.html) | Self-contained seven-scene HTML/CSS/JS storyboard, contract notes, research references, and study results. |
| [value-graph-model.mjs](value-graph-model.mjs) | Synthetic objects, context-aware subtree reuse, independent question deadlines, immutable captures, and in-process publication coordination. |
| [value-graph-model.test.mjs](value-graph-model.test.mjs) | 51 Node built-in tests, including 1,000 deterministic mutations across four seeds. |
| [value-graph-study.mjs](value-graph-study.mjs) | Four-layout operation-count study generator and offline replay runner. |
| [value-graph-study.json](value-graph-study.json) | Generated results, model/runtime identity, and the actual retained replay inputs. |

Keep these files together. Open `value-storyboard.html` in a browser from a
local checkout; GitHub displays its source rather than running it. All styles
and scripts are inline, and the four artifact links are relative. The research
links are optional external reading, not runtime dependencies.

## Two different examples

| Example | Metric and evidence |
| --- | --- |
| Storyboard | Fictional counts of non-test Go files under `pkg/` with **at least 800 lines**. One linked change improves 6 to 4 while the repository goes from 6 to 7. Behavior preservation is **not established**. |
| Executable study | Synthetic `.js` files under `src/`, excluding `.test.js`, with **more than 10 lines**. Each layout has 100,000 eligible files with 100,000 distinct baseline contents, warm caches, and three new blob contents. |

Both benchmark strategies already cache blobs. Subtree reuse reduces logical
tree-entry and eligible-file visits for localized changes; it does not reduce
the three new blob measurements. Flat layouts and changes across every
directory show no traversal reduction. These are not GitHub API-call savings
or wall-clock production speedups.

## Run and replay

Use Node.js 24 or newer; no npm dependencies or GitHub credentials are needed.
The checked-in fixture is pinned to **Node v24.21.0** and the exact model source
SHA-256 recorded in `value-graph-study.json`. Replay requires both identities to
match, including the Node patch version.

From the repository root, with that runtime selected:

```sh
cd examples/operational-value
node --test value-graph-model.test.mjs
node value-graph-study.mjs --replay
```

Replay reads the saved inputs without live acquisition or rewriting the
fixture. The retained example reproduces one synthetic reduction at effective
time 60, captured at time 67; these are model clock values, not real dates.

To deliberately regenerate the study and replace its saved fixture:

```sh
node value-graph-study.mjs
node value-graph-study.mjs --replay
```

Generation writes `value-graph-study.json` beside the script. Review the diff
and keep the storyboard's displayed counts consistent. If the model source or
runtime changes, regenerate and review a new fixture; do not weaken the replay
identity checks or describe regenerated evidence as replay of the old fixture.

## Interpretation boundaries

Safe outputs are native evidence, not a universal pending/accepted business
lifecycle. Explicit reviewed questions determine downstream watches. Fixed
repository cadence includes every contributor; per-question deadlines preserve
other questions' maturity boundaries and allow dormant human waits and retired
immutable questions.

First-parent comparison requires a verified merge or squash boundary.
Multi-commit rebases need the whole verified integration range. A grouped
integration has one numeric fact with multiple links, not full credit for each
PR. Unknown boundaries stay unknown; zero and negative changes remain visible.
Identical contents are measured once but counted at every eligible path.
Cross-file or global metrics require additional dependencies or broader work.

Event/effective time, capture time, and first publication availability are
distinct. Late publication cannot backfill historical forecasting knowledge,
and retries cannot invent freshness or silently rewrite immutable facts.

The model assumes verified inputs and atomic in-process coordination. It does
not implement GitHub admission, a Git parser, distributed leases, production
storage, access controls, or a security proof. Forecast paths are illustrative
scenarios, not fitted predictions. Canonical-history pruning still needs a
separately reviewed, versioned coverage/retention contract.

For implemented behavior, see [Operational Value](../../docs/operational-value.md)
and the [canonical dashboard data specification](../../specs/dashboard-data.md).
This example changes neither contract.
