#!/usr/bin/env bash

set -euo pipefail

# Intent: request one reviewable dependency update or one decision-ready fallback
# for the dispatched target repository, or explicitly decline unsafe work.
# decision-ready-dependency-action: proportion, higher is better. 1 means the
# current run requested exactly one supported, target-bound outcome with the
# required decision fields; 0 means an applicable run requested no such outcome
# or requested an invalid outcome; null means the run or target is unavailable.

request=$(cat)

jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def target:
    .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def body: .body // .message // .content // "";
  def title: .title // .subject // "";
  def type_name: .type // .kind // "" | ascii_downcase | gsub("_"; "-");
  def target_repo: .target_repo // .targetRepo // .repository // .repo // null;
  def target_matches($target):
    (target_repo == null) or (target_repo == $target);
  def decision_body:
    (body | text)
    and (body | test("\\*\\*Action:\\*\\*"))
    and (body | test("(?i)(validation|checks?|results?|limitations?)"));
  def valid_action($target):
    (type_name) as $type
    | if $type == "noop" then
        (body | text)
      elif ($type == "create-pull-request" or $type == "create-issue") then
        (title | text) and decision_body and target_matches($target)
      elif ($type == "add-comment" or $type == "create-pull-request-comment" or $type == "create-issue-comment") then
        decision_body and target_matches($target)
      else false end;
  if (.schemaVersion != 1)
      or (.run | type != "object")
      or (.event | type != "object")
      or (.outputs | type != "array") then
    [{"id":"decision-ready-dependency-action","value":null}]
  elif (target | type != "string") or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{"id":"decision-ready-dependency-action","value":null}]
  else
    (target) as $target
    | [{"id":"decision-ready-dependency-action","value":
        (if (.outputs | length) == 1 and (.outputs[0] | valid_action($target)) then 1 else 0 end)}]
  end
' <<<"$request"