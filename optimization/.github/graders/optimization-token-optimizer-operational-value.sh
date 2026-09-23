#!/usr/bin/env bash

# Workflow intent: reduce avoidable AI Credit or token use for one agentic
# workflow while preserving reliability and accepted outcome quality.
# actionable-optimization-recommendation is a proportion where 1 means the
# current run requested one target- and workflow-bound recommendation with a
# measured baseline, proposed change, safeguards, validation, and agent prompt;
# 0 means a contradictory durable output; null means target or grading evidence
# is unavailable, or the run correctly emitted only a noop.

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
    [{id:"actionable-optimization-recommendation",value:null}]
  elif (target | type) != "string" or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{id:"actionable-optimization-recommendation",value:null}]
  elif (.outputs | length) == 1 and (.outputs[0] | kind) == "noop" then
    [{id:"actionable-optimization-recommendation",value:null}]
  else
    target as $target
    | [.outputs[] | select(durable)] as $issues
    | [{id:"actionable-optimization-recommendation",value:
        (if ($issues | length) == 1
            and (($issues[0].title // "") | contains("Optimize .github/workflows/"))
            and (($issues[0].title // "") | contains(" in " + $target))
            and (($issues[0].body // "") | contains($target))
            and (($issues[0].body // "") | contains("**Action:**"))
            and (($issues[0].body // "") | test("(?i)measured baseline"))
            and (($issues[0].body // "") | test("(?i)proposed change"))
            and (($issues[0].body // "") | test("(?i)reliability"))
            and (($issues[0].body // "") | test("(?i)accepted outcome"))
            and (($issues[0].body // "") | test("(?i)validation"))
            and (($issues[0].body // "") | contains("<details><summary><b>Agent prompt</b></summary>"))
         then 1 else 0 end)}]
  end
' <<<"$request"
