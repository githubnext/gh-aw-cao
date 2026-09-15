#!/usr/bin/env bash

set -euo pipefail

# Intent: advance one target issue with bounded, evidence-backed triage.
# bounded-issue-triage-request: proportion, higher is better. 1 means every
# current-run request is an allowed triage action, all item actions bind to one
# issue, and review guidance carries decision evidence; 0 means an applicable
# run requested inconsistent or off-target work; null means the target is
# unavailable or the run explicitly reported no eligible triage opportunity.

request=$(cat)

jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def mode: .event.inputs.safe_output_mode // .config.safe_output_mode // "review";
  def safe_repo: .event.inputs.safe_output_repo // .event.inputs.safeOutputRepo // .run.repository // null;
  def type_name: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def output_repo: .repo // .target_repo // .targetRepo // .repository // null;
  def item_number: .item_number // .issue_number // .number // null;
  def positive_item: item_number as $number | ($number | type) == "number" and $number >= 1 and ($number | floor) == $number;
  def body: .body // .message // .content // "";
  def title: .title // .subject // "";
  def repository_matches($expected): output_repo == null or output_repo == $expected;
  def allowed_label:
    (if type == "string" then . elif type == "object" then .name // "" else "" end) as $name
    | ["bug","enhancement","help wanted","good first issue","spam","off topic","documentation","question","duplicate","wontfix","needs triage","needs investigation","breaking change","performance","security","refactor"]
    | index($name) != null;
  def valid_live_action($target):
    if type_name == "add_comment" then
      repository_matches($target) and positive_item and (body | startswith("🤖 *This is an automated response from Repo Assist.*"))
    elif type_name == "add_labels" or type_name == "remove_labels" then
      repository_matches($target) and positive_item
      and (.labels | type == "array" and length > 0 and all(.[]; allowed_label))
    else false end;
  def valid_review($target; $safe_repo):
    type_name == "create_issue"
    and repository_matches($safe_repo)
    and (title | contains($target))
    and (title | test("issue [0-9]+ triage guidance"; "i"))
    and (body | text)
    and (body | test("\\*\\*Action:\\*\\*"))
    and (body | test("(?i)evidence|confidence|observed"));
  if (.schemaVersion != 1)
      or (.run | type != "object")
      or (.event | type != "object")
      or (.outputs | type != "array") then
    [{"id":"bounded-issue-triage-request","value":null}]
  elif (target | type != "string") or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{"id":"bounded-issue-triage-request","value":null}]
  else
    (target) as $target
    | (mode) as $mode
    | (safe_repo) as $safe_repo
    | [{"id":"bounded-issue-triage-request","value":
        (if (.outputs | length) == 1 and (.outputs[0] | type_name) == "noop" then null
         elif $mode == "review" then
           (if (.outputs | length) == 1 and (.outputs[0] | valid_review($target; $safe_repo)) then 1 else 0 end)
         elif $mode == "live" then
           ([.outputs[] | select(type_name != "noop") | item_number] | unique) as $items
           | if (.outputs | length) >= 1 and (.outputs | length) <= 3
               and ($items | length) == 1
               and all(.outputs[]; valid_live_action($target))
             then 1 else 0 end
         else 0 end)}]
  end
' <<<"$request"