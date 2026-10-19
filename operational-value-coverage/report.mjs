import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { validateReportCompleteness } from "../.github/skills/add-operational-value/scripts/report-completeness.mjs";
import { localFile, readInventory, validatePlan, workKey } from "./coverage.mjs";

export { reportingChecklist } from "../.github/skills/add-operational-value/scripts/report-completeness.mjs";

export function validateReport(root, plan, contract, manifest) {
  return validateReportCompleteness(root, {
    key: workKey(plan, contract), repository: plan.repository, workflow: contract.id,
    contractSha256: contract.sha256, until: plan.until, sourcePath: `.github/workflows/${contract.id}.md`,
  }, manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, planFile, workflow, manifestFile, ...extra] = process.argv.slice(2);
  assert.ok(root && planFile && workflow && manifestFile && !extra.length,
    "usage: report.mjs ROOT PLAN WORKFLOW MANIFEST");
  const plan = readJsonArchive(localFile(root, planFile));
  validatePlan(root, plan, readInventory(root, plan.portfolioPath));
  const contract = plan.cohorts.flatMap(cohort => cohort.workflows).find(item => item.id === workflow);
  assert.ok(contract, "Workflow is not assigned");
  console.log(JSON.stringify(validateReport(root, plan, contract, readJsonArchive(localFile(root, manifestFile))), null, 2));
}
