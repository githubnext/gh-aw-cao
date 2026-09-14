/**
 * Shared run-conclusion and package AI Credit utilization classification,
 * driven by JSON configuration so status rules stay data-driven rather than
 * duplicated as hardcoded literals across the overview and packages views.
 */

import runConclusionClassification from './run-conclusion-classification.json' with { type: 'json' };
import packageAicUtilizationThresholds from './package-aic-utilization-thresholds.json' with { type: 'json' };

const FAILURE_CONCLUSIONS = new Set(runConclusionClassification.failure ?? []);
const APPROVAL_CONCLUSIONS = new Set(runConclusionClassification.approval ?? []);

/**
 * @param {unknown} conclusion
 * @returns {boolean}
 */
export function isFailureConclusion(conclusion) {
  return FAILURE_CONCLUSIONS.has(String(conclusion));
}

/**
 * @param {unknown} conclusion
 * @returns {boolean}
 */
export function isApprovalConclusion(conclusion) {
  return APPROVAL_CONCLUSIONS.has(String(conclusion));
}

/**
 * Classifies an AI Credit utilization ratio (used / allowance) into a status
 * using the ascending `max` thresholds in package-aic-utilization-thresholds.json.
 * The first rule whose `max` the ratio is below wins; a rule without `max`
 * acts as the fallback for anything above the highest threshold.
 * @param {number} ratio
 * @returns {string}
 */
export function classifyUtilizationRatio(ratio) {
  for (const rule of packageAicUtilizationThresholds) {
    if (typeof rule.max !== 'number' || ratio < rule.max) {
      return rule.status;
    }
  }
  const lastRule = packageAicUtilizationThresholds[packageAicUtilizationThresholds.length - 1];
  if (!lastRule) {
    throw new Error('package-aic-utilization-thresholds.json must define at least one rule.');
  }
  // Reachable only if every rule (including the last) declares a numeric `max`, which is a
  // misconfiguration: the last rule is expected to be an unbounded fallback with no `max`.
  return lastRule.status;
}
