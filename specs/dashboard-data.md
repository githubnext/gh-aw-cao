# Dashboard Data Schemas

This specification records the pseudo schema of every JSON file advertised by the deployed dashboard data manifest at `https://githubnext.github.io/gh-aw-cao/cao/sources/manifest.json`.

Schemas use the same bounded inference as the dashboard Data Health view: at most 50 rows, six nested levels, and 12 displayed properties per object. A `?` marks a property absent from at least one sampled row.

## `sources/manifest.json`

<pre><code>{ generation: string, sources: string[], version: number }</code></pre>
## `sources/admission-checks.json`

<pre><code>{}</code></pre>
## `sources/admissions.json`

<pre><code>{}</code></pre>
## `sources/agent-assignments.json`

<pre><code>{ agent-description: string, agent-icon: string, agent-id: string, agent-name: string, agent-state: string, assignment-id: string, assignment-state: string, conflict-state: string, dependency-state: string, evidence-link: { href: string, label: string, relation: string }, handoff-state: string, last-observed-at: string, … +10 more }</code></pre>
## `sources/agent-smells.json`

<pre><code>{}</code></pre>
## `sources/attention-signals.json`

<pre><code>{ action: string, age-seconds: number, attention-signal-id: string, consequence-tier: string, evidence-link: { href: string, label: string, relation: string }, expected-actor: string, objective: string, observed-at: string, priority: number, reason: string, repository-link: { href: string, label: string, relation: string }, scope: string, … +2 more }</code></pre>
## `sources/configuration-actions.json`

<pre><code>{ action: string, current: string, path: string, prompt: string, recommended: string }</code></pre>
## `sources/configuration-policy.json`

<pre><code>{ diagnostics: { detail: string, path: string, severity: string, title: string }[], document: { $schema: string, control-plane: { defaults: { max-repositories: number }, packages: { aw-doctor: { icon: string, mode: string, workers: { compiler-security: object, failures-investigator: object, upgrade: object } }, dependabot: { icon: string, mode: string, workers: { release-train-updater: object } }, eu-cra-compliance: { icon: string, workers: { article-14-reporting-readiness: object, conformity-release-evidence: object, scope-classifier: object, security-requirements-auditor: object, supply-chain-sbom-auditor: object, vulnerability-handling-auditor: object } }, optimization: { icon: string, workers: { agents-md-curator: object, ai-credit-auditor: object, ai-credit-optimizer: object, skills-curator: object } }, self-care: { icon: string, max-repositories: number, mode: string, rollout-percent: number, targets: { githubnext/gh-aw-cao: object }, workers: { accessibility-checker: object, code-improvement: object, dashboard-data-schema: object, dashboard-language-refactor: object, dashboard-performance: object, dashboard-review: object, data-acquisition-audit: object, docs-build-time-investigator: object, experimental-views: object, glossary: object, open-source-failures: object, pages-health: object, … +1 more } }, software-development-practices: { icon: string, workers: { github-well-architected: object, nist-ssdf: object } }, uk-ai-advisory: { icon: string, workers: { operational-resilience: object } } }, scope: { allowed-owners: string[], allowed-repositories: string[] }, web: { favicon: string } }, target-authority: { packages: { aw-doctor: { authority: string }, dependabot: { authority: string }, self-care: { authority: string } } }, version: number }, path: string, raw: string }</code></pre>
## `sources/configuration-summary.json`

<pre><code>{ count: number, status: string }</code></pre>
## `sources/control-plane-smells.json`

<pre><code>{}</code></pre>
## `sources/coverage-diagnostics.json`

<pre><code>{ effect: string, title: string }</code></pre>
## `sources/detection-observations.json`

<pre><code>{ attention-priority: number, detection-applicable: string, detection-count: number, detection-executed: string, detection-expected: string, detection-signal: string, detection-state: string, detection-state-label: string, engine: string, inspection-warning: string, inspection-warning-count: number, job-conclusion: string, … +17 more }</code></pre>
## `sources/eval-observations.json`

<pre><code>{}</code></pre>
## `sources/evals.json`

<pre><code>{}</code></pre>
## `sources/events.json`

<pre><code>{ event: string, event-source: string, event-status: string, event-timestamp: string, event-type: string, observed-at: string, organization: string, repository: string, run: string, run-attempt: number, session: string, source-sequence: number, … +1 more }</code></pre>
## `sources/evidence-records.json`

<pre><code>{ claim: string, evidence-class: string, evidence-id: string, evidence-kind: string, evidence-link: { href: string, label: string, relation: string }, objective: string, observed-at: string, provenance-state: string, repository-link: { href: string, label: string, relation: string }, run-link: { href: string, label: string, relation: string }, source-revision: string, verification-state: string, … +1 more }</code></pre>
## `sources/experiment-assignments.json`

<pre><code>{}</code></pre>
## `sources/experiments.json`

<pre><code>{}</code></pre>
## `sources/findings.json`

<pre><code>{ engine: string, engine-version: string, external-link: { dashboard-href: string, dashboard-label: string, href: string, label: string, relation: string }, finding: string, finding-kind: string, finding-severity: string, finding-status: string, finding-summary: string, issue-link?: { href: string, label: string, relation: string }, observed-at: string, organization: string, repository: string, … +7 more }</code></pre>
## `sources/firewall-observations.json`

<pre><code>{ baseline-request-count: null, current-decision: string, decision: string, decision-changed: boolean, decision-label: string, domain: string, drift-label: string, drift-state: string, enforcement-label: string, evidence-completeness: string, evidence-coverage-percent: null, evidence-error: string, … +46 more }</code></pre>
## `sources/firewall-policy-rules.json`

<pre><code>{}</code></pre>
## `sources/github-api-call-stacks.json`

<pre><code>{ credential: string, observed-at: string, operation: string, operation-execution-id: string, outcome: string, phase: string, stack-depth: number, stack-frame: string, stack-frame-id: string, stack-parent-id: string }</code></pre>
## `sources/github-api-collector-health.json`

<pre><code>{ cache-bytes: number, cache-entries: number, cache-folders: number, cache-hydrated: boolean, credential: string, observed-at: string, operation: string, operation-execution-id: string, outcome: string, phase: string, rate-limit-error: string }</code></pre>
## `sources/github-api-rate-limits.json`

<pre><code>{ attribution-status: string, bucket: string, burn-rate-per-minute: null, consumed-since-previous: null | number, credential: string, credential-type: string, has-history: boolean, history-series: string, is-current: boolean, is-unhealthy: boolean, limit: number, maximum-lane: string, … +19 more }</code></pre>
## `sources/grader-observations.json`

<pre><code>{}</code></pre>
## `sources/graders.json`

<pre><code>{}</code></pre>
## `sources/job-performance.json`

<pre><code>{ engine: string, job: string, job-conclusion: string, job-duration-seconds: number, job-id: string, job-status: string, model: string, organization: string, repository: string, rollout-mode: string, run: string, run-attempt: number, … +8 more }</code></pre>
## `sources/mcp-calls.json`

<pre><code>{}</code></pre>
## `sources/mcp-servers.json`

<pre><code>{ engine-version: string, failed-calls: number, gh-aw-version: string, max-response-bytes: number, mcp-protocol-version: string, mcp-server: string, mcp-server-observation: string, mcp-server-version: string, mcp-status: string, observed-at: string, organization: string, repository: string, … +6 more }</code></pre>
## `sources/operational-values.json`

<pre><code>{}</code></pre>
## `sources/organizations.json`

<pre><code>{ observed-at: string, organization: string, organization-name: string }</code></pre>
## `sources/outcomes.json`

<pre><code>{ engine: string, engine-version: string, evidence-strength: string, external-link: { href: string, label: string, relation: string }, issue-link?: { href: string, label: string, relation: string }, observed-at: string, organization: string, outcome-body-html: string, outcome-category: string, outcome-number?: number, outcome-state: string, outcome-status: string, … +18 more }</code></pre>
## `sources/repositories.json`

<pre><code>{ observed-at: string, organization: string, repository: string, repository-name: string, rollout-mode: string }</code></pre>
## `sources/repository-coverage.json`

<pre><code>{ label: string, value: string }</code></pre>
## `sources/run-performance.json`

<pre><code>{ engine: string, model: string, organization: string, repository: string, rollout-mode: string, run: string, run-attempt: number, run-conclusion: string, run-duration-seconds: number, run-link: { href: string, label: string, relation: string }, sandbox-runtime: string, started-at: string, … +1 more }</code></pre>
## `sources/runs.json`

<pre><code>{ data: null, ended-at: string, engine: string, engine-version: string, event: string, failure-detail: string, organization: string, repository: string, requested-model: string, resolved-model: string, rollout-mode: string, run: string, … +7 more }</code></pre>
## `sources/safe-output-performance.json`

<pre><code>{ observed-at: string, organization: string, repository: string, rollout-mode: string, run: string, run-conclusion: string, run-link: { href: string, label: string, relation: string }, safe-output-count: number, safe-output-kind: string, safe-output-label: string, safe-output-status: string, workflow: string }</code></pre>
## `sources/security-findings.json`

<pre><code>{}</code></pre>
## `sources/security-observations.json`

<pre><code>{ observed-at: string, organization: string, repository: string, run: string, run-link: { href: string, label: string, relation: string }, security-analysis: string, security-count: number, security-feature: string, security-observation: string, security-signal: string, security-status: string, security-subject: string, … +1 more }</code></pre>
## `sources/sessions.json`

<pre><code>{ ended-at: string, job-id: string, observed-at: string, organization: string, repository: string, run: string, run-attempt: number, session: string, session-kind: string, session-status: string, started-at: string, workflow: string }</code></pre>
## `sources/usage.json`

<pre><code>{ aic: number, cache-read-tokens: null, cache-write-tokens: null, engine: string, engine-version: string, estimated-usd: number, input-tokens: null, invocation: string, observed-at: string, organization: string, output-tokens: null, reasoning-tokens: null, … +8 more }</code></pre>
## `sources/work-items.json`

<pre><code>{ consequence-tier: string, domain: string, ended-at: string, evidence-link?: { href: string, label: string, relation: string }, lifecycle-state: string, name: string, next-action: string, next-actor: string, objective: string, observed-at: string, organization: string, outcome-state: string, … +19 more }</code></pre>
## `sources/workflow-smells.json`

<pre><code>{}</code></pre>
## `sources/workflows.json`

<pre><code>{ admission-reason?: string, admission-status?: string, external-link?: { href: string, label: string, relation: string }, gh-aw-current-version: string, gh-aw-manifest: { actions: { repo: string, sha: string, version: string }[], containers: { digest: string, image: string, pinned_image: string }[], mcp_servers: { name: string, tools: string[] }[], secrets: string[], version: number } | { actions: { repo: string, sha: string, version: string }[], containers: { digest: string, image: string, pinned_image: string }[], mcp_servers: { name: string, tools: string[] }[], secrets: string[], skills: string[], version: number } | { actions: { repo: string, sha: string, version: string }[], containers: { digest: string, image: string, pinned_image: string }[], has_pull_request: boolean, mcp_servers: { name: string, tools: string[] }[], secrets: string[], version: number } | null, gh-aw-metadata: { agent_id: string, agent_model: string, body_hash: string, compiler_version: string, engine_versions: { pi: string }, frontmatter_hash: string, schema_version: string, strict: boolean } | { agent_id: string, body_hash: string, compiler_version: string, engine_versions: { copilot: string }, frontmatter_hash: string, schema_version: string, strict: boolean } | { agent_id: string, agent_model: string, body_hash: string, compiler_version: string, engine_versions: { copilot: string }, frontmatter_hash: string, schema_version: string, strict: boolean } | null | { agent_id: string, body_hash: string, engine_versions: { copilot: string, copilot-sdk: string }, frontmatter_hash: string, schema_version: string, strict: boolean } | { agent_id: string, agent_model: string, body_hash: string, engine_versions: { pi: string }, frontmatter_hash: string, schema_version: string, strict: boolean }, gh-aw-update-state: string, gh-aw-version: string, gh-aw-version-label: string, inventory-ready?: boolean, max-ai-credits?: number, observed-at: string, … +19 more }</code></pre>
