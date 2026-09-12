# SelfCare

SelfCare runs repository-local maintenance for `githubnext/gh-aw-cao`. Its orchestrator dispatches fourteen live-only workers:

- **Accessibility Checker** audits the rendered documentation site and publishes one prioritized accessibility issue.
- **Code Improvement** extracts one evidenced duplicated dashboard UI construct into a tested reusable component and opens one focused draft pull request.
- **Dashboard Performance** rotates through trace-backed CFO, CTO, and CSO Lighthouse bottlenecks and opens one focused draft pull request.
- **Data Acquisition Audit** reviews dashboard acquisition paths and opens one focused draft pull request when the audit is stale.
- **Dashboard Language Refactor** replaces one over-specialized dashboard view with tested reusable subcomponents configured through Dashboard Language.
- **Dashboard Review** assesses dashboard correctness, decision support, efficiency, and usability through deterministic checks and executive browser journeys.
- **Experimental Views** exercises every editable experimental and Operations view in Chromium and WebKit across data-source shapes and DOM-size stress, then opens one focused draft pull request for the highest-ranked issue.
- **Docs Build-Time Investigator** analyzes Documentation Pages workflow timings and publishes one non-repeating, evidence-backed caching or dashboard build-speed suggestion.
- **Glossary** scans recent merged pull requests and default-branch code changes, then opens one focused draft pull request when current repository evidence supports an Astro-compatible glossary update. The orchestrator dispatches this worker at most once per rolling 24 hours.
- **Open Source Failures** scans the bounded CAO dashboard activity snapshot, clusters failed runs across represented public projects, and files a digest plus focused remediation issues.
- **Pages Health** runs at most once per rolling six hours, scrolls every deployed dashboard view under desktop, mobile, and low-bandwidth profiles, and opens a focused draft PR with the highest-confidence JavaScript quick wins it can validate.
- **Primer Brand Checker** audits the dashboard against current Primer brand guidance and opens one focused draft pull request when an evidenced fix is available.
- **Reactive UI Expert** maintains the reactive UI skill, reviews recent dashboard JavaScript changes for reactive patterns, and extracts direct HTML mutations into reactive elements, data binding, and effects.

The checked-in control policy admits only `githubnext/gh-aw-cao` as a live target, and the target-authority declaration grants this repository's control plane authority for the package. The orchestrator rejects every other repository and every non-live candidate; all fourteen workers repeat those checks before performing their mission. Open Source Failures selects public project records only from the dashboard's validated activity snapshot; it does not discover or access repositories independently.

The package uses `shared/control.md` for policy resolution, target authority, dispatch envelopes, safe-output routing, and correlation. It dispatches at most fourteen workflows for its single target.

The Docs Build-Time Investigator registers an operational-value evaluator that measures material `docs.yml` execution-time reduction while requiring completed-run reliability to be preserved. The package dashboard keeps recommendations distinct from matured attainment. Design evaluators for the other workers after adoption evidence establishes measurable accessibility, component-reuse, declarative-view-reuse, reactive-UI-maintenance, glossary-maintenance, data-acquisition, dashboard-review, public-failure-remediation, and brand-maintenance outcomes.
