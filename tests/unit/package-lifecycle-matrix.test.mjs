import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectPackageLifecycleSuites } from "../../scripts/package-lifecycle-matrix.mjs";

const names = (files) => selectPackageLifecycleSuites(files).map(({ name }) => name);

test("package lifecycle matrix selects only packages owning changed files", () => {
  assert.deepEqual(names(["uk-ai-advisory/dashboard.json"]), []);
  assert.deepEqual(
    names([".github/workflows/shared/control.md"]),
    ["root", "CAO Evolution", "Dependabot"],
  );
  assert.deepEqual(
    names(["dashboard/site/index.html"]),
    ["root", "dashboard"],
  );
  assert.deepEqual(
    names([".github/workflows/graders/dependabot-release-train-updater-operational-value.sh"]),
    ["root", "Dependabot"],
  );
  assert.deepEqual(
    names([".github/workflows/graders/cao-evolution-compiler-security-operational-value.sh"]),
    ["root", "CAO Evolution"],
  );
  assert.deepEqual(
    names([".github/aw/optimization/graders/optimization-ai-credit-auditor-operational-value.sh"]),
    ["root"],
  );
  assert.deepEqual(
    names([".github/aw/eu-cra-compliance/graders/eu-cra-compliance-scope-classifier-operational-value.sh"]),
    [],
  );
  assert.deepEqual(
    names(["optimization/.github/graders/optimization-ai-credit-auditor-operational-value.sh"]),
    ["root"],
  );
  assert.deepEqual(
    names(["dependabot/.github/graders/dependabot-release-train-updater-operational-value.sh"]),
    ["root", "Dependabot"],
  );
  assert.deepEqual(
    names(["eu-cra-compliance/.github/graders/eu-cra-compliance-scope-classifier-operational-value.sh"]),
    [],
  );
});

test("package lifecycle matrix selects a package when its manifest changes", () => {
  assert.deepEqual(names(["activity/aw.yml"]), ["root", "activity"]);
  assert.deepEqual(names(["software-development-practices/aw.yml"]), []);
  assert.deepEqual(names(["self-care/aw.yml"]), []);
});

test("package lifecycle matrix selects no packages for unrelated changes", () => {
  assert.deepEqual(names(["docs/index.mdx"]), []);
});

test("package lifecycle matrix selects all packages for manual runs", () => {
  const suites = selectPackageLifecycleSuites(null);
  assert.equal(suites.length, 5);
  assert.equal(names(["tests/integration/package-lifecycle.test.mjs"]).length, 5);

  const source = readFileSync(new URL("../integration/package-lifecycle.test.mjs", import.meta.url), "utf8");
  const testNames = [...source.matchAll(/^test\("([^"]+)"/gm)].map((match) => match[1]);
  for (const suite of suites) {
    const matches = testNames.filter((testName) => new RegExp(suite["test-pattern"]).test(testName));
    assert.ok(matches.length >= 1, `${suite.name} must run at least one package lifecycle test`);
  }
});
