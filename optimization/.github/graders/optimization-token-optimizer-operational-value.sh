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
  "operationalValue": "Produce net AI Credit savings after attributable optimization overhead for a recommendation that is applied and preserves comparable workflow reliability and outcome quality.",
  "evidence": {
    "opportunity": "One evidence-complete token-efficiency opportunity assigned to a target repository and workflow for a frozen comparison window and experiment.",
    "assignment": "Bind targetRepo, workflowPath, evidenceWindowStart, evidenceWindowEnd, assignmentRunId, and experimentId from the optimizer assignment; key token-opportunity:<targetRepo>:<workflowPath>:<evidenceWindowStart>:<evidenceWindowEnd>:<assignmentRunId>:<experimentId>.",
    "accepted": "The recommendation has an authoritative applied disposition and a completed implementation, and matured target-repository evidence compares its experiment with the control for equivalent accepted outcomes, shows positive savings after attributable optimization overhead, and shows no increase in completed-run failure rate or reduction in outcome quality. Superseded, outdated, duplicate, unapplied, failed-start, and rejected recommendations are not accepted outcomes.",
    "repositories": ["githubnext/gh-aw-cao"],
    "collection": "Read the frozen evaluator and workflow source, recommendation disposition, implementation evidence, and distinct AIC for optimizer-family runs attributable to this frozen opportunity and intervention lineage from githubnext/gh-aw-cao. Read immutable workflow-run, experiment-assignment, accepted-target-outcome, and reliability evidence from the assigned target repository. Preserve each repository and run in provenance. Retain input, output, cache-read, cache-write, and reasoning tokens as separate supporting diagnostics; never combine them into an invented token total or charge unrelated portfolio work to this intervention.",
    "maturation": "At the later of fourteen days after assignment or the declared experiment's minimum comparable sample size in both variants, capped by the evaluator evidence cutoff.",
    "zeroRule": "Complete evidence with no AIC-per-accepted-target-outcome reduction, non-positive net savings after attributable optimization overhead, a higher completed-run failure rate, reduced outcome quality, or a superseded, outdated, duplicate, unapplied, failed-start, or rejected recommendation scores 0.",
    "missingRule": "Missing assignment fields, recommendation disposition, implementation evidence, attributable optimization-overhead AIC, inaccessible evidence repositories, incomplete experiment variants, unmatched workloads, no accepted target outcomes, an unmet minimum sample size, or unmatured evidence scores null."
  },
  "primaryMetric": {
    "id": "verified-net-token-efficiency-gain",
    "formula": "clamp((((baseline AIC per accepted target outcome - optimized AIC per accepted target outcome) * optimized accepted target outcome count) - attributable optimization overhead AIC) / (baseline AIC per accepted target outcome * optimized accepted target outcome count), 0, 1) when the recommendation is applied, implementation completed, and reliability and outcome quality are preserved; otherwise 0 for complete non-accepted recommendations or regressions and null for incomplete or incomparable evidence",
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
      "optimizedAcceptedOutcomeCount": 1,
      "optimizationOverheadAic": 5,
      "recommendationDisposition": "applied",
      "implementationCompleted": true,
      "reliabilityPreserved": true,
      "outcomeQualityPreserved": true
    },
    "targetMissed": {
      "valid": true,
      "comparableEvidence": true,
      "baselineAicPerAcceptedOutcome": 100,
      "optimizedAicPerAcceptedOutcome": 105,
      "optimizedAcceptedOutcomeCount": 1,
      "optimizationOverheadAic": 5,
      "recommendationDisposition": "applied",
      "implementationCompleted": true,
      "reliabilityPreserved": true,
      "outcomeQualityPreserved": true
    },
    "missing": {
      "valid": false,
      "comparableEvidence": false,
      "baselineAicPerAcceptedOutcome": null,
      "optimizedAicPerAcceptedOutcome": null,
      "optimizedAcceptedOutcomeCount": null,
      "optimizationOverheadAic": null,
      "recommendationDisposition": null,
      "implementationCompleted": null,
      "reliabilityPreserved": null,
      "outcomeQualityPreserved": null
    },
    "malformed": {
      "valid": "yes",
      "comparableEvidence": true,
      "baselineAicPerAcceptedOutcome": 100,
      "optimizedAicPerAcceptedOutcome": 70,
      "optimizedAcceptedOutcomeCount": 1,
      "optimizationOverheadAic": 5,
      "recommendationDisposition": "applied",
      "implementationCompleted": true,
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
          or (.optimizedAcceptedOutcomeCount | type) != "number"
          or (.optimizationOverheadAic | type) != "number"
          or (.recommendationDisposition | type) != "string"
          or (.implementationCompleted | type) != "boolean"
          or (.reliabilityPreserved | type) != "boolean"
          or (.outcomeQualityPreserved | type) != "boolean"
        then null
      elif .baselineAicPerAcceptedOutcome <= 0
          or .optimizedAicPerAcceptedOutcome < 0
          or .optimizedAcceptedOutcomeCount <= 0
          or .optimizationOverheadAic < 0
        then null
      elif (.recommendationDisposition
          | IN("applied", "superseded", "outdated", "duplicate", "unapplied", "failed-start", "rejected")
          | not)
        then null
      elif .recommendationDisposition != "applied"
          or (.implementationCompleted | not)
        then 0
      elif (.reliabilityPreserved | not) or (.outcomeQualityPreserved | not)
        then 0
      else
        (.optimizedAcceptedOutcomeCount) as $acceptedOutcomeCount
        | ([.baselineAicPerAcceptedOutcome - .optimizedAicPerAcceptedOutcome, 0]
          | max
          * $acceptedOutcomeCount) as $grossSavings
        | (.baselineAicPerAcceptedOutcome
          * .optimizedAcceptedOutcomeCount) as $counterfactualAic
        | (($grossSavings - .optimizationOverheadAic)
          / $counterfactualAic) as $gain
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
