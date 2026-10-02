# Query optimization workstream prompt

Replace every bracketed field before sending. The child cannot see the coordinator's conversation.

> Implement one bounded query optimization workstream in [repository]. The user requested estimator-selected dashboard queries optimized in a fleet.
>
> Own these exact queries: [names, original ranks, transitive read units, materialized field units]. The frozen baseline revision is [SHA], selected using [normalized or deployed-table-weighted ranking] from [dashboard input]. Do not replace this selection with a fresh top ten.
>
> Exclusively edit [source paths] and [unique focused test path], except for the generated artifacts when branch-local regeneration is authorized below. Other workstreams own [other paths]. Do not edit the estimator, query engine, canonical database queries, policy, shared fixtures, or another session's test/source files without coordinator approval. Report a cross-owned dependency opportunity instead of changing it.
>
> Read CODEBASE.yml first, invoke reactive-ui, and read the relevant Dashboard Language and data contracts. Reduce actual production computation/materialization, not estimator weights, evidence eligibility, or acceptance requirements. Keep all production data shaping declarative.
>
> Preserve complete public outputs, row ordering, identities, links, horizon/filter/search/route behavior, active/inactive inventory, run-attempt/count distinctions, null/zero semantics, union-before-join behavior, and duplicate-key rejection. Preserve oldest provenance and weakest completeness/freshness even when event sources contribute no displayed fields. Do not introduce arbitrary limits, JavaScript querying, fabricated derived source fixtures, or silent failure paths.
>
> Add focused regressions using populated canonical evidence ingested through the production path, then execute via the production worker/query boundary. A frozen subset of original declarative definitions is an acceptable equality baseline. Compare raw objects, not a JSON round-trip. Exercise empty, missing, unavailable, partial/stale evidence, duplicate keys, and scoped parameters as well as the populated happy path.
>
> Measure complete dependency-graph operations for every assigned query and the assigned batch with a shared query budget. Demonstrate a real computational/materialization improvement and preserve exact outputs and public metadata. Leaf-only timing or empty result sets do not establish an improvement.
>
> Run focused tests and applicable dashboard lint, typecheck, document/corpus validation. Compare broader failures with [known baseline failures and recorded evidence]; do not repair unrelated failures or weaken checks. Use the npm skill after missing dependencies or installation/network failures, not for speculative reinstalls.
>
> If query definitions changed, run npm run generate:agent-catalog and verify reproducibility plus CLI/MCP/Go contracts. [For separate PR delivery: commit both generated artifacts on this branch.] [For aggregate-only delivery: leave generated artifacts for the coordinator unless instructed otherwise.] Do not combine generated snapshots from sibling branches.
>
> No renderer changes are expected. If browser verification is required, use the real site with canonical data; capture/publish affected desktop/mobile screenshots under repository rules, never mocked-page evidence or committed images. Run workflow compilation if Markdown changes; never alter shared installed tools or compiler policy to hide a version mismatch.
>
> Commit verified changes on your own branch with the required Copilot trailer. [State the authorized PR/push scope, or explicitly prohibit PR creation and merging.] Never merge or enable auto-merge.
>
> Return the commit SHA, exact changed paths, per-query before/after reads and materialized field units, populated standalone/batched operation counts, equality coverage, validation results, and blockers. Stop after this workstream. Notify the coordinator of later user-directed PR changes that affect integration or generated artifacts; do not silently change the assigned delivery scope.
