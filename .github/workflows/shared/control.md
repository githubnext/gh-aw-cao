---
import-schema:
  package:
    type: string
    required: true
  role:
    type: choice
    options: [orchestrator, worker]
    required: true
  worker:
    type: string
    default: "__none__"
  dispatch_max:
    type: number
    default: "1"
  orchestrator_credits:
    type: number
    default: "0"
  worker_credits_per_target:
    type: number
    default: "0"

max-daily-ai-credits: -1

github-app:
  client-id: ${{ vars.GH_AW_GITHUB_READ_APP_ID }}
  private-key: ${{ secrets.GH_AW_GITHUB_READ_APP_PRIVATE_KEY }}
  ignore-if-missing: true

safe-outputs:
  github-app:
    client-id: ${{ vars.GH_AW_GITHUB_WRITE_APP_ID }}
    private-key: ${{ secrets.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY }}
    ignore-if-missing: true

env:
  CAO_PACKAGE: ${{ github.aw.import-inputs.package }}
  CAO_ROLE: ${{ github.aw.import-inputs.role }}
  CAO_WORKER: ${{ github.aw.import-inputs.worker }}

tools:
  github:
    mode: remote
    toolsets: [repos, actions]

jobs:
  pre-activation:
    pre-steps:
      - name: Generate CAO pre-activation GitHub App token
        id: cao_pre_activation_app_token
        env:
          CAO_GITHUB_APP_ID: ${{ vars.GH_AW_GITHUB_READ_APP_ID }}
          CAO_GITHUB_APP_PRIVATE_KEY: ${{ secrets.GH_AW_GITHUB_READ_APP_PRIVATE_KEY }}
        if: ${{ env.CAO_GITHUB_APP_ID != '' && env.CAO_GITHUB_APP_PRIVATE_KEY != '' }}
        uses: actions/create-github-app-token@v3.2.0
        with:
          client-id: ${{ vars.GH_AW_GITHUB_READ_APP_ID }}
          private-key: ${{ secrets.GH_AW_GITHUB_READ_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          github-api-url: ${{ github.api_url }}
          permission-actions: read
          permission-contents: read

      - name: Checkout CAO control modules
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.workflow_sha }}
          path: .cao
          sparse-checkout: .github/cao/src
          sparse-checkout-cone-mode: true
          fetch-depth: 1
          persist-credentials: false
          token: ${{ steps.cao_pre_activation_app_token.outputs.token || secrets.GH_AW_GITHUB_TOKEN || github.token }}

      - name: Evaluate Central Agentic Ops admission
        id: cao_admission
        env:
          CAO_API_TOKEN: ${{ steps.cao_pre_activation_app_token.outputs.token || secrets.GH_AW_GITHUB_TOKEN || github.token }}
          GH_TOKEN: ${{ github.token }}
          GITHUB_WORKFLOW_SHA: ${{ github.workflow_sha }}
          CAO_PACKAGE: ${{ github.aw.import-inputs.package }}
          CAO_ROLE: ${{ github.aw.import-inputs.role }}
          CAO_WORKER: ${{ github.aw.import-inputs.worker }}
          CAO_WORKFLOW_DISPATCH_INPUTS: ${{ toJSON(github.event.inputs) }}
        run: |
          set -uo pipefail
          read_dispatch_input() {
            node -e 'const parsed = JSON.parse(process.env.CAO_WORKFLOW_DISPATCH_INPUTS || "{}"); const inputs = parsed && typeof parsed === "object" ? parsed : {}; const value = inputs[process.argv[1]]; process.stdout.write(value == null ? "" : String(value));' "$1"
          }
          export CAO_TARGET_REPOSITORY="$(read_dispatch_input target_repo)"
          export CAO_REQUESTED_MODE="$(read_dispatch_input safe_output_mode)"
          export CAO_REQUESTED_MAX_REPOSITORIES="$(read_dispatch_input max_repos)"
          export CAO_REQUESTED_ROLLOUT_PERCENT="$(read_dispatch_input rollout_percent)"
          cao_dir="${GITHUB_WORKSPACE:-.}/.cao/.github/cao/src"
          if node "$cao_dir/control.mjs" admit; then
            exit 0
          fi
          reason="cannot read or execute the CAO control modules at github.workflow_sha"
          {
            echo "authorized=false"
            echo "reason=$reason"
            echo "monthly_credit_budget=0"
          } >> "$GITHUB_OUTPUT"
          cat >> "$GITHUB_STEP_SUMMARY" <<EOF
          <details>
          <summary><h3>Central Agentic Ops admission</h3></summary>

          Skipped: $reason

          - ❌ Runtime revision — The control and policy modules could not be read or executed from the exact \`github.workflow_sha\` commit.
          - Policy and authorization checks — The remaining admission checks could not run because the authoritative control modules were unavailable.

          </details>
          EOF

      - name: Ensure CAO admission record
        if: ${{ always() }}
        env:
          CAO_ADMISSION_AUTHORIZED: ${{ steps.cao_admission.outputs.authorized }}
          CAO_ADMISSION_REASON: ${{ steps.cao_admission.outputs.reason }}
          CAO_PACKAGE: ${{ github.aw.import-inputs.package }}
          CAO_ROLE: ${{ github.aw.import-inputs.role }}
          CAO_WORKER: ${{ github.aw.import-inputs.worker }}
        run: |
          set -euo pipefail
          record="${RUNNER_TEMP}/cao/admission.json"
          if [[ -f "$record" ]]; then
           exit 0
          fi
          mkdir -p "$(dirname "$record")"
          node - "$record" <<'EOF'
          const fs = require("node:fs");
          const checks = [
           "Runtime revision", "Policy document", "Control plane", "Workflow identity",
           "Package", "Worker", "Target input", "Mode input", "Run limits",
           "GitHub API capacity", "Runner disk capacity",
          ].map((check, index) => ({ check, status: index === 0 ? "failed" : "not-evaluated" }));
          fs.writeFileSync(process.argv[2], `${JSON.stringify({
           schema_version: 1,
           observed_at: new Date().toISOString(),
           repository: process.env.GITHUB_REPOSITORY || "",
           workflow: process.env.GITHUB_WORKFLOW || "",
           workflow_sha: process.env.GITHUB_WORKFLOW_SHA || "",
           run_id: process.env.GITHUB_RUN_ID || "",
           run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
           package: process.env.CAO_PACKAGE || "",
           role: process.env.CAO_ROLE || "",
           worker: process.env.CAO_ROLE === "orchestrator" ? "" : process.env.CAO_WORKER || "",
           target_repository: "",
           authorized: process.env.CAO_ADMISSION_AUTHORIZED === "true",
           reason: process.env.CAO_ADMISSION_REASON || "cannot read or execute the CAO control modules at github.workflow_sha",
           failed_check: "Runtime revision",
           checks,
          }, null, 2)}\n`);
          EOF

      - name: Upload CAO admission artifact
        if: ${{ always() }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: cao-admission
          path: ${{ runner.temp }}/cao/admission.json
          if-no-files-found: error
          retention-days: 8

      - name: "CAO admission blocked: GitHub API limited until ${{ steps.cao_admission.outputs.github_api_reset_at }}"
        if: ${{ steps.cao_admission.outputs.reason == 'github-api-capacity-insufficient' }}
        env:
          CAO_API_LIMIT: ${{ steps.cao_admission.outputs.github_api_limit }}
          CAO_API_REMAINING: ${{ steps.cao_admission.outputs.github_api_remaining }}
          CAO_API_REQUIRED: ${{ steps.cao_admission.outputs.github_api_required }}
          CAO_API_RESET_AT: ${{ steps.cao_admission.outputs.github_api_reset_at }}
        run: |
          echo "::error title=CAO admission blocked by GitHub API capacity::${CAO_API_REMAINING} of ${CAO_API_LIMIT} core requests remain; ${CAO_API_REQUIRED} required. Retry after ${CAO_API_RESET_AT}. See the admission summary for next steps."
          exit 1

      - name: "CAO admission blocked: GitHub API capacity unavailable"
        if: ${{ steps.cao_admission.outputs.reason == 'github-api-capacity-unavailable' }}
        run: |
          echo "::error title=CAO admission could not verify GitHub API capacity::Check authentication and GitHub API status. See the admission summary for next steps."
          exit 1

      - name: "CAO admission blocked: runner disk space too low"
        if: ${{ steps.cao_admission.outputs.reason == 'runner-disk-capacity-insufficient' }}
        env:
          CAO_DISK_AVAILABLE: ${{ steps.cao_admission.outputs.runner_disk_available_mb }}
          CAO_DISK_REQUIRED: ${{ steps.cao_admission.outputs.runner_disk_required_mb }}
          CAO_DISK_PATH: ${{ steps.cao_admission.outputs.runner_disk_path }}
        run: |
          echo "::error title=CAO admission blocked by runner disk capacity::${CAO_DISK_AVAILABLE} MB free on ${CAO_DISK_PATH}; ${CAO_DISK_REQUIRED} MB required. See the admission summary for next steps."
          exit 1

      - name: "CAO admission blocked: runner disk capacity unavailable"
        if: ${{ steps.cao_admission.outputs.reason == 'runner-disk-capacity-unavailable' }}
        env:
          CAO_DISK_PATH: ${{ steps.cao_admission.outputs.runner_disk_path }}
        run: |
          echo "::error title=CAO admission could not verify runner disk capacity::Free disk space could not be read for ${CAO_DISK_PATH}. See the admission summary for next steps."
          exit 1

      - name: Install gh-aw CLI when monthly budget is enabled
        if: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_admission.outputs.monthly_credit_budget != '0' }}
        uses: github/gh-aw-actions/setup-cli@v0.88.4
        with:
          version: v0.88.4

      - name: Run CAO control precompute
        id: cao_precompute
        if: ${{ steps.cao_admission.outputs.authorized == 'true' }}
        env:
          GH_TOKEN: ${{ steps.cao_pre_activation_app_token.outputs.token || secrets.GH_AW_GITHUB_TOKEN || github.token }}
          GITHUB_WORKFLOW_SHA: ${{ github.workflow_sha }}
          CAO_PACKAGE: ${{ github.aw.import-inputs.package }}
          CAO_ROLE: ${{ github.aw.import-inputs.role }}
          CAO_WORKER: ${{ github.aw.import-inputs.worker }}
          CAO_WORKFLOW_DISPATCH_INPUTS: ${{ toJSON(github.event.inputs) }}
          CAO_DISPATCH_MAX: "${{ github.aw.import-inputs.dispatch_max }}"
          CAO_ORCHESTRATOR_CREDITS: "${{ github.aw.import-inputs.orchestrator_credits }}"
          CAO_WORKER_CREDITS_PER_TARGET: "${{ github.aw.import-inputs.worker_credits_per_target }}"
        run: |
          set -euo pipefail
          read_dispatch_input() {
            node -e 'const parsed = JSON.parse(process.env.CAO_WORKFLOW_DISPATCH_INPUTS || "{}"); const inputs = parsed && typeof parsed === "object" ? parsed : {}; const value = inputs[process.argv[1]]; process.stdout.write(value == null ? "" : String(value));' "$1"
          }
          target_repo="$(read_dispatch_input target_repo)"
          requested_mode="$(read_dispatch_input safe_output_mode)"
          requested_safe_output_repo="$(read_dispatch_input safe_output_repo)"
          export CAO_REQUESTED_MODE="$requested_mode"
          export CAO_REQUESTED_MAX_REPOSITORIES="$(read_dispatch_input max_repos)"
          export CAO_REQUESTED_ROLLOUT_PERCENT="$(read_dispatch_input rollout_percent)"
          export CAO_TARGET_REPOSITORY="$target_repo"
          if [[ "${requested_mode:-review}" == "review" ]]; then
            export CAO_SAFE_OUTPUT_REPOSITORY="${requested_safe_output_repo:-$GITHUB_REPOSITORY}"
          else
            export CAO_SAFE_OUTPUT_REPOSITORY="$target_repo"
          fi
          export CAO_CORRELATION_ID="$(read_dispatch_input correlation_id)"
          export CAO_CENTRAL_REPOSITORY="$(read_dispatch_input central_repo)"
          export CAO_CONTROL_PLANE_RUN_URL="$(read_dispatch_input control_plane_run_url)"
          node "${GITHUB_WORKSPACE:-.}/.cao/.github/cao/src/control.mjs" precompute

      - name: "CAO precompute blocked: GitHub API limited until ${{ steps.cao_precompute.outputs.github_api_reset_at }}"
        if: ${{ steps.cao_precompute.outputs.reason == 'github-api-capacity-insufficient' }}
        env:
          CAO_API_LIMIT: ${{ steps.cao_precompute.outputs.github_api_limit }}
          CAO_API_REMAINING: ${{ steps.cao_precompute.outputs.github_api_remaining }}
          CAO_API_REQUIRED: ${{ steps.cao_precompute.outputs.github_api_required }}
          CAO_API_RESET_AT: ${{ steps.cao_precompute.outputs.github_api_reset_at }}
        run: |
          echo "::warning title=CAO precompute blocked by GitHub API capacity::${CAO_API_REMAINING} of ${CAO_API_LIMIT} core requests remain; ${CAO_API_REQUIRED} required. Retry after ${CAO_API_RESET_AT}. See the admission summary for next steps."

      - name: "CAO precompute blocked: GitHub API capacity unavailable"
        if: ${{ steps.cao_precompute.outputs.reason == 'github-api-capacity-unavailable' }}
        run: |
          echo "::warning title=CAO precompute could not verify GitHub API capacity::Check authentication and GitHub API status. See the admission summary for next steps."

      - name: Validate CAO control precompute artifact
        if: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
        env:
          GITHUB_WORKFLOW_SHA: ${{ github.workflow_sha }}
          CONTROL_REPOSITORY: ${{ github.repository }}
          CAO_PACKAGE: ${{ github.aw.import-inputs.package }}
          CAO_ROLE: ${{ github.aw.import-inputs.role }}
          CAO_WORKER: ${{ github.aw.import-inputs.worker }}
        run: |
          set -euo pipefail
          out=/tmp/gh-aw/agent/control-precompute.json
          expected_worker="$CAO_WORKER"
          [ "$CAO_ROLE" != "orchestrator" ] || expected_worker=""
          [ -f "$out" ]
          jq -e '.authorized == true' "$out" >/dev/null
          jq -e --arg package "$CAO_PACKAGE" '.package == $package and .bundle == $package' "$out" >/dev/null
          jq -e --arg role "$CAO_ROLE" '.control_role == $role' "$out" >/dev/null
          jq -e --arg worker "$expected_worker" '.worker == $worker' "$out" >/dev/null
          jq -e --arg repository "$CONTROL_REPOSITORY" --arg sha "$GITHUB_WORKFLOW_SHA" \
            '.policy_source == {repository:$repository,path:".github/workflows/cao.json",sha:$sha}' \
            "$out" >/dev/null

      - name: Upload CAO control precompute artifact
        if: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
        uses: actions/upload-artifact@v7.0.1
        with:
          name: cao-control-precompute
          path: /tmp/gh-aw/agent/control-precompute.json
          if-no-files-found: error
          retention-days: 1

  agent:
    pre-steps:
      - name: Download CAO control precompute artifact
        uses: actions/download-artifact@v8.0.1
        with:
          name: cao-control-precompute
          path: /tmp/gh-aw/agent

---

Read `/tmp/gh-aw/agent/control-precompute.json` before making control decisions. Treat it as authoritative for `control_role`, package enablement state, target repository inputs, safe-output routing, and worker workflow availability.
