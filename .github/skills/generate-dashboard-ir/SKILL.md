---
name: generate-dashboard-ir
description: Generate valid low-level Dashboard Language YAML from user intent using the provided dashboard specification and validator entry point.
---

# Generate Dashboard IR

Generate one complete Dashboard Language YAML document from the user's dashboard intent. Use the provided Dashboard Language specification as the semantic authority and the provided validator entry point as the syntax and structural validation authority.

Do not introduce a new intermediate language. Do not output an intermediate semantic plan unless explicitly requested.

## Inputs

The working context provides:

- user intent;
- a Dashboard Language specification file;
- a validator entry point;
- the built-in dashboard configuration at `dashboard/site/dashboard.json`;
- optionally, an existing dashboard YAML document.

Read the specification and built-in dashboard configuration before generating or modifying dashboard YAML. Use the built-in configuration as the reference for established rich views, including useful columns, links, status displays, and interactive controls. Do not rely on remembered Dashboard Language syntax when the provided specification defines it.

## Output

Produce one complete Dashboard Language YAML document that:

- represents the user's intent;
- conforms to the provided specification;
- passes the provided validator entry point;
- contains only supported Dashboard Language vocabulary;
- contains no unresolved placeholders or speculative fields.

## Procedure

1. Read the specification and `dashboard/site/dashboard.json`, then identify the relevant root structure, logical sources and grains, fields, dimensions, measures, aggregates, marks, encodings, pages, filters, links, routing, data-state semantics, defaults, and validation constraints. Reuse an established built-in view pattern when it satisfies the intent, adapting only its scope and labels. When prior knowledge differs, follow the provided specification.
2. Interpret the minimum information necessary to satisfy the intent: purpose, questions, entities, measures, dimensions, time range, filters, comparisons, rankings, trends, and drilldown needs. Prefer a small set of views that directly answers the requested questions.
   Internally trace activation and execution, every required operator action, accepted-success evidence, and the direct operational-value metric to a view, source grain, canonical fields, scope, time, filters, and links. A generic run, finding, or outcome count does not cover task-specific evidence.
3. Prefer a built-in page when it satisfies the intent. Use a custom page only when the requested analysis is not built in, requires a specific combination of measures or dimensions, or explicitly requests a custom presentation.
4. For every custom view, select the logical source whose grain matches the analysis. Do not choose a source only because it has a similarly named field, and do not fabricate joins or combine sources unless the specification supports it.
   If canonical sources and fields cannot represent an essential intent requirement, report that constraint instead of substituting a generic proxy. When logical-source availability is provided, do not silently reference an absent source.
5. Map user terminology to canonical fields from the specification. Verify every field name, semantic, and enum value; never invent fields, aliases, dimensions, or measures.
6. Use only aggregates allowed for the selected fields. Respect non-additive measures and use explicit output aliases when required for correctness or later references such as ordering.
7. Select the simplest valid view. Prefer a metric for a single aggregate, a table for inventory or records, a table or bar chart for rankings, a line chart for time trends, and a bar chart for categorical comparisons when the specification supports them. Prefer a pie chart for aggregate distributions of discrete states, such as run outcomes, because the aggregate composition is a better fit than a temporal line chart.
   For an actionable queue, prefer a filtered record table that exposes identity, required evidence or status, scope, and a repository, run, issue, or pull-request link. Use a categorical chart only when the distribution itself answers the intent; an outcome-state count alone does not establish accepted evidence.
8. Generate explicit low-level Dashboard Language YAML. Resolve all applicable sources, scopes, time ranges, filters, ordering, limits, marks, chart types, encodings, field types, aggregates, aliases, time units, layouts, sections, links, routes, disclosure, and units. Give each named UI element a concise `intent` that records the operator outcome it supports as non-visible authoring metadata for future agentic mutation. Do not leave values such as `auto`, `TODO`, or `TBD`.
   For operational value, filter the exact definition, preserve its opportunity grain, and expose maturation and accepted-evidence diagnostics or links when available. Use a mean trend only when an aggregate trend is explicitly requested, never as the sole proof of success.
9. Run the provided validator entry point against the complete document. Repair every reported error and rerun validation until it passes. If the intent cannot be represented with supported vocabulary, report that constraint instead of inventing syntax.

Return only the validated complete Dashboard Language YAML document unless the user explicitly requests an explanation.

## Declarative queries

When the intent needs a projection, a relationship between two sources, or a derived measure that no canonical source provides, declare it once under `dashboard.queries` (Dashboard Language Specification Section 5.5) and select the derived source by name from the views. Never add view-specific code, joins, or expressions.

Valid:

```yaml
queries:
  - name: workflow-aic-totals
    from: usage
    aggregate:
      by: [organization, repository, workflow]
      values:
        - { field: aic, as: aic, reducer: sum }
  - name: workflow-cost-inventory
    from: workflows
    joins:
      - source: workflow-aic-totals
        type: left
        on:
          - { left: workflow, right: workflow }
        fields:
          - { field: aic, as: observed-aic }
    compute:
      - as: total-aic
        function: coalesce
        args: [{ field: observed-aic }, { value: 0 }]
    select:
      - { field: workflow }
      - { field: total-aic, as: aic }
```

Invalid:

```yaml
queries:
  - name: workflow-cost-inventory
    from: workflows
    joins:
      - source: usage
        type: cross
        on: [{ left: workflow, right: workflow }]
        fields: [{ field: aic, as: aic }]
    compute:
      - as: cost
        function: eval
        args: [{ value: "aic * rate" }]
```

Invalid because `cross` is not a supported join type, `usage` has more than one row per join key, and `eval` is outside the closed computed-field vocabulary. Queries must reference only canonical sources or earlier queries, keep every output name unique, and reference only fields the preceding clauses produce.

Also invalid:

```yaml
queries:
  - name: workflow-totals
    from: workflow-inventory
  - name: workflow-inventory
    from: workflows
    joins:
      - source: workflow-totals
        on: []
        fields: [{ field: aic, as: aic }]
```

Invalid because the two queries form a dependency cycle, `workflow-totals` reads a query declared after it, and the keyless `on` would expand every row against every other row. Queries must form an acyclic graph in declaration order, and every join must declare at least one equality key pair.

## Corpus procedure

When the working context requests a training-corpus example:

1. Read `corpus/index.json` first and open only examples relevant to the candidate task. Reject a duplicate intent, opportunity, metric, or view composition.
2. Add one metadata JSON file and its paired `.dashboard.yml` file under `corpus/examples/`, then add the entry to `corpus/index.json` in ascending `id` order.
3. Record the synthetic task, intent conditions, frozen design-time operational-value contract, logical-source fixture, and relative dashboard path in metadata. Keep only Dashboard Language vocabulary in the dashboard file.
4. Do not claim observed attainment, fabricate repository evidence, or create an operational-value grader. Use `attainment-only` unless immutable pre-adoption evidence supports a comparable baseline.
5. Run `npm --prefix dashboard/site run validate:corpus` from the repository root. Keep only candidates that pass dashboard-document and logical-source validation.

Corpus examples use `.dashboard.yml`; production dashboards may use strict JSON in `.json` files. Both serialize the same YAML 1.2 data model with the same canonical kebab-case vocabulary, types, defaults, validation rules, and semantics.
