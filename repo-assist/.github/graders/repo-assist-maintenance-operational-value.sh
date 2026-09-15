#!/usr/bin/env bash

set -euo pipefail

# Intent: request one evidence-backed, low-risk repository improvement.
# decision-ready-maintenance-patch: proportion, higher is better. 1 means the
# current run requested exactly one target-bound maintenance patch with a stable
# work identity, action, rationale, and validation evidence; 0 means an
# applicable run requested an invalid or off-target action; null means target
# evidence is unavailable or no eligible improvement was established.

request=$(cat)

jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def mode: .event.inputs.safe_output_mode // .config.safe_output_mode // "review";
  def safe_repo: .event.inputs.safe_output_repo // .event.inputs.safeOutputRepo // .run.repository // null;
  def type_name: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def output_repo: .repo // .target_repo // .targetRepo // .repository // null;
  def body: .body // .message // .content // "";
  def title: .title // .subject // "";
  def repository_matches($expected): output_repo == null or output_repo == $expected;
  def decision_body($target):
    (body | text)
    and (body | contains("repo-assist:maintenance target=" + $target + " work="))
    and (body | test("\\*\\*Action:\\*\\*"))
    and (body | test("(?i)evidence|observed problem"))
    and (body | test("(?i)rationale|why"))
    and (body | test("(?i)validation|tests?|checks?|benchmark"));
  def valid_request($target; $mode; $safe_repo):
    if $mode == "live" and type_name == "create_pull_request" then
      repository_matches($target) and (title | text) and (.branch | text) and decision_body($target)
    elif $mode == "review" and type_name == "create_issue" then
      repository_matches($safe_repo)
      and (title | contains($target))
      and (title | test("maintenance [a-z0-9-]+ review"; "i"))
      and decision_body($target)
    else false end;
  if (.schemaVersion != 1)
      or (.run | type != "object")
      or (.event | type != "object")
      or (.outputs | type != "array") then
    [{"id":"decision-ready-maintenance-patch","value":null}]
  elif (target | type != "string") or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{"id":"decision-ready-maintenance-patch","value":null}]
  else
    (target) as $target
    | (mode) as $mode
    | (safe_repo) as $safe_repo
    | [{"id":"decision-ready-maintenance-patch","value":
        (if (.outputs | length) == 1 and (.outputs[0] | type_name) == "noop" then null
         elif (.outputs | length) == 1 and (.outputs[0] | valid_request($target; $mode; $safe_repo)) then 1
         else 0 end)}]
  end
' <<<"$request"