#!/usr/bin/env bash

# Measures whether the current run requested a target-bound AI Credit audit
# containing the required summary evidence. Ratio, higher is better: 1
# conforming, 0 contradictory, null when the assignment is unavailable.

set -euo pipefail
export LC_ALL=C

[[ $# -eq 0 ]] || exit 2
request=$(cat)
jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def kind: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  if .schemaVersion != 1 or (.run | type) != "object" or (.event | type) != "object"
      or (.outputs | type) != "array" or (.config | type) != "object" then
    [{id:"ai-credit-audit-request-conformance",value:null}]
  elif (target | type) != "string" or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{id:"ai-credit-audit-request-conformance",value:null}]
  else
    target as $target
    | [.outputs[] | select(kind == "create_issue")] as $issues
    | [{id:"ai-credit-audit-request-conformance",value:
        (if ($issues | length) == 1
            and (($issues[0].title // "") | text)
            and (($issues[0].body // "") | contains($target))
            and (($issues[0].body // "") | contains("**Period**"))
            and (($issues[0].body // "") | contains("**Total runs**"))
            and (($issues[0].body // "") | contains("**Total AI credits**"))
            and (($issues[0].body // "") | contains("**Active workflows**"))
         then 1 else 0 end)}]
  end
' <<<"$request"