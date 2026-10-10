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
