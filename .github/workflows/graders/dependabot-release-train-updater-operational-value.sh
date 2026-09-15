#!/usr/bin/env bash

set -euo pipefail

# Intent: create or refresh one agent-ready Dependabot plan issue for the
# dispatched target repository, or explicitly report that no work exists.
# agent-ready-dependency-plan: proportion, higher is better. 1 means the current
# run requested one valid target-bound issue outcome sequence; 0 means an
# applicable run requested no such outcome or an invalid outcome; null means the
# run or target is unavailable.

request=$(cat)

jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def target:
    .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def body: .body // .message // .content // "";
  def title: .title // .subject // "";
  def type_name: .type // .kind // "" | ascii_downcase | gsub("_"; "-");
  def target_repo: .target_repo // .targetRepo // .repository // .repo // null;
  def issue_ref: .issue_number // .issueNumber // .number // .target // null;
  def target_matches($target):
    (target_repo == null) or (target_repo == $target);
  def plan_body:
    (body | text)
    and (body | test("\\*\\*Action:\\*\\*"))
    and (body | test("### Update checklist"))
    and (body | test("- \\[ \\]"))
    and (body | test("<summary><b>Agent prompt</b></summary>"));
  def valid_create($target):
    type_name == "create-issue"
    and (title == "Dependency update plan for \($target)")
    and plan_body
    and target_matches($target);
  def valid_refresh($target; $comment):
    (issue_ref) as $issue
    |
    type_name == "update-issue"
    and (plan_body or (body | test("\\*\\*Action:\\*\\* None\\.")))
    and target_matches($target)
    and ($comment | type_name == "add-comment")
    and ($comment | target_matches($target))
    and ($comment | body | startswith("Dependabot update plan refreshed."))
    and ($issue != null)
    and ($comment | issue_ref == $issue);
  if (.schemaVersion != 1)
      or (.run | type != "object")
      or (.event | type != "object")
      or (.outputs | type != "array") then
    [{"id":"agent-ready-dependency-plan","value":null}]
  elif (target | type != "string") or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{"id":"agent-ready-dependency-plan","value":null}]
  else
    (target) as $target
    | [{"id":"agent-ready-dependency-plan","value":
        (if (.outputs | length) == 1
             and ((.outputs[0] | type_name) == "noop")
             and (.outputs[0] | body | text) then 1
         elif (.outputs | length) == 1 and (.outputs[0] | valid_create($target)) then 1
         elif (.outputs | length) == 2
             and ((.outputs[1]) as $comment
                  | (.outputs[0] | valid_refresh($target; $comment))) then 1
         else 0 end)}]
  end
' <<<"$request"