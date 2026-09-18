# Dashboard Language Renderer Maintenance

## Status

- [x] The Dashboard Language renderer is owned and installed by the `dashboard/` campaign.
- [x] All specification-defined pages are declared in `dashboard.json` and rendered by the generic runtime.
- [x] `/cao` uses generated `sources.json`; there is no parallel HTML renderer.
- [x] Configured mode cues, durable-output indexes and details, runtime and dispatch triage, report controls, discovery coverage, dispatch attribution, execution transitions, and output lifecycle/warning semantics are represented in the production renderer.

## Maintenance rules

- Keep page composition in `dashboard.json` and source semantics in the collector or source-adapter layer.
- Add JavaScript only for reusable validation, derivation, routing, or presentation primitives; do not dispatch on built-in page identity.
- Preserve independent availability, completeness, freshness, and provenance states.
- Run build, typecheck, lint, unit, and browser tests for renderer changes.

## Specification questions

- Sections 4.2 and 10 do not define a portable carrier for declarative built-in page definitions; the implementation currently uses `definition.views`.
- `DLS-PAGE-014` requires independent availability, completeness, and freshness without defining a declarative binding; the implementation uses `definition.data-state` and source metadata.
- YAML parsing does not preserve scalar quoting, so `language-version` validation enforces the exact string value rather than source spelling.
- Section 8 logical-source metadata is carried by `data.source-metadata` because Section 4.2 does not otherwise admit it.
- Section 11.2 does not fully define post-aggregation grain derivation; order fields are limited to aggregate outputs and conservative entity identifiers.