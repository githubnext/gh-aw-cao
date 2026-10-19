import assert from "node:assert/strict";
import { parseDocument } from "yaml";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uniqueRun = /\$\{\{\s*github\.run_id\s*\}\}/g;
const stableContext = /^(?:runner\.(?:os|arch)|github\.(?:workflow|repository|ref|job))$/;

function yaml(text) {
  assert.equal(typeof text, "string", "Native YAML source must be text");
  const document = parseDocument(text, { uniqueKeys: true, version: "1.2" });
  assert.equal(document.errors.length, 0, "Invalid native YAML");
  const value = document.toJS({ maxAliasCount: 0 });
  assert.ok(record(value), "Native YAML must be a mapping");
  return value;
}

export function cacheStrategyFacts(source, compiled) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, "Missing workflow frontmatter");
  const config = yaml(frontmatter[1]);
  const declared = config.tools?.["cache-memory"];
  if (declared !== true && !record(declared)) return { eligible: false, restorations: [] };
  const workflow = yaml(compiled);
  assert.ok(record(workflow.jobs), "Missing compiled jobs");
  const restorations = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    assert.ok(record(job), "Invalid compiled job");
    if (job.steps === undefined) continue;
    assert.ok(Array.isArray(job.steps), "Invalid compiled steps");
    const identities = new Set();
    for (const step of job.steps) {
      assert.ok(record(step), "Invalid compiled step");
      if (typeof step.uses !== "string" || !step.uses.startsWith("actions/cache/restore@")) continue;
      assert.match(step.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/, "Unpinned cache action");
      assert.ok(record(step.with), "Missing cache action inputs");
      if (typeof step.with.path !== "string") continue;
      const paths = step.with.path.split(/\r?\n/).map(value => value.trim().replace(/\/$/, "")).filter(Boolean);
      if (paths.length !== 1 || paths[0] !== "/tmp/gh-aw/cache-memory") continue;
      const identity = step.id ?? step.name;
      assert.ok(typeof identity === "string" && identity.length > 0, "Missing restoration identity");
      assert.equal(identities.has(identity), false, "Ambiguous restoration identity");
      identities.add(identity);
      assert.equal(typeof step.with.key, "string", "Invalid cache key");
      const context = structuredClone(job);
      delete context.steps;
      restorations.push({ job: jobId, identity, action: step.uses, path: paths[0],
        key: step.with.key, step: structuredClone(step), context,
        workflowContext: Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== "jobs")) });
    }
  }
  return { eligible: true, restorations };
}

function prefixFor(key) {
  const tokens = [...key.matchAll(uniqueRun)];
  if (tokens.length !== 1 || tokens[0].index === 0) return null;
  const prefix = key.slice(0, tokens[0].index);
  let supported = true;
  const literal = prefix.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => {
    if (!stableContext.test(expression.trim())) supported = false;
    return "";
  });
  if (!supported || literal.includes("${{") || !literal.trim() || /[\r\n]/.test(key)) return null;
  return prefix;
}

function fallbacks(step) {
  const value = step.with["restore-keys"];
  if (value === undefined || value === null || value === "") return [];
  assert.equal(typeof value, "string", "Invalid restore-key list");
  return value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export function cacheFallbackRepairs(before, after, supportedActions) {
  assert.ok(Array.isArray(supportedActions) && supportedActions.every(value => /^actions\/cache\/restore@[a-f0-9]{40}$/.test(value)),
    "Missing independently reviewed action implementation identities");
  if (!before.eligible || !after.eligible) return { accepted: [], rejected: [], applicable: false };
  const accepted = [], rejected = [];
  for (const old of before.restorations) {
    const next = after.restorations.find(row => row.job === old.job && row.identity === old.identity);
    if (!next) continue;
    const identity = `${old.job}:${old.identity}`;
    const prefix = prefixFor(old.key);
    let reason;
    if (!supportedActions.includes(old.action) || next.action !== old.action) reason = "unsupported-or-changed-action";
    else if (fallbacks(old.step).length) reason = "already-has-fallback";
    else if (!prefix) reason = "unsupported-or-nonunique-run-key";
    else if (!fallbacks(next.step).includes(prefix)) reason = "missing-exact-stable-prefix-fallback";
    else {
      const oldStep = structuredClone(old.step), newStep = structuredClone(next.step);
      delete oldStep.with["restore-keys"];
      delete newStep.with["restore-keys"];
      try {
        assert.deepEqual(oldStep, newStep);
        assert.deepEqual(old.context, next.context);
        assert.deepEqual(old.workflowContext, next.workflowContext);
      } catch (error) {
        if (error.code !== "ERR_ASSERTION") throw error;
        reason = "other-restoration-or-execution-context-changes";
      }
    }
    if (reason) rejected.push({ identity, reason });
    else accepted.push({ identity, action: old.action, key: old.key, restorePrefix: prefix, path: old.path });
  }
  assert.equal(new Set(accepted.map(row => row.identity)).size, accepted.length);
  return { accepted, rejected, applicable: true };
}
