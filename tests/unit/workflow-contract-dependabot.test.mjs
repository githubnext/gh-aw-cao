import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root, workflow } from "./workflow-contract.helpers.mjs";

// Dependabot update-planner issue contracts, with regression fixtures derived from
// github/gh-aw#61573 (generated plan issue) and github/gh-aw#61574 (resulting pull request).

const fixtures = JSON.parse(readFileSync(
  join(root, "tests", "fixtures", "dependabot-update-planner-work-issues.json"),
  "utf8",
));

function fixture(name) {
  const match = fixtures.find((entry) => entry.name === name);
  assert.ok(match, `missing regression fixture: ${name}`);

  return match;
}

test("Dependabot planner prompt states every contract required by the regression fixtures", () => {
  const source = workflow("dependabot-update-planner.md");

  const names = fixtures.map(({ name }) => name);
  assert.ok(fixtures.length > 0, "expected regression fixtures");
  assert.equal(new Set(names).size, names.length, "fixture names must be unique");

  for (const entry of fixtures) {
    assert.match(entry.source, /^github\/gh-aw#(61573|61574)$/, entry.name);
    assert.ok(entry.expected.contract?.length > 0, `${entry.name} must require contract phrases`);
    for (const phrase of entry.expected.contract) {
      assert.ok(source.includes(phrase), `${entry.name} requires: ${phrase}`);
    }
  }
});

test("Dependabot planner splits a combined batch into atomic work issues", () => {
  const source = workflow("dependabot-update-planner.md");
  const combined = fixture("mixed ecosystem batch assigned as one issue");
  const ecosystems = new Set(combined.evidence.umbrellaUpdates.map(({ ecosystem }) => ecosystem));

  assert.equal(combined.evidence.assignedIssues, 1);
  assert.equal(combined.evidence.producedPullRequests, 1);
  assert.equal(combined.expected.atomicWorkIssues, ecosystems.size);
  assert.equal(combined.expected.pullRequestsPerWorkIssue, 1);
  assert.equal(combined.expected.umbrellaAssignable, false);
  assert.match(source, /Place several packages in one work issue only when a hard edge/);
  assert.match(source, /Isolation must be structural: one work issue per boundary/);
  assert.match(source, /complete exactly this atomic group in exactly one pull request, and never widen the scope to other updates/);
});

test("Dependabot planner derives counts from one structured inventory", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("summary counts disagree with checklist");

  assert.notDeepEqual(evidence.summaryCounts, evidence.checklistCounts);
  assert.equal(expected.countsDerivedFromInventory, true);
  assert.match(source, /### Structured inventory and derived counts/);
  assert.match(source, /Never state a count that was produced independently of the inventory/);
});

test("Dependabot planner records repository-specific major-version migration invariants", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("upload-pages-artifact major upgrade drops hidden files");

  assert.equal(evidence.updateType, "major");
  assert.equal(expected.artifactValidationRequired, true);
  assert.ok(source.includes(`\`${expected.migrationInvariant}\``));
  assert.ok(source.includes(evidence.repositoryArtifact));
  assert.match(source, /the repository-specific invariant that must still hold after the upgrade, and the command or artifact check that proves it/);
});

test("Dependabot planner requires canonical pin ownership and protects generated consumers", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("duplicated literal action pin outside the canonical registry");

  assert.equal(expected.canonicalSourceRequired, true);
  assert.equal(expected.duplicateLiteralPinReplaced, true);
  assert.equal(expected.generatedFilesEditedDirectly, false);
  assert.ok(evidence.generatedConsumers.length > 0);
  assert.match(source, /Detect duplicated literal pins of the same action or dependency/);
  assert.match(source, /change values only at the canonical source, never edit generated files directly/);
});

test("Dependabot planner freezes exact versions and rejects lockfile drift", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("lockfile resolves beyond the reviewed target");

  assert.equal(expected.exactVersionFrozen, true);
  assert.equal(expected.lockfileDriftRejected, true);
  for (const { reviewedTarget, resolved } of evidence.resolutions) {
    assert.notEqual(reviewedTarget, resolved);
  }
  const [first] = evidence.resolutions;
  assert.ok(source.includes(
    `require rejecting and repairing any lockfile that resolves a reviewed package beyond its exact reviewed target, for example \`${first.resolved}\` when \`${first.reviewedTarget}\` was reviewed`,
  ));
});

test("Dependabot planner defers candidates that break peer ranges or add advisories", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("candidate breaks peer range and adds advisories");

  assert.equal(evidence.openDependabotAlerts, 0);
  assert.ok(evidence.candidateGraphAdvisories.includes("high"));
  assert.equal(expected.classification, "blocked");
  assert.equal(expected.workIssueCreated, false);
  assert.match(source, /Resolve the declared peer dependency ranges of the candidate and of the packages that depend on it/);
  assert.match(source, /Record deferred candidates in the umbrella inventory with their blocking reason/);
});

test("Dependabot planner keeps partial work from closing the umbrella issue", () => {
  const source = workflow("dependabot-update-planner.md");
  const { evidence, expected } = fixture("partial batch must not close the umbrella issue");

  assert.equal(evidence.pullRequestClosingKeyword, "Fixes");
  assert.equal(evidence.pullRequestMetadata, "stale");
  assert.equal(expected.closingKeyword, "Part of");
  assert.equal(expected.umbrellaClosedByPartialWork, false);
  assert.equal(expected.metadataSynchronized, true);
  assert.equal(expected.deferredRemainOpen, true);
  assert.ok(evidence.deferredUpdates.length > 0);
  assert.match(source, /An agent must never close it; only complete fulfillment of every inventory entry allows a maintainer to close it/);
});

test("Dependabot planner revalidates every candidate against target HEAD", () => {
  const source = workflow("dependabot-update-planner.md");

  assert.match(source, /## Revalidate against target HEAD/);
  assert.match(source, /Record that commit SHA in the umbrella evidence and repeat it in every work issue/);
  for (const state of ["current", "stale", "superseded", "blocked", "actionable"]) {
    assert.match(source, new RegExp(`- \`${state}\` —`));
  }
  assert.match(source, /Only `actionable` classifications may become work issues/);
});

test("Dependabot planner creates bounded deduplicated work issues alongside the umbrella issue", () => {
  const source = workflow("dependabot-update-planner.md");
  const outputs = parse(/^---\n([\s\S]*?)\n---/.exec(source)[1])["safe-outputs"];

  assert.ok(outputs["create-issue"].max > 1, "planner must be able to create work issues");
  assert.equal(outputs["create-issue"]["deduplicate-by-title"], true);
  assert.equal(outputs["update-issue"].max, 1);
  assert.match(source, /Call `create_issue` once for each actionable atomic group that has no open work issue/);
  assert.match(source, /only when the umbrella issue number is already known/);
  assert.match(source, /On a bootstrap run that creates the umbrella issue, its number is not available yet, so create no work issues/);
  assert.match(source, /keep the remaining groups visible in the umbrella inventory as queued and create them on the next refresh/);
  assert.match(source, /never create more than one work issue for the same atomic group/);
  assert.match(source, /The umbrella issue must never contain an agent prompt and must never be assigned to a coding agent/);
});
