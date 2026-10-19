import { HostLogEvidenceGap, parseExperimentAssignmentLog, readProtectedHostLog } from "./protected-host-log.mjs";

export function readProtectedExperimentJobLog(archive, jobName, policy, selector) {
  const { text, ...receipt } = readProtectedHostLog(archive, jobName);
  if (receipt.hostEntry.match(/^\d+_(.+)\.txt$/)?.[1] !== jobName) {
    throw new HostLogEvidenceGap("No unique root-level protected producer-job log.");
  }
  return { ...parseExperimentAssignmentLog(text, policy.name, selector, policy.variants), ...receipt,
    logLayout: "protected-job-step-interval" };
}
