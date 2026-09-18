#!/usr/bin/env bash

# Measures whether the current run requested the assigned target-bound token
# efficiency experiment. Ratio, higher is better: 1 conforming, 0
# contradictory, null when unavailable or the run no-ops.

set -euo pipefail
export LC_ALL=C

[[ $# -eq 0 ]] || exit 2
request=$(cat)
jq -c '
  def kind: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def workflow: .event.inputs.workflow_path // .event.inputs.workflowPath // .config.workflow_path // null;
  def opportunity: .event.inputs.opportunity_kind // .event.inputs.opportunityKind // .config.opportunity_kind // null;
  if .schemaVersion != 1 or (.run | type) != "object" or (.event | type) != "object"
      or (.outputs | type) != "array" or (.config | type) != "object" then
    [{id:"token-efficiency-request-conformance",value:null}]
  elif (target | type) != "string" or (workflow | type) != "string" or (opportunity | type) != "string" then
    [{id:"token-efficiency-request-conformance",value:null}]
  elif (.outputs | length) == 1 and (.outputs[0] | kind) == "noop" then
    [{id:"token-efficiency-request-conformance",value:null}]
  else
    target as $target | workflow as $workflow | opportunity as $opportunity
    | [.outputs[] | select(kind == "create_issue")] as $issues
    | [{id:"token-efficiency-request-conformance",value:
        (if ($issues | length) == 1
            and (($issues[0].title // "") | contains($target))
            and (($issues[0].title // "") | contains($workflow))
            and (($issues[0].title // "") | contains($opportunity))
            and (($issues[0].body // "") | contains("**Action:**"))
            and (($issues[0].body // "") | test("(?i)opportunity.?id"))
            and (($issues[0].body // "") | test("(?i)experiment.?id"))
            and (($issues[0].body // "") | contains("<details><summary><b>Agent prompt</b></summary>"))
            and (($issues[0].body // "") | test("(?i)unapplied"))
         then 1 else 0 end)}]
  end
' <<<"$request"