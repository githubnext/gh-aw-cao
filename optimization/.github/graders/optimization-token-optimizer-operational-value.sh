#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

definition() {
    cat <<'JSON'
{
  "schemaVersion": 4,
  "grader": "operational-value",
  "repository": "githubnext/gh-aw-cao",
  "workflowName": "AW Optimization / Token Optimizer",
  "sourcePath": ".github/workflows/optimization-token-optimizer.md",
  "operationalValue": "Lower AI Credit use for comparable accepted workflow outcomes without increasing failure rate or reducing outcome quality.",
  "evidence": {
    "opportunity": "One evidence-complete token-efficiency opportunity assigned to a target repository and workflow for a frozen comparison window and experiment.",
    "assignment": "Bind targetRepo, workflowPath, evidenceWindowStart, evidenceWindowEnd, assignmentRunId, and experimentId from the optimizer assignment; key token-opportunity:<targetRepo>:<workflowPath>:<evidenceWindowStart>:<evidenceWindowEnd>:<assignmentRunId>:<experimentId>.",
    "accepted": "Matured target-repository evidence compares the assigned experiment with its control for equivalent accepted outcomes, shows lower AIC per accepted outcome, and shows no increase in completed-run failure rate or reduction in outcome quality.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the frozen evaluator and workflow source from githubnext/gh-aw-cao. Read immutable workflow-run, experiment-assignment, accepted-outcome, and reliability evidence from the assigned target repository. Preserve each repository and run in provenance. Retain input, output, cache-read, cache-write, and reasoning tokens as separate supporting diagnostics; never combine them into an invented token total.",
    "maturation": "At the later of fourteen days after assignment or the declared experiment's minimum comparable sample size in both variants, capped by the evaluator evidence cutoff.",
    "zeroRule": "Complete comparable evidence with no AIC-per-accepted-outcome reduction, a higher completed-run failure rate, or reduced outcome quality scores 0.",
    "missingRule": "Missing assignment fields, inaccessible evidence repositories, incomplete experiment variants, unmatched workloads, no accepted outcomes, an unmet minimum sample size, or unmatured evidence scores null."
  },
  "primaryMetric": {
    "id": "verified-token-efficiency-gain",
    "formula": "clamp((baseline AIC per accepted outcome - optimized AIC per accepted outcome) / baseline AIC per accepted outcome, 0, 1) when reliability and outcome quality are preserved; otherwise 0 for complete regressions and null for incomplete or incomparable evidence",
    "direction": "higher_is_better"
  },
  "baseline": {
    "mode": "attainment-only",
    "value": null,
    "evidenceCutoff": null,
    "provenance": []
  },
  "validationExamples": {
    "targetAttained": {
      "valid": true,
      "comparableEvidence": true,
      "baselineAicPerAcceptedOutcome": 100,
      "optimizedAicPerAcceptedOutcome": 70,
      "reliabilityPreserved": true,
      "outcomeQualityPreserved": true
    },
    "targetMissed": {
      "valid": true,
      "comparableEvidence": true,
      "baselineAicPerAcceptedOutcome": 100,
      "optimizedAicPerAcceptedOutcome": 105,
      "reliabilityPreserved": true,
      "outcomeQualityPreserved": true
    },
    "missing": {
      "valid": false,
      "comparableEvidence": false,
      "baselineAicPerAcceptedOutcome": null,
      "optimizedAicPerAcceptedOutcome": null,
      "reliabilityPreserved": null,
      "outcomeQualityPreserved": null
    },
    "malformed": {
      "valid": "yes",
      "comparableEvidence": true,
      "baselineAicPerAcceptedOutcome": 100,
      "optimizedAicPerAcceptedOutcome": 70,
      "reliabilityPreserved": true,
      "outcomeQualityPreserved": true
    }
  }
}
JSON
}

metric() {
    jq '
      if .valid != true
          or .comparableEvidence != true
          or (.baselineAicPerAcceptedOutcome | type) != "number"
          or (.optimizedAicPerAcceptedOutcome | type) != "number"
          or (.reliabilityPreserved | type) != "boolean"
          or (.outcomeQualityPreserved | type) != "boolean"
        then null
      elif .baselineAicPerAcceptedOutcome <= 0
        then null
      elif (.reliabilityPreserved | not) or (.outcomeQualityPreserved | not)
        then 0
      else
        ((.baselineAicPerAcceptedOutcome - .optimizedAicPerAcceptedOutcome)
          / .baselineAicPerAcceptedOutcome) as $gain
        | if $gain <= 0 then 0
          elif $gain >= 1 then 1
          else $gain
          end
      end
    '
}

case ${1:-} in
    --definition) [[ $# -eq 1 ]] || exit 2; definition ;;
    --metric) [[ $# -eq 1 ]] || exit 2; metric ;;
    *) printf 'usage: %s --definition|--metric\n' "$0" >&2; exit 2 ;;
esac
