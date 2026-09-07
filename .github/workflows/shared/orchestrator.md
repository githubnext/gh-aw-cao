---
post-steps:
  - name: Emit control-plane orchestrator telemetry
    if: ${{ always() }}
    continue-on-error: true
    uses: actions/github-script@v9.0.0
    with:
      script: |
        const fs = require('fs');
        const otlp = require('/tmp/gh-aw/actions/otlp.cjs');

        function readJson(file, fallback) {
          try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
          } catch {
            return fallback;
          }
        }

        function count(value) {
          const parsed = Number(value);
          return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
        }

        const precompute = readJson('/tmp/gh-aw/agent/control-precompute.json', {});
        const output = readJson('/tmp/gh-aw/agent_output.json', { items: [] });
        const items = Array.isArray(output.items) ? output.items : [];
        const dispatches = items.filter(item => item?.type === 'dispatch_workflow');
        const incompleteCount = items.filter(item => item?.type === 'report_incomplete').length;
        const noopCount = items.filter(item => item?.type === 'noop').length;
        const targetCount = new Set(dispatches.map(item => item?.inputs?.target_repo).filter(Boolean)).size;
        const workflowCount = new Set(dispatches.map(item => item?.workflow_name).filter(Boolean)).size;
        const dispatchModes = new Set(dispatches.map(item => item?.inputs?.safe_output_mode).filter(Boolean));
        const effectiveMode = dispatchModes.size === 0
          ? String(precompute.safe_output_mode || 'unknown')
          : dispatchModes.size === 1
            ? [...dispatchModes][0]
            : 'mixed';
        const status = incompleteCount > 0
          ? 'incomplete'
          : dispatches.length > 0
            ? 'requested'
            : noopCount > 0
              ? 'noop'
              : 'empty';

        await otlp.logSpan('central-agentic-ops.orchestrator', {
          'central_agentic_ops.orchestrator.package': String(precompute.package || precompute.bundle || 'unknown'),
          'central_agentic_ops.orchestrator.status': status,
          'central_agentic_ops.orchestrator.enabled': precompute.enabled === true,
          'central_agentic_ops.orchestrator.safe_output_mode': effectiveMode,
          'central_agentic_ops.orchestrator.candidate_count': Array.isArray(precompute.candidate_repositories) ? precompute.candidate_repositories.length : 0,
          'central_agentic_ops.orchestrator.target_limit': count(precompute.effective_max_repos),
          'central_agentic_ops.orchestrator.dispatch_requested_count': dispatches.length,
          'central_agentic_ops.orchestrator.target_count': targetCount,
          'central_agentic_ops.orchestrator.workflow_count': workflowCount,
          'central_agentic_ops.orchestrator.incomplete_count': incompleteCount,
        }, {
          isError: incompleteCount > 0,
          errorMessage: incompleteCount > 0 ? 'orchestrator reported incomplete' : undefined,
        });
---

If `control_role` is `orchestrator`, filter and prioritize target repositories, then dispatch the configured worker workflows.

Use the `enabled`, `inventory_version`, `batch_id`, `max_repos`, `rollout_percent`, `effective_max_repos`, `monthly_credit_budget`, `monthly_ai_credits_spent`, `monthly_ai_credits_remaining`, `monthly_budget_target_cap`, `safe_output_mode`, `safe_output_repo`, and per-candidate `safe_output_mode` fields from `/tmp/gh-aw/agent/control-precompute.json`; do not infer those values from workflow inputs.

For orchestrators, use the importing package's `Discovery` and `Workers` sections only for ranking, prioritization, and deciding whether a precomputed candidate is useful for this package.

- If `enabled` is not `true`, do not select repositories or dispatch workers. Call `report_incomplete` explaining that the package is disabled by its package kill switch.
- If `repo_error` is non-empty, select no repositories and dispatch no workers. Call `report_incomplete` with the precomputed error; do not retry discovery, fall back to inferred inventory, or wait for an API rate limit to reset.
- If `monthly_budget_error` is non-empty, select no repositories and dispatch no workers. Call `report_incomplete` with the precomputed error; do not ignore the configured budget or estimate missing usage.

Continue with the repository targeting and workflow dispatch steps below.

1. Select target repositories:
  - use `candidate_repositories` from `/tmp/gh-aw/agent/control-precompute.json`
  - treat each candidate's `safe_output_mode` as authoritative for that target; never substitute the package default or widen `review` to `live`
  - treat that list as the complete current batch; do not discover repositories from another cell or batch
  - skip archived or disabled repositories and repositories where required data could not be precomputed
  - use the importing package's `Discovery` section to rank candidates
  - select no more than `effective_max_repos` repositories; it is the stricter cap derived from `max_repos` and `rollout_percent`
  - do not exceed the configured `dispatch-workflow.max` limit

2. Resolve enabled worker workflows before dispatching:
  - use `worker_workflows` from `/tmp/gh-aw/agent/control-precompute.json`
  - if a configured worker workflow has `skip_reason`, do not dispatch that worker; record that reason
  - only enabled worker workflows are eligible for dispatch
  - treat each eligible worker's `max_mode` as an optional ceiling; `null` inherits the selected candidate's mode

3. Compute the mode and output repository for each target-and-worker pair:
  - start `effective_safe_output_mode` at the selected candidate's `safe_output_mode`
  - when the worker's `max_mode` is `review`, set `effective_safe_output_mode` to `review`; never use a worker ceiling to widen a review candidate
  - when `effective_safe_output_mode` is `live`, set `effective_safe_output_repo` to the selected target repository
  - otherwise set `effective_safe_output_repo` to `safe_output_repo`

4. If no eligible target repositories are found, dispatch zero workers and report the targeting decision.

5. Dispatch each eligible worker workflow for each selected target repository with this standard input envelope:
  - call the configured `dispatch-workflow` tool from `<safe-output-tools>`; its name is the worker workflow slug with hyphens replaced by underscores
  - do not use `gh workflow run` or the Actions workflow-dispatch API; those bypass safe-output validation and do not count as safe outputs
  - when using shell transport, pipe the final JSON envelope to `safeoutputs <tool_name> .`; never invoke `<tool_name>`, `noop`, or `report_incomplete` as a bare shell command
  - `target_repo`: selected target repository
  - `safe_output_mode`: `effective_safe_output_mode`
  - `safe_output_repo`: `effective_safe_output_repo`
  - `correlation_id`: `__GH_AW_GITHUB_RUN_ID__-__GH_AW_GITHUB_RUN_NUMBER__`
  - `central_repo`: `__GH_AW_GITHUB_REPOSITORY__`
  - `control_plane_run_url`: `__GH_AW_GITHUB_SERVER_URL__/__GH_AW_GITHUB_REPOSITORY__/actions/runs/__GH_AW_GITHUB_RUN_ID__`
  - `batch_label`: omitted unless a worker requires it

  If a dispatch fails or is rate-limited, do not retry it in the same run. Record that target and worker as deferred, continue only when doing so stays within all remaining caps, and report the partial outcome as incomplete.

6. Finish with the exact report structure below. Keep every heading and field, using `0`, `none`, or `not applicable` rather than omitting empty fields. Use the exact `total_repositories_scanned` value from precompute; compute eligible candidates after applying repository exclusions and before ranking or `max_repos`.

  ```markdown
  ## Orchestrator Report

  ### Scope
  - Total repositories scanned: <total_repositories_scanned>
  - Eligible candidates: <count after exclusions>
  - Selected targets: <count>
  - Default safe output mode: <safe_output_mode>
  - Default review output repository: <safe_output_repo or not applicable>
  - Selected target modes: <target-to-mode list or none>
  - Live target changes allowed: <live target list or none>
  - Monthly AI Credit budget: <monthly_credit_budget, or disabled when 0>
  - Month-to-date AI Credits: <monthly_ai_credits_spent>
  - Monthly AI Credits remaining: <monthly_ai_credits_remaining>
  - Budget target cap: <monthly_budget_target_cap>

  ### Repository Decisions
  - Selected: <repository list with priority rationale, or none>
  - Skipped: <repository list with reason for each, or none>
  - Deferred: <repository list with reason for each, or none>

  ### Workers
  - Configured: <workflow list or none>
  - Enabled: <workflow list or none>
  - Skipped: <workflow list with reason for each, or none>

  ### Dispatches
  - Dispatched: <count>
  - Details: <target-to-worker dispatch list, or none>

  ### Outcome
  <concise result, no-op explanation, or incomplete reason>
  ```

  Package-specific completion instructions may add details to this report but must not rename or omit its standard fields.