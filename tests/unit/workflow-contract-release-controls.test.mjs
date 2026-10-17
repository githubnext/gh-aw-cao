import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { readRuleset, recommendedRuleset, verifyReleaseRuleset } from "../../scripts/verify-release-ruleset.mjs";

test("recommended configuration is a GitHub-native ruleset with unique emitted check names", () => {
  assert.deepEqual(verifyReleaseRuleset(recommendedRuleset), []);
  const ruleset = structuredClone(recommendedRuleset);
  ruleset.conditions.ref_name = { exclude: [], include: ["~DEFAULT_BRANCH"] };
  assert.deepEqual(verifyReleaseRuleset(ruleset), []);
  const names = ["workflow-contracts", "cid", "cgo"].map((name) =>
    parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")).jobs.gate.name);
  const checks = ruleset.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(checks.map((check) => check.context), names);
  assert.equal(new Set(names).size, 3);
  assert.ok(checks.every((check) => check.integration_id === 15368));
});

test("missing or weakened independent-review, scanner, bypass, and check rules fail verification", () => {
  const mutations = [
    (r) => { r.enforcement = "evaluate"; },
    (r) => { delete r.bypass_actors; },
    (r) => { r.bypass_actors.push({ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }); },
    (r) => { r.conditions.ref_name.exclude.push("refs/heads/main"); },
    (r) => { r.conditions.ref_name.include = ["refs/heads/development"]; },
    (r) => { r.rules = r.rules.filter((rule) => rule.type !== "non_fast_forward"); },
    (r) => { r.rules = r.rules.filter((rule) => rule.type !== "deletion"); },
    (r) => { r.rules = r.rules.filter((rule) => rule.type !== "code_scanning"); },
    (r) => { r.rules.find((rule) => rule.type === "pull_request").parameters.required_approving_review_count = 0; },
    ...["dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"]
      .map((field) => (r) => { r.rules.find((rule) => rule.type === "pull_request").parameters[field] = false; }),
    (r) => { r.rules.find((rule) => rule.type === "required_status_checks").parameters.strict_required_status_checks_policy = false; },
    (r) => { r.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks[0].integration_id = null; },
    (r) => { r.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks[0].context = "test"; },
    (r) => { r.rules.find((rule) => rule.type === "required_status_checks").parameters.required_status_checks.push({ context: "Lint and unit tests", integration_id: 15368 }); },
    (r) => { r.rules.find((rule) => rule.type === "code_scanning").parameters.code_scanning_tools[0].security_alerts_threshold = "critical"; },
  ];
  for (const mutate of mutations) {
    const actual = structuredClone(recommendedRuleset);
    mutate(actual);
    assert.ok(verifyReleaseRuleset(actual).length > 0, String(mutate));
  }
});

test("ruleset reads reject non-explicit repository and id inputs before invoking gh", () => {
  for (const [repo, id] of [["--help", "1"], ["a/b/c", "1"], ["a/b", "../1"], ["a/b", ""], ["a/b", "0"]]) {
    assert.throws(() => readRuleset(repo, id), /Usage:/);
  }
});

test("app configuration exposes verification only as a manual script", () => {
  const app = parse(readFileSync(new URL("../../.github/github-app.yml", import.meta.url), "utf8"));
  assert.deepEqual(app.scripts, [{
    name: "Verify main release controls (read-only)",
    command: "node scripts/verify-release-ruleset.mjs githubnext/gh-aw-cao 20054276",
  }]);
});
