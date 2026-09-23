#!/usr/bin/env bash

# Workflow intent: give maintainers one evidence-complete repository-level view
# of agentic-workflow cost and reliability so they can prioritize optimization.
# actionable-token-audit is a proportion where 1 means the current run requested
# one target-bound audit containing its required cost, activity, reliability, and
# action fields; 0 means a contradictory durable output; null means the target or
# grading evidence is unavailable, or the run correctly emitted only a noop.

set -euo pipefail
export LC_ALL=C

[[ $# -eq 0 ]] || exit 2
request=$(cat)
jq -c '
  def kind: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def durable: kind == "create_issue" or kind == "update_issue";
  if .schemaVersion != 1 or (.run | type) != "object" or (.event | type) != "object"
      or (.outputs | type) != "array" or (.config | type) != "object" then
    [{id:"actionable-token-audit",value:null}]
  elif (target | type) != "string" or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{id:"actionable-token-audit",value:null}]
  elif (.outputs | length) == 1 and (.outputs[0] | kind) == "noop" then
    [{id:"actionable-token-audit",value:null}]
  else
    target as $target
    | [.outputs[] | select(durable)] as $issues
    | [{id:"actionable-token-audit",value:
        (if ($issues | length) == 1
            and (($issues[0].title // "") | contains("Token usage audit for " + $target))
            and (($issues[0].body // "") | contains($target))
            and (($issues[0].body // "") | contains("**Action:**"))
            and (($issues[0].body // "") | contains("**Period:**"))
            and (($issues[0].body // "") | contains("**Total runs:**"))
            and (($issues[0].body // "") | contains("**Total AI credits:**"))
            and (($issues[0].body // "") | contains("**Active workflows:**"))
            and (($issues[0].body // "") | contains("**Reliability:**"))
         then 1 else 0 end)}]
  end
' <<<"$request"
