import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root } from "./workflow-contract.helpers.mjs";

const dataSpec = readFileSync(join(root, "specs", "dashboard-data.md"), "utf8");
const mappingSpec = readFileSync(join(root, "specs", "dashboard-gh-aw-jsonl-mapping.md"), "utf8");
const languageSpec = readFileSync(join(root, "docs", "dashboard-language-specification.md"), "utf8");

test("token data contract covers the frozen opportunity identity", () => {
  for (const field of [
    "targetRepo",
    "workflowPath",
    "evidenceWindowStart",
    "evidenceWindowEnd",
    "assignmentRunId",
    "experimentId",
  ]) {
    assert.match(dataSpec, new RegExp(field));
  }

  assert.match(dataSpec, /token-opportunity:/);
  assert.match(dataSpec, /Display names MUST NOT participate in identity/);
  assert.match(dataSpec, /Repeated collection[\s\S]*deduplicated/);
});

test("token data contract preserves cost, quality, and evidence semantics", () => {
  for (const tokenClass of [
    "input-tokens",
    "output-tokens",
    "cache-read-tokens",
    "cache-write-tokens",
    "reasoning-tokens",
  ]) {
    assert.match(dataSpec, new RegExp(`\`${tokenClass}\``));
  }

  for (const state of ["complete", "incomplete", "incomparable", "unmatured", "unavailable"]) {
    assert.match(dataSpec, new RegExp(`\\| \`${state}\` \\|`));
  }

  assert.match(dataSpec, /MUST NOT\s+be summed into a synthesized total/);
  assert.match(dataSpec, /Reliability SHALL[\s\S]*remain separate from cost/);
  assert.match(dataSpec, /Outcome quality SHALL[\s\S]*remain separate/);
  assert.match(dataSpec, /proposed-savings-aic[\s\S]*gross-realized-savings-aic/);
  assert.match(dataSpec, /gross realized savings AIC =[\s\S]*optimized accepted-outcome count/);
  assert.match(dataSpec, /optimization overhead AIC =[\s\S]*attributable to this opportunity/);
  assert.match(dataSpec, /net realized savings AIC =[\s\S]*gross realized savings AIC - optimization overhead AIC/);
  assert.match(dataSpec, /counterfactual target\s+Workflow AIC avoided/);
  assert.match(dataSpec, /verified-net-gain/);
  assert.match(dataSpec, /recommendation-disposition[\s\S]*applied[\s\S]*superseded[\s\S]*failed-start/);
  assert.match(dataSpec, /recommendation-churn-rate/);
  assert.match(dataSpec, /excludes unrelated portfolio\s+discovery/);
  assert.match(dataSpec, /Every other state SHALL\s+produce null attainment/);
});

test("token data contract defines source grain and storage parity", () => {
  assert.match(mappingSpec, /token_usage_summary\.by_model/);
  assert.match(mappingSpec, /MUST\s+NOT fabricate API-invocation identities/);
  assert.match(mappingSpec, /safe-output creation[\s\S]*not accepted-outcome evidence/i);

  assert.match(dataSpec, /gh-aw-cao\.dashboard-sql-export/);
  assert.match(dataSpec, /SQL and IndexedDB adapters SHALL normalize[\s\S]*equivalent units, nullability, enums/);
  assert.match(dataSpec, /rebuild token-optimization projections from authoritative inputs/);
  assert.match(dataSpec, /explicit abort-scoped subscription/);
  assert.match(dataSpec, /JavaScript-derived\s+sources and main-thread compatibility calculations are prohibited/);
});

test("Dashboard Language exposes closed token-efficiency sources", () => {
  for (const source of [
    "token-efficiency-opportunities",
    "token-efficiency-interventions",
    "token-efficiency-comparisons",
  ]) {
    assert.match(languageSpec, new RegExp(`\\| \`${source}\` \\|`));
  }

  assert.match(languageSpec, /DLS-SEM-033/);
  assert.match(languageSpec, /DLS-SEM-037/);
  assert.match(languageSpec, /DLS-SEM-033–037 \| T-SEM-004/);
  assert.match(languageSpec, /gross-realized-savings-aic/);
  assert.match(languageSpec, /optimization-overhead-aic/);
  assert.match(languageSpec, /net-realized-savings-aic/);
  assert.match(languageSpec, /verified-net-gain/);
  assert.match(languageSpec, /recommendation-churn-count/);
  assert.match(languageSpec, /charge unrelated portfolio work/);
});

test("token data contract defines required conformance fixtures", () => {
  for (const fixture of [
    "Complete matched variants",
    "Incomplete",
    "incomparable",
    "unmatured",
    "unavailable",
    "Repeated source observations",
    "Malformed token-optimization evidence",
  ]) {
    assert.match(dataSpec, new RegExp(fixture, "i"));
  }
});
