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

test("Dependabot planner issues stay atomic, revalidated, and canonically sourced", () => {
  const source = workflow("dependabot-update-planner.md");

  assert.deepEqual(fixtures.map(({ name }) => name), [
    "mixed ecosystem batch assigned as one issue",
    "summary counts disagree with checklist",
    "upload-pages-artifact major upgrade drops hidden files",
    "duplicated literal action pin outside the canonical registry",
    "lockfile resolves beyond the reviewed target",
    "candidate breaks peer range and adds advisories",
    "partial batch closes the umbrella issue",
  ]);

  for (const fixture of fixtures) {
    let handled = false;
    if (fixture.expected.atomicWorkIssues) {
      handled = true;
      assert.equal(fixture.expected.pullRequestsPerWorkIssue, 1, fixture.name);
      assert.ok(fixture.expected.atomicWorkIssues > fixture.evidence.assignedIssues, fixture.name);
      assert.match(source, /Every assignable work issue must correspond to exactly one independently mergeable pull request boundary/);
      assert.match(source, /Never place GitHub Actions pin updates, ecosystem dependency updates for different package managers, or unrelated major upgrades in the same work issue/);
      assert.match(source, /auth, crypto, payment, database, serialization, deserialization, telemetry, build tooling, CI runners, package managers, or container bases in the same work issue as routine updates/);
      assert.match(source, /Never tell one assigned agent to produce more than one pull request, and never express isolation only as prose inside a combined issue/);
    }

    if (fixture.expected.umbrellaAssignable === false) {
      handled = true;
      assert.match(source, /The umbrella plan issue is an inventory and index only\. It must never be assigned to a coding agent/);
      assert.match(source, /\*\*Action:\*\* Assign the linked work issues below to Copilot or another coding agent\. Do not assign this umbrella issue\./);
    }

    if (fixture.expected.countsDerivedFromInventory) {
      handled = true;
      assert.notDeepEqual(fixture.evidence.summaryCounts, fixture.evidence.checklistCounts, fixture.name);
      assert.match(source, /Build one structured inventory before writing any issue text/);
      assert.match(source, /Derive every count in every issue from that final inventory/);
      assert.match(source, /never publish a summary whose per-ecosystem counts do not sum to the stated total or disagree with the checklist/);
    }

    if (fixture.expected.migrationInvariant) {
      handled = true;
      assert.match(source, /## Major-version migration review/);
      assert.match(source, /read the upstream release notes, changelog, and migration guide before declaring the update actionable/);
      assert.ok(source.includes(`\`${fixture.expected.migrationInvariant}\``), fixture.name);
      assert.match(source, /`actions\/upload-pages-artifact` v4 and later exclude hidden files by default/);
      assert.match(source, /docs\/public\/\.well-known\/ai\.txt/);
      assert.equal(fixture.expected.artifactValidationRequired, true, fixture.name);
      assert.match(source, /published artifacts still containing intentionally published paths/);
    }

    if (fixture.expected.canonicalSourceRequired) {
      handled = true;
      assert.match(source, /## Canonical ownership of pins and manifests/);
      assert.match(source, /Name the canonical manifest, lockfile, pin registry, or helper that produces the value/);
      assert.equal(fixture.expected.generatedFilesEditedDirectly, false, fixture.name);
      assert.match(source, /Prohibit direct edits to generated files and require regeneration through the repository's documented generator command/);
      assert.equal(fixture.expected.duplicateLiteralPinReplaced, true, fixture.name);
      assert.match(source, /require the assigned agent to replace the duplicate with the shared mechanism instead of updating another literal copy/);
    }

    if (fixture.expected.lockfileDriftRejected) {
      handled = true;
      const [first] = fixture.evidence.resolutions;
      assert.notEqual(first.reviewedTarget, first.resolved, fixture.name);
      assert.equal(fixture.expected.exactVersionFrozen, true, fixture.name);
      assert.match(source, /## Version and lockfile discipline/);
      assert.match(source, /The assigned agent may install only the exact target version unless the work issue explicitly authorizes a newer target/);
      assert.ok(
        source.includes(
          `require rejecting and repairing any lockfile that resolves a reviewed package beyond its exact reviewed target, for example \`${first.resolved}\` when \`${first.reviewedTarget}\` was reviewed`,
        ),
        fixture.name,
      );
      assert.match(source, /require inspecting the lockfile diff and reverting unrelated resolver churn before requesting review/);
    }

    if (fixture.expected.classification === "blocked") {
      handled = true;
      assert.equal(fixture.evidence.openDependabotAlerts, 0, fixture.name);
      assert.equal(fixture.expected.workIssueCreated, false, fixture.name);
      assert.match(source, /## Candidate compatibility and security preflight/);
      assert.match(source, /The absence of current Dependabot alerts is not sufficient evidence that a candidate version is safe or compatible/);
      assert.match(source, /If the candidate falls outside a declared peer range, mark it `blocked`/);
      assert.match(source, /If the candidate introduces a new high or critical severity advisory, mark it `blocked`/);
      assert.match(source, /Never create a work issue for a candidate whose peer ranges or resolved graph disprove it/);
    }

    if (fixture.expected.closingKeyword) {
      handled = true;
      assert.equal(fixture.evidence.pullRequestClosingKeyword, "Fixes", fixture.name);
      assert.equal(fixture.expected.umbrellaClosedByPartialWork, false, fixture.name);
      assert.match(source, /use `Part of #<issue>` when the pull request implements only part of this issue, and use `Fixes #<issue>` only when the pull request completely fulfills it/);
      assert.match(source, /never use `Fixes` against the umbrella inventory issue, because a partial batch must never close it/);
      assert.equal(fixture.expected.metadataSynchronized, true, fixture.name);
      assert.match(source, /keep the pull request title, description, checklist, and validation report synchronized with the final diff whenever review changes the scope/);
      assert.equal(fixture.expected.deferredRemainOpen, true, fixture.name);
      assert.match(source, /leave every unresolved or deferred update out of the pull request, keep its issue open, and report the deferral reason and remaining work on the issue/);
    }

    assert.ok(handled, `${fixture.name} matched no contract assertion`);
  }
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
  assert.match(source, /keep the remaining groups visible in the umbrella inventory as queued and create them on the next refresh/);
  assert.match(source, /never create more than one work issue for the same atomic group/);
  assert.match(source, /The umbrella issue must never contain an agent prompt and must never be assigned to a coding agent/);
});
