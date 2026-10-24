---
title: Dashboard Language
description: Build dashboard views from trusted data with readable, declarative queries.
agent:
  type: query-language
  prominent: true
---

Dashboard Language lets you describe the question a view should answer and how
the answer should appear. Queries are structured YAML: there is no SQL,
JavaScript, or browser-side data processing to maintain.

Use this guide to learn the language and write common queries. Use the
[Dashboard Language Specification](dashboard-language-specification.md) when
you need the complete vocabulary, validation rules, or conformance requirements.
To implement or change a query, read the
[dashboard data model](dashboard-data-model.md) next, then work through the
query engine and worker boundary under `dashboard/site/src/data/`; do not add
main-thread JavaScript data derivation.

## What you can ask

### Design an Agentic Workflow or Campaign

Open **Workflow wizard** (`#page-wizard`) to design a generation prompt. The
first step is a marketplace-style workflow-type gallery: select a mined pattern
or **Custom automation**. Next, choose an AW or Campaign, optionally refine its
task and intent/acceptance criteria, then select triggers and safe outputs
and optional capabilities. Titles and file/package names are inferred from the
intent and selected type, not requested as separate inputs. Campaigns also
require proposed target repositories. Safe outputs are preselected from each
scenario's specific recommendations, not broad permission categories. Change or
clear those choices as needed; optional capabilities remain off by default.
Returning to the same type preserves edits; choosing a different type loads its
output defaults. Preselection does not grant live execution authority.
Task details, acceptance criteria, per-run limits and safety/non-goal refinements
are optional; leave them blank to use the scenario. Fixed safety boundaries still
apply. Back/Next navigation appears below the active pane. Click an earlier step
tab to return directly without losing answers; future steps cannot bypass validation.

On **Scope and behavior**, **Generate** replaces Next at the bottom right.
It validates your answers and opens the full prompt preview directly; there is
no separate Review tab. In the Copilot app canvas, **Start session** creates a new app session with
that prompt. Outside the app, **Copy prompt** copies it for your coding agent.
The prompt is natural language, beginning “Create a Pull Request for the following
task:”. It includes only relevant selected requirements, with Campaign guidance
only for a Campaign, and omits raw pattern JSON, provenance, rankings and anti-patterns.
Both AWs and Campaigns use this flow; opening a preview starts nothing. Starting
a session requires a separate explicit click and never uses `gh agent-task`.
The prompt requests a draft pull request, not installation or live activation.
Draft answers are page-local memory; leaving the page discards them. Never
enter secrets.

The page's steps, conditional fields, choices and generation instructions live
in `dashboard/site/dashboard-fragments/wizard.json`. They use the reusable
`prompt-wizard` element rather than view-specific JavaScript. Its pattern
choices and generation guidance reuse the MIT-licensed dataset mined in
[`githubnext/gh-aw-wizard`](https://github.com/githubnext/gh-aw-wizard). The
configuration records the immutable revision, mining date and license; historical rates
and tips are reference material, not efficacy claims.

To refresh the dataset, review an upstream commit, then run:

```sh
node dashboard/site/scripts/update-wizard-patterns.mjs FULL_UPSTREAM_COMMIT_SHA
```

The importer uses `gh api`, retains the upstream license and provenance, and
updates only pattern/trigger/output/capability choices in the JSON document.
Authored capability labels and descriptions are preserved during refresh.
It does not fetch remote data at page runtime. Review the generated diff and
run dashboard validation and the focused wizard tests before publishing.

### Explore operational evidence

Start with a declared source such as repositories, workflows, runs, domains,
tools, audits, issues, usage, outcomes, or findings. Then combine only the operations the view
needs:

| Query operation | Use it to |
| --- | --- |
| `from` | Choose the source records. |
| `filter` | Keep records that match known field values. |
| `aggregate` | Group records and calculate counts, sums, minima, maxima, or averages. |
| `joins` | Connect compatible declared sources using explicit equality keys. |
| `compute` | Add fields using the language's safe, deterministic functions. |
| `select` | Keep and rename the fields returned to the view. |
| `order-by` | Put results in a predictable order. |
| `limit` | Bound the number of returned rows. |
| `predict` | Add a deterministic regression result when a trend needs one. |
| `window` | Smooth a series or measure absolute, percentage, or elapsed-time change. |

Every reusable query has a `name` and a `subject`. The subject records what its
data is about or intended to show. Its optional `objective` explains why the query
exists or what to improve or understand; `acceptance` states the conditions for
the query to be acceptable. Views use the same three semantic fields.

## A small query

This query answers “Which workflows used the most AI Credits?” It groups usage
by workflow, totals the observed credits, and returns the ten largest results.

```yaml
queries:
  - name: highest-aic-workflows
    subject: Show the workflows with the highest observed AI Credit usage.
    from: usage
    aggregate:
      by: [organization, repository, workflow]
      values:
        - field: aic
          as: total-aic
          reducer: sum
    order-by:
      - field: total-aic
        direction: desc
    limit: 10
```

A view can use `highest-aic-workflows` as its source and present the result as a
metric, table, list, or chart. The query worker reruns it when the underlying
data changes, keeping selection and calculation out of UI components.

## Query building blocks

Use `filter` for direct field matching. Use `aggregate` when the answer is a
summary by repository, workflow, state, model, or time period. Use `joins` only
when the answer spans declared sources, and use `compute` for small typed
operations such as `coalesce`, `concat`, comparisons, date grouping, and number
formatting.

Queries are deliberately constrained. They cannot run scripts, arbitrary SQL,
templates, callbacks, or network requests. This keeps results deterministic,
reviewable, and executable in the dashboard data worker. It also keeps data
selection and business calculations out of UI components.

## Build an interactive simulator

A page can declare a typed `form` whose values feed query `parameters`.
Use a `slider` for a bounded numeric assumption, a `checkbox` for one Boolean
choice, and a `radio` field for one choice from a short ordered set. The
presenter lays fields out automatically and keeps their values in page memory.

```yaml
queries:
  - name: simulated-usage
    subject: Estimate AIC under an operator-selected multiplier.
    parameters:
      - { name: multiplier, type: number }
    from: usage
    compute:
      - as: simulated-aic
        function: product
        args:
          - { field: aic }
          - { parameter: multiplier }

pages:
  - id: simulator
    kind: custom
    title: Performance simulator
    form:
      title: Scenario
      update: { strategy: debounce, delay-ms: 250 }
      fields:
        - id: multiplier
          label: AIC multiplier
          control: slider
          default: 1
          min: 0
          max: 4
          step: 0.25
    views:
      - id: simulated-aic
        data: { source: simulated-usage }
        mark: chart
        chart: line
        encoding:
          x: { field: observed-at, type: temporal }
          y: { field: simulated-aic, type: quantitative }
```

Use `debounce` for sliders that should settle before execution or `throttle`
for continuously sampled feedback. The runtime aborts superseded page
projections and only renders the newest complete result. Form components never
filter or compute data themselves.

## Present the result

Views turn query results into a small set of standard marks:

- `metric` for one important value
- `table` for comparable records and details
- `list` for repeated operational items
- `chart` for comparisons, distributions, and trends
- `callout` for a concise status or attention message
- `element` for a named reusable UI element

Charts support **facets** (small multiples) for comparing categorical subsets:

```json
{
  "id": "workflow-costs",
  "mark": "chart",
  "chart": "bar",
  "facet": { "field": "engine", "type": "nominal" },
  "columns": 2,
  "data": { "source": "usage", "limit": 100 },
  "encoding": {
    "x": { "field": "workflow", "type": "nominal" },
    "y": { "field": "aic", "type": "quantitative", "aggregate": "sum" }
  }
}
```

Use `facet: { row: { field: "engine" }, column: { field: "repository" } }`
for a matrix, or the equivalent `encoding.row` / `encoding.column` shortcuts.
`columns` wraps single-field facets only. The worker handles aggregation and
partitioning, with a maximum of 64 observed panels; mobile stacks the panels.
Each panel has independent scales. See the
[facet contract](dashboard-language-specification.md#faceted-charts-small-multiples)
for ordering, missing data, and the supported Vega-Lite-inspired subset.

### Show a treemap

Use `chart: treemap` for proportional rectangles, optionally nested by one
categorical `section` field. Like Vega-Lite, fields declare their visual
roles: `x` supplies labels, quantitative `y` supplies area, and optional
`color` supplies a categorical palette. Vega-Lite has no native treemap
transform; this layout follows Vega's treemap methods instead.

This view consumes the `highest-aic-workflows` query above:

```yaml
views:
  - id: workflow-aic-treemap
    title: Where are AI Credits concentrated?
    mark: chart
    chart: treemap
    treemap: { method: squarify, ratio: 1.618, padding: 0.5 }
    data: { source: highest-aic-workflows, limit: 10 }
    encoding:
      x: { field: workflow, type: nominal, format: workflow-relative-path }
      y: { field: total-aic, type: quantitative, title: AI Credits }
      section: { field: repository, type: nominal }
      color: { field: repository, type: nominal }
```

`method` supports `squarify` (default), `binary`, and `slicedice`. `ratio`
controls squarify's preferred rectangle aspect ratio from 1 to 5, not the
chart's dimensions. `padding` controls rectangle gutters from 0 to 10 in a
100-by-60 drawing plane. Omit `section` for a flat treemap.

Declare aggregation, filtering, ordering, and limiting in queries, not
encoding aggregates. Every treemap also declares a `data.limit` from 1 to
100, applied by the worker after query execution. Positive finite values
determine area before gutters and group headings; missing and zero values
have no area and are reported explicitly. Negative or non-finite values
produce an explanatory unavailable chart rather than misleading rectangles.
Labels, values, and groups remain available through accessible names and
visible, viewport-bounded tooltips on hover, keyboard focus, or tap, even when a
rectangle is too small for visible text. Escape dismisses a tooltip. An optional
`href` encoding makes leaves keyboard-operable safe links.

For a temporal chart, aggregate observations into buckets before smoothing a
measure or computing its change. A rolling window counts observations, not
elapsed calendar time: seven trailing observations include the current point
and the preceding six, while seven centered observations include three on
either side. Trailing windows are suitable for live dashboards; a centered
window needs future observations and should not present its incomplete newest
points as a complete estimate. A rate of change divides by the actual elapsed
time between consecutive timestamps, so irregularly spaced observations do
not imply a constant sampling interval. The first observation has no previous
value; missing measures and zero percentage-change denominators are not zero
changes. Keep separate series partitioned so one workflow's trend cannot
borrow another workflow's observations.

For example, the following query buckets observed usage per day, takes a
seven-observation trailing mean for each workflow, and computes its daily
growth from the actual elapsed time between observations:

```yaml
queries:
  - name: daily-usage-growth
    subject: Compare changes in daily workflow usage.
    from: usage
    compute:
      - as: day
        function: date-day
        args: [{ field: observed-at }]
    aggregate:
      by: [workflow, day]
      values:
        - { field: aic, as: daily-aic, reducer: sum }
    window:
      - operation: rolling
        field: daily-aic
        as: smoothed-aic
        frame: 7
        reducer: mean
        order-by: [{ field: day, direction: asc }]
        groupby: [workflow]
      - operation: change
        field: smoothed-aic
        as: growth-per-day
        mode: rate
        time-field: day
        unit: day
        order-by: [{ field: day, direction: asc }]
        groupby: [workflow]
```

See the [view catalog](dashboard-view-catalog.md) for available pages, marks,
charts, and named UI elements. For every field, function, validation rule, and
conformance requirement, use the [Dashboard Language Specification](dashboard-language-specification.md).

## Flint chart review: candidate language extensions

This informative review compares
[Microsoft Flint](https://github.com/microsoft/flint-chart/tree/a794557384adcc3293a77043f6b9aff1c33d152c)
with Dashboard Language as of **24 October 2026**. It evaluates design ideas,
not a renderer integration. No new JSON keys or runtime behavior are introduced
by this review; the specification remains authoritative.

**Decision:** borrow Flint's separation of chart meaning and interaction intent,
not its runtime or full chart vocabulary. Prioritize a small declarative
cross-series inspection capability for a follow-up proposal. Consider
query-bound brushing next, only after its parameter and subscription semantics
are specified. Do not add a Flint dependency, backend-native configuration, or
custom interaction callbacks.

### Evidence and capability comparison

The review uses a pinned upstream revision rather than a moving gallery:

- [API reference](https://github.com/microsoft/flint-chart/blob/a794557384adcc3293a77043f6b9aff1c33d152c/docs/api-reference.md):
  semantic field annotations, chart encodings, renderer support, layout limits,
  and validation.
- [Interaction specification](https://github.com/microsoft/flint-chart/blob/a794557384adcc3293a77043f6b9aff1c33d152c/docs/interaction-spec.md):
  named presets, capability requirements, reset gestures, and conflicting
  gesture ownership.
- [Interactive exports](https://github.com/microsoft/flint-chart/blob/a794557384adcc3293a77043f6b9aff1c33d152c/packages/flint-js/src/interactive/index.ts):
  inspection, navigation, chart linking, filter controls, and update contracts.

This is a source/documentation review, not a browser evaluation or performance
benchmark. Flint's interaction specification describes the Vega-Lite interactive
surface; static assemblers do not execute interactions. Multi-backend chart
support therefore does not establish equivalent interaction support.

| Flint idea | Existing Dashboard Language boundary | Recommendation |
| --- | --- | --- |
| `inspect-index`: compare series at one x position | Multi-series lines and per-mark accessible labels/tooltips exist, but there is no authored cross-series inspection preset. | **First candidate:** a bounded interaction declaration on temporal line charts, implemented by the shared renderer. |
| `brush-x` and `linked-brush`: select an interval or related groups | Page forms already bind typed query parameters; filters and subscriptions already execute through the canonical query boundary. Chart gestures are not declared parameter producers. | **Second candidate:** explicit gesture-to-parameter bindings, not a second filtering engine. Start with one temporal interval; defer arbitrary linked selections. |
| Semantic annotations with units, intrinsic domains, category order, and colors | Intrinsic field types, reusable units, canonical ordering, semantic status colors, and stable category palettes already cover much of this intent. | **Reuse first.** Consider explicit ordinal domains only for a demonstrated ordering gap; do not infer units or business meaning from titles. |
| Capability-aware interaction validation and reset policies | The language already validates mark/channel compatibility and rejects unsupported vocabulary. | **Adopt with any interaction extension:** validate prerequisites and gesture conflicts before rendering. Unlike Flint's warning-and-drop behavior, reject unsupported authored behavior rather than silently losing it. |
| Adaptive layout with target and maximum canvas sizes | Responsive layouts, facets, bounded chart payloads, and shared styling already exist. | **Renderer improvement, not new JSON initially.** Measure label collisions and mobile overflow before exposing additional authoring knobs. |
| Broad chart catalog, multiple backends, themes, native Excel export | CAO uses a constrained operational vocabulary and shared Primer styling; chart layers already compose area, bar, line, dot, and rule marks. | **Defer.** Add a mark only for an identified operational question not answered by existing marks/layers. Backend selection, arbitrary themes, and Excel export are separate product decisions. |

The CAO baseline is the specification's
[view contract](dashboard-language-specification.md#11-custom-pages), including
**DLS-VIEW-005**, **DLS-VIEW-037**, and **DLS-VIEW-048**, its field/unit and
palette rules in Section 11.1, and **DLS-FORM-005** /
**DLS-QUERY-027–028** for typed parameter execution. The shared implementation
boundaries are `dashboard/site/src/components/chart-elements.js`,
`dashboard/site/src/chart-layer-specification.js`, and the canonical query
compiler under `dashboard/site/src/data/`.

### First candidate: cross-series inspection

The operational question is: “At this observed time bucket, how do the selected
workflows' or models' values compare?” A shared inspection cursor would avoid
requiring readers to target each series separately.

The follow-up language proposal should describe inspection intent independently
of chart encodings, with a small enumerated vocabulary rather than Flint's
entire preset/options surface. It should define:

- Support initially for temporal line charts with a common query-produced x
  field and compatible units; layered, faceted, and independent-scale charts
  need separate semantics before becoming eligible.
- A bounded, worker-produced comparison payload in deterministic series order.
  Pointer or keyboard movement selects an existing comparison entry; the
  component does not join series, filter source rows, or compute values.
- Exact observed buckets and values, preserving units and evidence quality.
  An absent series value stays absent, never zero, interpolated, or carried
  forward. Inspection does not change aggregates, query scope, or chart links.
- Pointer, touch, and keyboard access to the same labeled comparison; Escape
  clears inspection, focus remains stable, and color is not the sole identifier.
- Refresh and cleanup through the active abort-scoped query subscription.
  Replacing data invalidates a selection that no longer exists; leaving the view
  removes listeners and transient state.

Acceptance should cover multi-series and sparse buckets, mixed-unit rejection,
empty/unavailable/partial evidence, refreshed data, keyboard and touch parity,
and bounded payload/rendering cost. Existing documents remain valid and retain
their behavior when the optional declaration is omitted.

### Second candidate: brushing through query parameters

Brushing is useful for narrowing a usage spike and seeing corresponding run
details. Its declaration should name the source axis, destination page
parameters, and affected queries explicitly; it should not infer relationships
from view IDs or send selected raw rows between components.

Before adding syntax, specify temporal parameter typing, interval boundary
semantics, reset behavior, and interaction with the page's existing time scope.
The current form contract is not a ready-made temporal brush contract.
Committing a gesture should update validated parameters and replace the canonical
query subscription; transient dragging may update the owned selection overlay
only. Reset restores the declared scope, never a broader implicit query.
Invalid or missing bindings fail closed rather than removing a predicate.

Acceptance should include boundary timestamps, empty selections, reset,
superseded responses, database refresh during selection, keyboard alternatives,
and navigation cleanup. No renderer callback may filter rows or reconstruct
cross-view relationships. Neither inspection nor brushing grants CLI execution,
repository access, or control-plane authority.

Any implementation should update the normative specification, validator,
declarative view/contract fixtures, shared renderer, and focused tests together;
query-bound behavior also requires worker and hosted-query parity coverage.
This review deliberately leaves final key names and implementation for that
separately reviewed contract.
