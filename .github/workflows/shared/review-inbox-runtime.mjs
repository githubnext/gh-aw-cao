import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { findingTypes, normalizeFinding, publishInbox, validateHandoff } from "./review-inbox.mjs";

export function validateFindings(items, scope, limits) {
  if (!limits || Array.isArray(limits) || typeof limits !== "object") throw new Error("Review inbox: invalid declared limits");
  const counts = new Map();
  for (const item of items.filter((candidate) => findingTypes.has(candidate.type))) {
    const count = (counts.get(item.type) ?? 0) + 1;
    counts.set(item.type, count);
    if (!Number.isSafeInteger(limits[item.type]) || count > limits[item.type] || limits[item.type] < 1) {
      throw new Error(`Review inbox: undeclared or excessive ${item.type} findings`);
    }
    if (item.repo && ![scope.target.toLowerCase(), scope.destination.toLowerCase()].includes(String(item.repo).toLowerCase())) {
      throw new Error("Review inbox: finding repository outside the dispatched scope");
    }
    normalizeFinding(item, scope);
  }
}

export function runtimeScope(env = process.env) {
  return {
    campaign: env.CAO_CAMPAIGN ?? "", worker: env.CAO_WORKER ?? "", target: env.CAO_TARGET_REPOSITORY ?? "",
    destination: env.CAO_SAFE_OUTPUT_REPOSITORY ?? "", control: env.GITHUB_REPOSITORY ?? "",
    sha: env.GITHUB_WORKFLOW_SHA ?? "", workflow: env.GITHUB_WORKFLOW_REF?.match(/\/([^/]+)\.lock\.yml@/)?.[1] ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

export async function runInbox({ github, core }, operation, env = process.env, paths = {}) {
  if (env.CAO_ROLE !== "worker" || env.CAO_MODE !== "review") return;
  const scope = runtimeScope(env);
  const handoff = JSON.parse(readFileSync(paths.handoff ?? "/tmp/gh-aw/agent/control-precompute.json", "utf8"));
  validateHandoff(handoff, scope);
  const outputPath = env.GH_AW_AGENT_OUTPUT;
  if (!outputPath) throw new Error("Review inbox: original agent output path missing");
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  if (!Array.isArray(output.items) || output.items.some((item) => !item || typeof item.type !== "string")) {
    throw new Error("Review inbox: missing or invalid original agent output");
  }
  validateFindings(output.items, scope, JSON.parse(env.CAO_REVIEW_FINDING_LIMITS ?? "null"));
  if (operation === "intercept") {
    // The publisher restores the ORIGINAL immutable artifact, never this local
    // filtered copy. Built-in dispatch, bundle jobs and live handlers are intact.
    const retained = output.items.filter((item) => !findingTypes.has(item.type));
    const digest = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
    writeFileSync(paths.ready ?? "/tmp/gh-aw/review-inbox-ready.json", JSON.stringify({
      scope, digest, staged: env.GH_AW_SAFE_OUTPUTS_STAGED === "true",
    }));
    writeFileSync(outputPath, JSON.stringify({ ...output, items: retained }));
    core.setOutput("review_inbox_ready", "true");
    core.setOutput("review_inbox_staged", env.GH_AW_SAFE_OUTPUTS_STAGED === "true" ? "true" : "false");
    return;
  }
  if (operation !== "publish") throw new Error("Unknown review inbox operation");
  const ready = JSON.parse(readFileSync(paths.ready ?? "/tmp/gh-aw/review-inbox-ready.json", "utf8"));
  const digest = createHash("sha256").update(readFileSync(outputPath)).digest("hex");
  if (JSON.stringify(ready.scope) !== JSON.stringify(scope) || ready.digest !== digest || typeof ready.staged !== "boolean") {
    throw new Error("Review inbox: publisher prerequisite or original artifact mismatch");
  }
  // Repeat destination access validation using the existing write credential.
  const [owner, repo] = scope.destination.split("/");
  const destination = (await github.rest.repos.get({ owner, repo })).data;
  if (scope.destination.toLowerCase() !== scope.control.toLowerCase() && destination.private !== true) {
    throw new Error("Review inbox: non-central destination must be private");
  }
  const result = await publishInbox(github, scope, output.items, {
    staged: ready.staged,
  });
  await core.summary.addHeading("CAO review inbox", 2).addRaw(JSON.stringify(result)).write();
}
