#!/usr/bin/env bash

set -euo pipefail

# Intent: move one owned Repo Assist pull request toward review by repairing a
# blocker caused by its changes.
# target-bound-pr-repair-request: proportion, higher is better. 1 means the
# current run requested one repair for an identified target pull request, or one
# review issue carrying the repair and validation evidence; 0 means an
# applicable run requested an invalid or off-target action; null means target
# evidence is unavailable or no owned pull request required a repair.

request=$(cat)

jq -c '
  def text: type == "string" and test("[^[:space:]]");
  def target: .event.inputs.target_repo // .event.inputs.targetRepo // .config.target_repo // null;
  def mode: .event.inputs.safe_output_mode // .config.safe_output_mode // "review";
  def safe_repo: .event.inputs.safe_output_repo // .event.inputs.safeOutputRepo // .run.repository // null;
  def type_name: .type // .kind // "" | ascii_downcase | gsub("-"; "_");
  def output_repo: .repo // .target_repo // .targetRepo // .repository // null;
  def pull_number: .pull_request_number // .pr_number // .pr // null;
  def positive_pull: pull_number as $number | ($number | type) == "number" and $number >= 1 and ($number | floor) == $number;
  def body: .body // .message // .content // "";
  def title: .title // .subject // "";
  def repository_matches($expected): output_repo == null or output_repo == $expected;
  def valid_request($target; $mode; $safe_repo):
    if $mode == "live" and type_name == "push_to_pull_request_branch" then
      repository_matches($target)
      and positive_pull
      and ((.message // "") | test("^\\[repo-assist:pr-upkeep\\] Repair PR #[0-9]+ blocker$"))
    elif $mode == "review" and type_name == "create_issue" then
      repository_matches($safe_repo)
      and (title | contains($target))
      and (title | test("PR [0-9]+ upkeep review"; "i"))
      and (body | contains("repo-assist:pr-upkeep target=" + $target + " pr="))
      and (body | test("\\*\\*Action:\\*\\*"))
      and (body | test("(?i)blocker"))
      and (body | test("(?i)validation|tests?|checks?"))
    else false end;
  if (.schemaVersion != 1)
      or (.run | type != "object")
      or (.event | type != "object")
      or (.outputs | type != "array") then
    [{"id":"target-bound-pr-repair-request","value":null}]
  elif (target | type != "string") or (target | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") | not) then
    [{"id":"target-bound-pr-repair-request","value":null}]
  else
    (target) as $target
    | (mode) as $mode
    | (safe_repo) as $safe_repo
    | [{"id":"target-bound-pr-repair-request","value":
        (if (.outputs | length) == 1 and (.outputs[0] | type_name) == "noop" then null
         elif (.outputs | length) == 1 and (.outputs[0] | valid_request($target; $mode; $safe_repo)) then 1
         else 0 end)}]
  end
' <<<"$request"