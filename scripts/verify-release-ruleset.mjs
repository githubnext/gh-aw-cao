import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const recommendedRuleset = JSON.parse(readFileSync(new URL("../.github/rulesets/release-controls.json", import.meta.url), "utf8"));

export function verifyReleaseRuleset(actual) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  require(actual.target === "branch" && actual.enforcement === "active", "Ruleset must actively enforce branch rules");
  require(Array.isArray(actual.bypass_actors) && actual.bypass_actors.length === 0, "Bypass actors must be visible and empty");
  require(JSON.stringify(actual.conditions?.ref_name?.include) === '["~DEFAULT_BRANCH"]'
    && Array.isArray(actual.conditions?.ref_name?.exclude) && actual.conditions.ref_name.exclude.length === 0,
    "Ruleset must include only the default branch with no exclusions");
  const rules = new Map((actual.rules ?? []).map((rule) => [rule.type, rule.parameters ?? {}]));
  for (const type of ["deletion", "non_fast_forward"]) require(rules.has(type), `Missing ${type} protection`);
  const review = rules.get("pull_request") ?? {};
  require(Number.isInteger(review.required_approving_review_count) && review.required_approving_review_count >= 1,
    "At least one independent approving review is required");
  for (const field of ["dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"]) {
    require(review[field] === true, `Missing review gate: ${field}`);
  }
  const checks = rules.get("required_status_checks") ?? {};
  require(checks.strict_required_status_checks_policy === true, "Required checks must use the latest base branch");
  require(checks.do_not_enforce_on_create === false, "Required checks must apply when creating the branch");
  const recommended = recommendedRuleset.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks;
  for (const expected of recommended) {
    require(checks.required_status_checks?.some((check) =>
      check.context === expected.context && check.integration_id === expected.integration_id),
    `Missing GitHub Actions required check: ${expected.context}`);
  }
  for (const check of checks.required_status_checks ?? []) {
    require(recommended.some((expected) => check.context === expected.context && check.integration_id === expected.integration_id),
      `Unverified required check (may be path-filtered): ${check.context}`);
  }
  const scanner = rules.get("code_scanning")?.code_scanning_tools?.find((tool) => tool.tool === "CodeQL");
  require(["errors", "errors_and_warnings", "all"].includes(scanner?.alerts_threshold), "CodeQL error alerts must block merging");
  require(["high_or_higher", "medium_or_higher", "all"].includes(scanner?.security_alerts_threshold), "CodeQL high and critical security alerts must block merging");
  return failures;
}

export function readRuleset(repository, id) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || !/^[1-9][0-9]*$/.test(id)) {
    throw new Error("Usage: node scripts/verify-release-ruleset.mjs OWNER/REPO RULESET_ID");
  }
  return JSON.parse(execFileSync("gh", ["api", "--method", "GET", `repos/${repository}/rulesets/${id}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [repository, id, extra] = process.argv.slice(2);
    if (extra) throw new Error("Unexpected arguments; this tool only reads one ruleset");
    const actual = readRuleset(repository ?? "", id ?? "");
    const failures = verifyReleaseRuleset(actual);
    console.log(JSON.stringify({
      repository, rulesetId: actual.id, checkedAt: new Date().toISOString(),
      matchesRecommendation: failures.length === 0, failures,
    }, null, 2));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
