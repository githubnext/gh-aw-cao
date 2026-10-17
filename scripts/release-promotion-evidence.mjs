import { createHash } from "node:crypto";

export const promotionEnvironment = "release-latest";
export const codeqlCategories = ["/language:actions", "/language:go", "/language:javascript-typescript", "/language:python"];
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function repositoryApi(request, repository) {
  requireCondition(/^[\w.-]+\/[\w.-]+$/.test(repository), "An explicit OWNER/REPO is required");
  return async (path, parameters = {}) => (await request(`GET /repos/${repository}${path ? `/${path}` : ""}`, parameters)).data;
}

export async function readPromotionEnvironment(get, branch) {
  const environment = await get(`environments/${promotionEnvironment}`);
  const reviewers = environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
  requireCondition(environment.name === promotionEnvironment && Number.isSafeInteger(environment.id) && environment.id > 0,
    "Promotion environment identity is unavailable");
  requireCondition(environment.can_admins_bypass === false, "Promotion environment must disable administrator bypass");
  requireCondition(reviewers?.prevent_self_review === true && reviewers.reviewers?.length > 0,
    "Promotion environment must require reviewers and prevent self-review");
  requireCondition(environment.deployment_branch_policy?.custom_branch_policies === true
    && environment.deployment_branch_policy.protected_branches === false,
  "Promotion environment must select only the default branch");
  const policy = await get(`environments/${promotionEnvironment}/deployment-branch-policies`, { per_page: 100 });
  requireCondition(policy.total_count === 1 && policy.branch_policies?.length === 1
    && policy.branch_policies[0].name === branch && policy.branch_policies[0].type === "branch",
  "Promotion environment must allow exactly the default branch, not tags or wildcard refs");
  return {
    id: environment.id, name: environment.name, can_admins_bypass: environment.can_admins_bypass,
    protection_rules: environment.protection_rules, deployment_branch_policy: policy.branch_policies,
  };
}

export async function readCodeqlEvidence(get, revision, branch) {
  const selected = new Map();
  for (let page = 1; page <= 10 && selected.size < codeqlCategories.length; page++) {
    const analyses = await get("code-scanning/analyses", {
      ref: `refs/heads/${branch}`, tool_name: "CodeQL", sort: "created", direction: "desc", per_page: 100, page,
    });
    requireCondition(Array.isArray(analyses), "CodeQL analysis inventory is invalid");
    for (const analysis of analyses) {
      if (analysis.commit_sha === revision && analysis.ref === `refs/heads/${branch}`
        && analysis.tool?.name === "CodeQL" && codeqlCategories.includes(analysis.category)
        && !selected.has(analysis.category)) selected.set(analysis.category, analysis);
    }
    if (analyses.length < 100) break;
  }
  const evidence = [];
  for (const category of codeqlCategories) {
    const analysis = selected.get(category);
    requireCondition(analysis && analysis.error === "" && Number.isSafeInteger(analysis.id) && analysis.id > 0
      && Number.isSafeInteger(analysis.results_count) && analysis.results_count >= 0,
    `Missing or failed exact-SHA CodeQL analysis: ${category}`);
    const sarif = await get(`code-scanning/analyses/${analysis.id}`, { headers: { accept: "application/sarif+json" } });
    requireCondition(sarif.version === "2.1.0" && Array.isArray(sarif.runs) && sarif.runs.length > 0,
      "CodeQL SARIF evidence is unavailable");
    let count = 0;
    for (const run of sarif.runs) {
      requireCondition(run.tool?.driver?.name === "CodeQL" && Array.isArray(run.results), "Invalid CodeQL SARIF run");
      for (const result of run.results) {
        count++;
        const number = result.properties?.["github/alertNumber"];
        requireCondition(Number.isSafeInteger(number) && number > 0, "CodeQL result is missing its alert identity");
        const alert = await get(`code-scanning/alerts/${number}`);
        requireCondition(alert.tool?.name === "CodeQL" && alert.rule?.id === result.ruleId,
          "CodeQL result and alert identity disagree");
        requireCondition(["note", "warning", "error"].includes(alert.rule.severity)
          && ["none", "note", "warning", "error"].includes(result.level), "CodeQL alert severity is unavailable");
        const severity = alert.rule.security_severity_level;
        requireCondition(severity === null || ["low", "medium", "high", "critical"].includes(severity),
          "CodeQL security severity is unavailable");
        requireCondition(!["high", "critical"].includes(severity) && alert.rule.severity !== "error"
          && result.level !== "error", `CodeQL alert ${number} blocks release promotion`);
      }
    }
    requireCondition(count === analysis.results_count, "CodeQL SARIF result count is incomplete");
    evidence.push({ category, id: analysis.id, revision, sarifDigest: digest(sarif), results: count });
  }
  return evidence;
}
