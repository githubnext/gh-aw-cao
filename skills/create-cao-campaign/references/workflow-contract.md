# CAO campaign workflow contract

Use this checklist after the campaign outcome and worker split are stable.

## Orchestrator

- Name it with the exact campaign display name.
- Add a fuzzy schedule when periodic and `workflow_dispatch` with
  `target_repo`, `safe_output_repo`, `max_repos`, `rollout_percent`, and
  `safe_output_mode` defaulting to `review`.
- Import `shared/control.md` with static campaign identity and
  `role: orchestrator`; use only request-narrowing inputs.
- Use singleton concurrency, bounded credits, least privilege, explicit tools
  and network, `strict: true`, and `threat-detection: false`.
- Configure `repo-memory.branch-name: memory/<campaign-slug>` and store only
  bounded advisory dispatch state.
- List every worker in `safe-outputs.dispatch-workflow.workflows`, bound the
  maximum, and deduplicate `(worker, target_repo, mode)` tuples.
- Select and rank only. Do not perform target work.
- Finish with the standard Orchestrator Report inherited from shared control;
  do not copy or rename that contract.

## Worker

- Name it `<Campaign Name> / <Worker Name>` and give it a stable tracker ID.
- Accept the complete control envelope: `target_repo`, `safe_output_repo`,
  `safe_output_mode`, `correlation_id`, `central_repo`,
  `control_plane_run_url`, and `batch_label`.
- Import shared control with static campaign, worker, and `role: worker`.
- Use repository-scoped concurrency, least privilege, explicit tools and
  network, strict mode, bounded credits and timeout, and mission-specific safe
  outputs.
- Analyze only the dispatched target. Do not discover repositories, dispatch
  work, or widen mode.
- Use the complete Worker Report format required by shared control for issues
  and pull requests. Include campaign and worker labels.

## Shared requirements

- Declare the campaign and exact worker workflow slugs in
  `.github/workflows/cao.json`.
- Put the optional
  `{{#runtime-import? .github/cao/<campaign-slug>.md}}` at the bottom of every
  prompt. Do not create the consumer-owned steering file.
- Use stable identity and deterministic safe-output deduplication. A healthy,
  duplicate, or already-tracked outcome is a silent `noop`.
- Keep campaign memory advisory, bounded, validated, and free of secrets, raw
  source, prompts, logs, and unbounded API responses.
- For Copilot-backed workflows, declare `copilot-requests: write` and rely on
  the built-in workflow token. Do not configure `COPILOT_GITHUB_TOKEN`.
- Configure provider credentials as Actions secrets. Do not infer a provider
  from available secrets or silently change an installed workflow's engine.
