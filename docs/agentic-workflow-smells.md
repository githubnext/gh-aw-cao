---
title: Agentic workflow smells
description: Interpret detected smells and review agentic workflows for design, authority, security, coordination, rollout, cost, and configuration risks.
---

An agentic workflow smell is an evidence-backed warning that a workflow may be
harder to control, secure, operate, or justify than necessary. A smell is a
reason to investigate, not proof of a defect. Review the underlying evidence
and operating context before changing or disabling a workflow.

This guide includes both smells detected by the dashboard and review heuristics
for smells that are not yet emitted automatically. The normative detector IDs,
source boundaries, and severity rules are defined in the
[Dashboard Language specification](dashboard-language-specification.md#511-smell-classification).

## Classify a smell

Classify findings by what the evidence describes. Do not infer a security
finding from high cost, long duration, or broad tool use.

| Classification | What it describes | Example |
| --- | --- | --- |
| Agent smell | Execution behavior, control quality, reducibility, or resource choice | A deterministic pre-step could replace most agent turns |
| Workflow smell | Static workflow configuration or supply-chain posture | Strict validation is disabled |
| Security finding | Observed unsafe or untrusted behavior | Threat detection identifies prompt injection |
| Control-plane smell | Policy, package inventory, rollout, or governance | Declared worker inventory is incomplete |

The dashboard normalizes all four classifications into Home attention signals.
Agent smells also appear on matching cards in the Agents view. Each observation
should retain its evidence, severity, expected actor, and recommended action.

## Detected agent smells

`gh aw audit` supplies five behavioral assessments. The dashboard preserves the
audit severity and supporting evidence when it emits them as agent smells.

| Smell | Meaning | Typical response |
| --- | --- | --- |
| Agentic overkill | Deterministic automation would be simpler and more predictable | Replace the agentic step with a script, action, or query |
| Resource heavy for domain | Turns, tools, duration, or writes are excessive for the task | Narrow the prompt and tools, lower limits, or split deterministic gathering from reasoning |
| Poor agentic control | Exploration, failures, missing evidence, or writes indicate weak control | Add explicit scope, evidence requirements, stop conditions, and write bounds |
| Partially reducible | A material share of data gathering can move outside the agent loop | Gather and normalize evidence in deterministic pre-steps |
| Model downgrade available | A less expensive model is likely sufficient | Evaluate a smaller model against accepted outcomes before changing the default |

The dashboard also detects workflow, security, and control-plane smells. See the
[normative smell table](dashboard-language-specification.md#511-smell-classification)
for their canonical IDs, meanings, categories, and severities.

## Review design

Design smells indicate that agentic reasoning is being used without a bounded,
testable purpose.

- **Agent by default:** AI performs builds, tests, formatting, filtering,
  deployment, or another reproducible transformation that deterministic tooling
  can perform more reliably.
- **Vague mission:** The workflow lacks durable intent, scope, evidence
  requirements, completion criteria, or explicit non-goals.
- **Mega-agent:** One run combines discovery, planning, implementation, review,
  rollout, and reporting, making failures difficult to isolate.
- **Prompt bloat:** The agent receives large ambient instructions, complete files,
  unused skills, or every available tool schema regardless of the task.
- **Exploration without bounds:** Searches, files, repositories, turns, or tool
  calls have no explicit limit.
- **Hallucination pressure:** The instructions require an answer even when tools
  or evidence are unavailable instead of permitting `missing-tool`,
  `missing-data`, or `noop`.
- **Self-certified success:** Completion depends on the agent's claim rather than
  repository state, tests, or another independently observable outcome.

Prefer a narrow agent mission with deterministic preparation and validation.
Split unrelated phases when they require different permissions, evidence, or
failure handling.

## Review authority

Authority smells indicate that a workflow can affect more resources than its
mission requires.

- The agent job has direct write permissions or bypasses `safe-outputs`.
- Permissions, tools, repositories, mutable fields, or operation counts are
  broader than required.
- `target: "*"` or `target-repo: "*"` is used without a narrow allowlist.
- Labels, assignees, milestones, review events, branches, or files can be
  mutated without allowlists and preconditions.
- AI can approve or merge when a comment or draft pull request would suffice.
- Custom output jobs bypass sanitization, limits, threat detection, or human
  gates.
- Agents can create agents or dispatch workflows without depth and fan-out
  limits.

Reduce authority at the workflow boundary. Route writes through declared safe
outputs, constrain mutable values, and require explicit control-policy authority
for live work.

## Review trust and security

Trust and security smells indicate that untrusted content, credentials, code,
or network access may cross a boundary without adequate controls.

- Raw issue, comment, pull request, branch, or dispatch payloads are inserted
  into expressions.
- `min-integrity: none` is used without an explicit untrusted-input design.
- Private-repository content is treated as inherently trusted.
- Every fork is allowed, or fork code is checked out under
  `pull_request_target`.
- Strict mode, sandboxing, the firewall, the integrity proxy, or threat
  detection is disabled.
- Secrets appear in workflow-level `env`, prompts, memory, artifacts, or tools
  exposed to the agent.
- Bash or MCP tools expose broad capabilities beyond the workflow mission.
- Network ecosystems, wildcard domains, or caller-extensible egress are allowed
  without a concrete need.
- Actions, containers, skills, plugins, engines, or upstream workflows use
  mutable references.
- Package installation scripts are enabled without review.
- Agents can change dependency manifests, workflows, `CODEOWNERS`, or agent
  instructions without protected-file review.
- Writable caches are shared across trusted and untrusted runs.

Treat threat-detection verdicts as security findings, not agent smells. Stop or
contain unsafe activity before optimizing cost or behavior.

## Review triggers and coordination

Trigger and coordination smells indicate excess execution, recursion, lost
lineage, or competing work.

- The workflow runs on every push, check, comment, or lifecycle event without
  filtering.
- There is no skip condition, cooldown, rate limit, concurrency policy, or
  bot/role restriction.
- A reactive run handles each item when a scheduled batch would suffice.
- Workflow triggering or orchestration can recurse without bounds.
- Workers rediscover scope or dispatch additional workers.
- Dispatch context or a correlation identifier is missing.
- Idempotency, deduplication, locking, checkpointing, or race protection is
  absent.
- One long agent run processes thousands of items instead of using batches or a
  work queue.

Keep discovery and dispatch in the orchestrator. Give each worker one bounded
target and preserve correlation data through every handoff.

## Review outputs and rollout

Output and rollout smells indicate that durable changes may outpace confidence,
review, or cleanup.

- A prototype moves directly to production writes without a report-only,
  review, staged, or shadow phase.
- Issues, comments, reviews, or pull requests can be duplicated because there
  is no deduplication or lifecycle cleanup.
- Instructions omit `noop`, causing safe-output handling to fail when no change
  is appropriate.
- Patch size, write count, persistent assets, or bot mentions are unbounded.
- AI-generated blocking reviews can remain stale after the underlying code
  changes.
- A shadow system becomes a second source of truth.
- Attribution, threat findings, or failures are suppressed to improve reported
  metrics.

Begin in `review`, inspect evidence and output quality, and promote only a
bounded target set with explicit authority. Retain no-op and failure evidence.

## Review cost, memory, and value

These smells indicate that resource consumption or retained context is not
connected to accepted operational outcomes.

- AI credit, daily, turn, or timeout budgets are disabled or excessive.
- Frontier models handle classification, labeling, summaries, or routine
  triage without evidence that they improve outcomes.
- Agent turns repeat data fetching that deterministic steps or caching could
  perform.
- A full monorepo and history are checked out when sparse checkout is enough.
- Memory lacks retention rules, schema metadata, ownership, or conflict
  handling.
- Secrets, personal data, individual user data, or untrusted instructions are
  persisted in memory.
- Measurement covers only successful runs, tokens, or cost.
- Conclusions depend on one run or one synthetic score.
- Outputs are routinely ignored, rejected, duplicated, or overlap another
  workflow.
- Cost decreases while accepted outcomes also decline.

Compare cost with mature, accepted outcomes. Evaluate model and budget changes
against a representative baseline rather than a single run.

## Review configuration

Configuration smells indicate that source, generated artifacts, and runtime
policy may no longer agree.

- Frontmatter changes are not followed by workflow compilation.
- Generated `.lock.yml` files are edited directly.
- Compiler or runtime versions are stale or vulnerable.
- Strict validation or update checks are disabled, threat suppressions are
  permanent, or experimental features run in production without explicit risk
  acceptance.
- Shared workflows hide assumptions about repository names, branches, labels,
  teams, secrets, or permissions.

Change editable workflow sources, compile them, and review generated artifacts.
Keep rollout policy and workflow changes together so a run resolves both at the
same commit.

## Investigate a smell

1. Confirm the source classification and read the attached evidence.
2. Check whether the evidence is complete, current, and attributed to the
   expected repository, workflow, and run.
3. Decide whether the condition is intentional and document any accepted risk.
4. Apply the narrowest remediation that preserves the workflow's mission.
5. Re-run the relevant audit or validation and compare the resulting outcome,
   not only the smell count.

An empty smell list means that no supported detector emitted evidence. It does
not prove that the workflow is healthy or that none of the review heuristics
apply.

## Further reading

- [gh-aw security architecture](https://github.github.com/gh-aw/introduction/architecture/)
- [Safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/)
- [Cost management](https://github.github.com/gh-aw/reference/cost-management/)
- [Integrity](https://github.github.com/gh-aw/reference/integrity/)
- [Triggers](https://github.github.com/gh-aw/reference/triggers/)
- [Safe rollout](https://github.github.com/gh-aw/practices/safe-rollout/)
- [Measuring impact](https://github.github.com/gh-aw/practices/measuring-impact/)
- [Audit implementation](https://github.com/github/gh-aw/blob/main/pkg/cli/audit_agentic_analysis.go)