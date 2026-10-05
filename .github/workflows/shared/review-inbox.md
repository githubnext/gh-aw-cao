---
import-schema:
  campaign:
    type: string
    required: true
  finding_limits:
    type: string
    default: '{"create_issue":1}'

env:
  CAO_REVIEW_INBOX: "true"
  CAO_REVIEW_FINDING_LIMITS: '${{ github.aw.import-inputs.finding_limits }}'

jobs:
  cao_review_inbox:
    name: Publish serialized campaign review inbox
    runs-on: ubuntu-latest
    # These explicit edges prevent v0.89.22 treating this as a prompt prerequisite.
    needs: [agent, activation, pre_activation, safe_outputs]
    if: needs.pre_activation.outputs.cao_authorized == 'true' && needs.safe_outputs.result == 'success' && (inputs.safe_output_mode || 'review') == 'review'
    concurrency:
      group: cao-review-inbox-${{ inputs.safe_output_repo || github.repository }}-${{ github.aw.import-inputs.campaign }}
      cancel-in-progress: false
      queue: max
    permissions:
      contents: read
      actions: read
      issues: write
    env:
      CAO_MODE: ${{ inputs.safe_output_mode || 'review' }}
      CAO_TARGET_REPOSITORY: ${{ inputs.target_repo }}
      CAO_SAFE_OUTPUT_REPOSITORY: ${{ inputs.safe_output_repo || github.repository }}
      GITHUB_WORKFLOW_SHA: ${{ github.workflow_sha }}
      GH_AW_AGENT_OUTPUT: /tmp/gh-aw/agent_output.json
    steps:
      - name: Setup gh-aw runtime scripts
        uses: github/gh-aw-actions/setup@2fbab69bfca02bebd76cd0fc43f2d12acfed994f # v0.89.22
        with:
          destination: ${{ runner.temp }}/gh-aw/actions
      - name: Checkout review publisher at the workflow SHA
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.workflow_sha }}
          path: .cao-review
          sparse-checkout: .github/workflows/shared
          persist-credentials: false
          token: ${{ github.token }}
      - name: Restore original agent output
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          pattern: "{agent,agent-output-fallback}"
          merge-multiple: true
          path: /tmp/gh-aw
      - name: Restore exact authorization handoff
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: cao-control-precompute
          path: /tmp/gh-aw/agent
      - name: Restore publisher prerequisites and staged flag
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: cao-review-inbox-ready
          path: /tmp/gh-aw
      - name: Resolve review destination App scope
        id: cao_review_scope
        env:
          CAO_DESTINATION: ${{ inputs.safe_output_repo || github.repository }}
        run: |
          set -euo pipefail
          IFS=/ read -r owner repository extra <<< "$CAO_DESTINATION"
          if [[ -z "$owner" || -z "$repository" || -n "$extra" ]]; then exit 1; fi
          echo "owner=$owner" >> "$GITHUB_OUTPUT"
          echo "repository=$repository" >> "$GITHUB_OUTPUT"
      - name: Generate existing destination-scoped write App credential
        id: cao_review_app_token
        env:
          CAO_APP_ID: ${{ (vars.GH_AW_GITHUB_AUTH_MODE == 'app' || vars.GH_AW_GITHUB_AUTH_MODE == '') && vars.GH_AW_GITHUB_WRITE_APP_ID || '' }}
          CAO_APP_KEY: ${{ (vars.GH_AW_GITHUB_AUTH_MODE == 'app' || vars.GH_AW_GITHUB_AUTH_MODE == '') && secrets.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY || '' }}
        if: ${{ env.CAO_APP_ID != '' && env.CAO_APP_KEY != '' }}
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          client-id: ${{ (vars.GH_AW_GITHUB_AUTH_MODE == 'app' || vars.GH_AW_GITHUB_AUTH_MODE == '') && vars.GH_AW_GITHUB_WRITE_APP_ID || '' }}
          private-key: ${{ (vars.GH_AW_GITHUB_AUTH_MODE == 'app' || vars.GH_AW_GITHUB_AUTH_MODE == '') && secrets.GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY || '' }}
          owner: ${{ steps.cao_review_scope.outputs.owner }}
          repositories: ${{ steps.cao_review_scope.outputs.repository }}
          github-api-url: ${{ github.api_url }}
          permission-issues: write
      - name: Publish review findings through the shared safe-output adapter
        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
        env:
          CAO_WRITE_TOKEN: ${{ steps.cao_review_app_token.outputs.token || vars.GH_AW_GITHUB_AUTH_MODE == 'pat' && secrets[fromJSON(vars.GH_AW_GITHUB_WRITE_PAT_REPOSITORIES || '{}')[inputs.safe_output_repo || github.repository]] || vars.GH_AW_GITHUB_AUTH_MODE == '' && secrets.GH_AW_GITHUB_WRITE_PAT || vars.GH_AW_GITHUB_AUTH_MODE == '' && secrets.GH_AW_GITHUB_TOKEN || (vars.GH_AW_GITHUB_AUTH_MODE == '' || vars.GH_AW_GITHUB_AUTH_MODE == 'workflow-token') && secrets.GITHUB_TOKEN }}
        with:
          github-token: ${{ steps.cao_review_app_token.outputs.token || vars.GH_AW_GITHUB_AUTH_MODE == 'pat' && secrets[fromJSON(vars.GH_AW_GITHUB_WRITE_PAT_REPOSITORIES || '{}')[inputs.safe_output_repo || github.repository]] || vars.GH_AW_GITHUB_AUTH_MODE == '' && secrets.GH_AW_GITHUB_WRITE_PAT || vars.GH_AW_GITHUB_AUTH_MODE == '' && secrets.GH_AW_GITHUB_TOKEN || (vars.GH_AW_GITHUB_AUTH_MODE == '' || vars.GH_AW_GITHUB_AUTH_MODE == 'workflow-token') && secrets.GITHUB_TOKEN }}
          script: |
            if (!process.env.CAO_WRITE_TOKEN) throw new Error("No existing review destination write credential");
            const runtime = await import(`${process.env.GITHUB_WORKSPACE}/.cao-review/.github/workflows/shared/review-inbox-runtime.mjs`);
            await runtime.runInbox({ github, core }, "publish");
---

Issue-capable review workers use the serialized campaign inbox. This import does not grant new agent tools or live authority.
