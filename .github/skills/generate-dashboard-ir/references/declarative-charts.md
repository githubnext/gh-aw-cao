# Declarative charts

Use [`docs/dashboard-language-specification.md`](../../../../docs/dashboard-language-specification.md), Section 11.1, as the authority. Validate the complete document with `validateDashboardDocument` from `dashboard/site/src/validator.js`. The examples below use canonical fields; adapt their questions and scope, not their syntax.

## Choose a chart

| Operator question | Chart and constraints |
| --- | --- |
| Quantitative trend | `line`; temporal `x` with an explicit `time-unit` for single-measure charts. A single-widget line may encode two to eight quantitative `y` fields instead of `color`. |
| Contributions over time | `area`; ordinal or explicitly bucketed temporal `x`, quantitative `y`, optional categorical `color` for normal stacking. Do not stack negative contributions. |
| Exact observations over time | `dot` or `scatter`; temporal `x`, quantitative `y`, no connecting lines. Only a single-widget dot may encode quantitative `reference` lines. |
| Category comparison or ranking | `bar` or `horizontal-bar`; horizontal bars require categorical `x` and `data.limit` at most 100, with optional categorical `section` headings. |
| Discrete composition | `pie`; categorical `x`, quantitative `y`. |
| Sample distribution | `histogram`; categorical sample identity in `x`, quantitative `y`, no `color` or `href`. Binning is automatic after query processing. |
| Compact categorical matrix | `heatmap`; categorical `x` and `y`, aggregated quantitative `color`, `data.limit` at most 100, at most 100 cells and 12 categories per axis. |
| Categorical history | `swimlane`; unbucketed temporal `x`, unaggregated categorical `y`, optional unaggregated quantitative `weight` representing observation counts. |
| Positive proportional contributions | `treemap`; categorical leaf labels in `x`, quantitative area in `y`, optional categorical `color` and one-level `section` nesting. |

Set `chart` explicitly. A chart is not an evidence queue: use a separate linked table when row-level evidence or operator action is required. Preserve native metric values, units, nulls, and upstream semantics.

## Temporal shaping and missing evidence

Single-widget temporal line/area/bar charts with one `y` measure, including the
omitted-chart line default, require `encoding.x.time-unit`: `hour`, `day`, `week`,
or `month`.
For example, a daily trend can use
`x: { field: date, type: temporal, time-unit: day }`. Choose the unit from the
intended time grain; do not assume every trend is daily. Computing `date-bucket`
in a source query or setting `chart: line` does not replace this encoding
property. The property is declarative metadata executed by the worker, not
JavaScript data shaping. Layered charts over already-shaped queries and
multiple-measure lines have their own rules; exact-observation `dot`, `scatter`,
and `swimlane` charts do not need this single-measure line bucket.

Bucket and aggregate temporal observations in a query before applying declarative `window` smoothing or change operations. Partition independent series explicitly. Rolling windows count observations, not elapsed days; centered windows require future observations and must not portray incomplete newest points as complete estimates. Rates use actual elapsed time between observations. A first observation, missing measure, or zero percentage-change denominator does not imply zero change. Read Sections 5.5.3 and 5.5.4 for the exact temporal-series and window vocabulary rather than inventing encoding transforms.

## Facets: categorical small multiples

- Declare one view-level `facet: { field: engine, type: nominal }`, or a matrix such as `facet: { row: { field: engine }, column: { field: repository } }`.
- Alternatively use `encoding.facet`, or `encoding.row` and/or `encoding.column`. Never mix view-level and encoding facet syntax, or combine `encoding.facet` with row/column channels.
- Facet fields must survive the source query as unaggregated categorical dimensions. Definitions accept only `field`, nominal/ordinal `type`, `title`, and categorical `format` (`workflow-relative-path` or `workflow-identity-label`). Derive temporal or other categories in a query first.
- View `columns` is an integer from 1 to 64 and wraps a single-field facet only. It is not `encoding.columns`, a table's column sequence. Omission uses one desktop row; mobile may stack panels.
- The worker retains facet dimensions as aggregation keys, orders and limits chart rows globally, then partitions them. A limit is not per panel. Explicit query aggregation must retain every requested facet field.
- Panels and their rows preserve first-appearance order after query processing. Missing and null categories share an explicit Unknown panel; the literal string `"unknown"` is distinct. Formatted captions do not change category identity.
- At most 64 observed panels are supported. More panels produce an unavailable state, not truncation. Unobserved matrix combinations do not create empty panels or synthetic observations.
- Each panel has independent scales, an accessible categorical caption, and the original chart's labels, units, links, and legends. Do not imply a shared-scale magnitude comparison.
- A layered chart may facet at the top-level view or encoding only. No layer may introduce its own facets; layers within each panel still share that panel's source.

Query-level `facet` is a terminal payload operation, not a chart field definition: use scalar names, for example `facet: { field: engine, as: grouped-rows }` or `facet: { row: engine, column: repository, as: grouped-rows }`. It runs after `limit`; `as` must not collide with `facet-field`, `facet-row`, `facet-column`, `facet-row-index`, or `facet-column-index`. Chart compilation emits `as: facet-rows` automatically. Prefer a flat named query plus a chart facet declaration; do not feed an already-partitioned query to an ordinary chart as though it still contained flat observations.

## Layers: complementary marks on one plot

- Set `mark: chart` and `layer` instead of top-level `chart`. Leaves select only `area`, `bar`, `line`, `dot`, or `rule`; groups contain a nested `layer` sequence.
- At most eight leaves and four array nesting levels are supported. Later leaves paint above earlier leaves.
- Parent `encoding` definitions are inherited by channel. A child replaces an entire channel definition, not individual properties. Only `x`, `y`, `color`, and `href` are layer channels.
- Each leaf needs one quantitative `y`; all except `rule` also need one `x`. A rule spans the plot at each distinct observed `y` per color series. Do not invent a constant-value encoding; produce references in the query.
- Use one already-shaped `data.source`. Declare aggregates, time buckets, ordering, and limits in `dashboard.queries`, not in layer encodings or view `data.limit` / `data.order-by`. No per-layer source, filter, transform, or JavaScript calculation is supported.
- Shared `x` types must be compatible and obey the widget's constraints; quantitative x scales are unsupported. Shared `y` units must match. Domains normally union all leaves, including stacked area totals, with a merged color legend.
- `resolve: { scale: { y: independent } }` permits distinct quantitative domains and formatting per leaf, rendered with an explicit per-layer scale key. Only y-scale `shared` or `independent` is supported; independent x/color scales are not.
- Independent scales between facet panels are separate from y-scale resolution between leaves within a panel.
- Bound bar/rule query payloads to at most 2,000 observations per leaf; oversized payloads produce a limit message. Line/area/dot marks use the renderer's bounded sampling. Invalid or missing numbers remain gaps, not zeroes.

## Treemaps: proportional area and optional nesting

- Set `chart: treemap`. Declare `treemap` options only on this widget: `method` is `squarify` (default), `binary`, or `slicedice`; finite `ratio` is 1 to 5 (default 1.618); finite `padding` is 0 to 10 (default 0.5).
- `ratio` controls squarify's preferred rectangle aspect ratio, not chart dimensions. `padding` is measured in a 100-by-60 drawing plane. Slice-dice alternates orientation between group and leaf levels.
- Use unaggregated categorical `x`, quantitative `y`, and optional categorical `color` / `section`. Aggregate and order in a named query first. Every treemap declares `data.limit` from 1 to 100, applied by the worker after query execution; input query order determines tiling order.
- `section` creates one group level. Omit it for a flat treemap. Do not declare parent/child IDs, infer hierarchy from labels, or embed a Vega treemap transform.
- Positive finite values determine proportional area before gutters and headings. Missing and zero values receive no area and are reported explicitly. Negative/non-finite values or more than 100 input leaves produce an explanatory unavailable state, not clamping or silent truncation.
- Leaves expose label, group, and formatted value without relying on color. Small leaves retain accessible names and visible, viewport-bounded hover/focus/tap tooltips; Escape dismisses tooltips. Optional `href` uses a declared safe link field and remains keyboard-operable.

## Responsive layout and disclosure

- View `layout` is `full`, `full-view`, `half`, `third`, or `horizontal`. `full-view` requests the full available row and viewport height; `horizontal` places title and visualization beside each other. Hints are not fixed sizes and may collapse to full width without changing reading or focus order.
- Page section `layout` is a different vocabulary: `full`, `wide`, `narrow`, or `horizontal`. Horizontal sections arrange adjacent view boxes that wrap responsively.
- When sections are present, reference every page view exactly once and preserve declaration order. Do not add a section merely to put another box around a chart. A facet panel is a graphic inside one view, not a nested view or section.
- Put essential summaries first, supporting evidence afterward. Use sibling `supplemental` disclosures for optional diagnostics instead of nested chart/section/disclosure boxes. Do not invent pixel coordinates, widths, breakpoints, or Vega-Lite `spec` / `concat` / `repeat`.

## Complete example

This example compares usage across engine panels, overlays exact credit observations, and shows positive workflow contributions. It does not claim that usage demonstrates accepted operational value.

```yaml
language-version: 0.1.0
dashboard:
  id: declarative-chart-example
  title: Usage comparisons
  queries:
    - name: credit-observations
      subject: Show bounded AI Credit observations in timestamp order.
      from: usage
      select:
        - { field: observed-at }
        - { field: aic }
        - { field: run-link }
      order-by: [{ field: observed-at, direction: asc }]
      limit: 2000
    - name: workflow-credit-totals
      subject: Show observed AI Credits by repository and workflow.
      from: usage
      aggregate:
        by: [repository, workflow]
        values: [{ field: aic, as: total-aic, reducer: sum }]
      order-by: [{ field: total-aic, direction: desc }]
      limit: 100
  pages:
    - id: usage-comparisons
      kind: custom
      title: Usage comparisons
      views:
        - id: costs-by-engine
          subject: Compare workflow credit totals within each engine.
          title: Workflow costs by engine
          mark: chart
          chart: bar
          layout: full
          facet: { field: engine, type: nominal, title: Engine }
          columns: 2
          data: { source: usage, limit: 100 }
          encoding:
            x: { field: workflow, type: nominal }
            y: { field: aic, type: quantitative, aggregate: sum, title: AI Credits }
        - id: credit-observation-layers
          subject: Show exact credit observations over the same temporal plot.
          title: Credit observations
          mark: chart
          layout: half
          data: { source: credit-observations }
          encoding:
            x: { field: observed-at, type: temporal }
            y: { field: aic, type: quantitative, title: AI Credits }
            href: { field: run-link }
          layer:
            - { chart: dot }
            - { chart: rule }
        - id: workflow-credit-treemap
          subject: Show positive workflow credit contributions grouped by repository.
          title: Where are AI Credits concentrated?
          mark: chart
          chart: treemap
          layout: half
          treemap: { method: squarify, ratio: 1.618, padding: 0.5 }
          data: { source: workflow-credit-totals, limit: 100 }
          encoding:
            x: { field: workflow, type: nominal, format: workflow-relative-path }
            y: { field: total-aic, type: quantitative, title: AI Credits }
            section: { field: repository, type: nominal }
            color: { field: repository, type: nominal }
```

For optional independent layer scales or row/column facets, change the declarations rather than adding presenter code. Check accessible output, responsive wrapping, refreshed worker payloads, and honest empty/partial/unavailable states alongside document validity.
