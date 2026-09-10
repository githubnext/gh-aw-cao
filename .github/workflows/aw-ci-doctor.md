---
emoji: ":stethoscope:"

description: "Performs cheap CI failure pre-categorization for one target repository and escalates only P0 failures to the AW failures investigator"

intent: Reduce unnecessary deep investigations by triaging CI failure severity first and dispatching the investigator only for P0 failures.

name: "AW Doctor / CI Doctor"

max-ai-credits: 200
max-daily-ai-credits: -1

on:
  bots: ["github-actions[bot]", "cao-githubnext-gh-aw-cao-write[bot]"]
  workflow_dispatch:
    inputs:
      target_repo:
        required: true
        type: string
      safe_output_repo:
        required: true
        type: string
      max_repos:
        type: number
      rollout_percent:
        type: number
      safe_output_mode:
        type: string
      correlation_id:
        type: string
      central_repo:
        type: string
      control_plane_run_url:
        type: string
      batch_label:
        type: string
  permissions:
    contents: read
    actions: read

checkout:
  - repository: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
    github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
    fetch-depth: 0
    fetch: ["*"]
    current: true
  - repository: ${{ inputs.target_repo }}
    github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
    path: target

env:
  GH_AW_SAFE_OUTPUT_MODE: ${{ inputs.safe_output_mode || 'review' }}
  REVIEW_OUTPUT_REPO: ${{ inputs.safe_output_repo || github.repository }}
  SAFE_OUTPUT_REPO: ${{ (inputs.safe_output_mode || 'review') == 'review' && (inputs.safe_output_repo || github.repository) || inputs.target_repo }}
  TARGET_REPO: ${{ inputs.target_repo || '' }}

environment: central-agentic-ops

jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
      cao_reason: ${{ steps.cao_precompute.outputs.reason || steps.cao_admission.outputs.reason }}

if: needs.pre_activation.outputs.cao_authorized == 'true'

imports:
  - uses: shared/control.md
    with:
      package: aw-doctor
      role: worker
      worker: ci-doctor

permissions:
  contents: read
  actions: read
  copilot-requests: write

strict: true

network:
  allowed:
    - defaults
    - github

run-name: "AW CI doctor · ${{ inputs.target_repo }} · ${{ inputs.safe_output_mode || 'review' }}"

concurrency:
  group: "${{ github.workflow }}-${{ inputs.target_repo }}"
  job-discriminator: ${{ github.run_id }}
  cancel-in-progress: true

tracker-id: aw-ci-doctor

skills:
  - .github/aw/skills/aw-ci-failure-pre-categorization

tools:
  github:
    mode: remote
    toolsets: [actions]
  bash:
    - "*"

safe-outputs:
  dispatch-workflow:
    workflows: [aw-failures-investigator]
    max: 1

timeout-minutes: 20

steps:
  - name: Deterministic pre-fetch of CI failure evidence
    uses: actions/github-script@v9
    env:
      GH_TOKEN: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
      TARGET_REPOSITORY: ${{ inputs.target_repo }}
    with:
      github-token: ${{ secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
      script: |
        const fs = require('fs');
        const path = require('path');
        const { execFileSync } = require('child_process');

        const REPO = process.env.TARGET_REPOSITORY;
        const OUT = '/tmp/gh-aw/agent/aw-ci-doctor/prefetch.json';
        const LOOKBACK_HOURS = 24;
        const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
        const MAX_RUNS = 5;

        function runJson(args) {
          try {
            const out = execFileSync('gh', args, { encoding: 'utf8' });
            return out ? JSON.parse(out) : null;
          } catch {
            return null;
          }
        }

        function normalizeWorkflowPath(workflowPath) {
          return String(workflowPath || '').split('@', 1)[0];
        }

        function isAgenticWorkflowPath(workflowPath) {
          return normalizeWorkflowPath(workflowPath).endsWith('.lock.yml');
        }

        function isoformatZ(date) {
          return `${date.toISOString().split('.')[0]}Z`;
        }

        const createdSince = isoformatZ(new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000));
        const response =
          runJson([
            'api',
            `repos/${REPO}/actions/runs?exclude_pull_requests=true&status=completed&created=>=${createdSince}&per_page=100`,
          ]) || {};
        const allRuns = Array.isArray(response.workflow_runs) ? response.workflow_runs : [];
        const failedRuns = allRuns
          .filter((run) => FAILURE_CONCLUSIONS.has(String(run.conclusion || '').toLowerCase()))
          .filter((run) => isAgenticWorkflowPath(run.path))
          .slice(0, MAX_RUNS);

        const runSummaries = [];
        for (const run of failedRuns) {
          runSummaries.push({
            id: run.id,
            workflow_path: normalizeWorkflowPath(run.path),
            workflow_name: run.name,
            conclusion: run.conclusion,
            status: run.status,
            run_attempt: run.run_attempt,
            created_at: run.created_at,
            url: run.html_url,
            head_sha: run.head_sha,
          });
        }

        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(
          OUT,
          `${JSON.stringify({
            generated_at: isoformatZ(new Date()),
            lookback_hours: LOOKBACK_HOURS,
            target_repo: REPO,
            failed_runs_found: failedRuns.length,
            failed_runs: runSummaries,
          }, null, 2)}\n`,
          'utf8',
        );
---

{{#runtime-import? .github/cao/aw-doctor.md}}

You are the AW Doctor / CI Doctor worker.

Use the installed skill at `.github/aw/skills/aw-ci-failure-pre-categorization/SKILL.md` to perform a cheap, evidence-grounded pre-categorization of recent CI failures for exactly one target repository.

## Mission

1. Read `/tmp/gh-aw/agent/control-precompute.json` and verify package, worker, target repository, and mode authorization before acting.
2. Read `/tmp/gh-aw/agent/aw-ci-doctor/prefetch.json` once.
3. Classify the current failure state as `P0`, `P1`, `P2`, or `NO_FAILURE` using only the prefetch evidence and the installed skill.
4. If and only if classification is `P0`, dispatch `aw-failures-investigator` exactly once for this same target and mode with the standard dispatch envelope from `shared/control.md`.
5. For `P1`, `P2`, or `NO_FAILURE`, do not dispatch any workflow and call `noop` once with a compact triage summary.

## Escalation gate

- Escalate only when evidence supports a P0 condition (startup failure, agent or infrastructure crash, or broad blocking failure).
- Never escalate on uncertainty alone.
- If evidence is incomplete, fail closed with `noop` and explain the missing evidence.

## Completion

When escalating, include a short note in the dispatch rationale describing why the pre-categorization is P0 and which run evidence triggered escalation.
