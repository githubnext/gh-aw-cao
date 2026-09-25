---
title: Dashboard Language
description: Build dashboard views from trusted data with readable, declarative queries.
---

Dashboard Language lets you describe the question a view should answer and how
the answer should appear. Queries are structured YAML: there is no SQL,
JavaScript, or browser-side data processing to maintain.

Use this guide to learn the language and write common queries. Use the
[Dashboard Language Specification](dashboard-language-specification.md) when
you need the complete vocabulary, validation rules, or conformance requirements.

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

Every reusable query has a `name` and an `intent`. The intent records the human
question behind the query, so future changes preserve its purpose.

## A small query

This query answers “Which workflows used the most AI Credits?” It groups usage
by workflow, totals the observed credits, and returns the ten largest results.

```yaml
queries:
  - name: highest-aic-workflows
    intent: Show the workflows with the highest observed AI Credit usage.
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
    intent: Estimate AIC under an operator-selected multiplier.
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

See the [view catalog](dashboard-view-catalog.md) for available pages, marks,
charts, and named UI elements. For every field, function, validation rule, and
conformance requirement, use the [Dashboard Language Specification](dashboard-language-specification.md).
