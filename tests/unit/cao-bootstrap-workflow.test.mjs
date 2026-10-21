import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(new URL("../../.github/workflows/cao-bootstrap.yml", import.meta.url), "utf8");
const workflow = parse(source);

test("bootstrap simulator endpoints are compiled only into tests", () => {
  const files = readdirSync(new URL("../../server/internal/simulator/", import.meta.url))
    .filter((file) => file.startsWith("bootstrap") && file.endsWith(".go"));
  assert.ok(files.length > 0);
  assert.ok(files.every((file) => file.endsWith("_test.go")));
});

test("bootstrap jobs have only read permissions and never persist checkout credentials", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.env, undefined);
  for (const job of Object.values(workflow.jobs)) {
    assert.deepEqual(job.permissions, { contents: "read" });
    assert.equal(job.env, undefined);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with["persist-credentials"], false);
  }
  assert.doesNotMatch(source, /secrets\.|pull_request_target|id-token:/);
});

test("bootstrap clears real tokens and runs only the isolated local integration", () => {
  const steps = workflow.jobs.bootstrap.steps;
  const integration = steps.find((step) => step.run?.includes("npm run test:integration:bootstrap"));
  assert.deepEqual(integration.env, {
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
  });
  const authenticated = steps.filter((step) => Object.values(step.env ?? {}).includes("${{ github.token }}"));
  assert.equal(authenticated.length, 1);
  assert.match(authenticated[0].run, /gh extension install github\/gh-aw --pin/);
  assert.doesNotMatch(source, /gh aw run|gh workflow run|gh api.*(?:POST|PATCH|PUT|DELETE)|git push/);
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 7 * * *" }]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
});
