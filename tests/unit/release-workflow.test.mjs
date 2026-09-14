import assert from "node:assert/strict";
import test from "node:test";

import { generatedJobs, stepBlock, workflow } from "./workflow-contract.helpers.mjs";

test("draft release exists before the agent job starts", () => {
  const source = workflow("release.md");
  const prepareRelease = stepBlock(source, "Generate draft release notes without assets");
  const jobs = generatedJobs(workflow("release.lock.yml"));

  assert.match(prepareRelease, /github\.rest\.repos\.createRelease/);
  assert.match(prepareRelease, /draft: true/);
  assert.doesNotMatch(prepareRelease, /github\.rest\.git\.createRef/);
  assert.ok(jobs.get("agent")?.needs.includes("prepare-release"));
});

test("release context paginates before filtering complete API responses", () => {
  const fetchReleaseContext = stepBlock(workflow("release.md"), "Fetch release context");

  assert.doesNotMatch(fetchReleaseContext, /gh api[^\n]*--slurp/);
  assert.equal(
    fetchReleaseContext.match(/gh api --paginate[\s\S]*?\|\n\s+jq --slurp/g)?.length,
    2,
    "each API request should paginate before local jq slurps its responses",
  );
});

test("release context fetches tags before local git inspection", () => {
  const fetchReleaseContext = stepBlock(workflow("release.md"), "Fetch release context");
  const fetchPreviousTag = fetchReleaseContext.indexOf('fetch_release_tag "$PREVIOUS_TAG"');
  const fetchReleaseTag = fetchReleaseContext.indexOf('fetch_release_tag "$RELEASE_TAG"');
  const verifyPreviousTag = fetchReleaseContext.indexOf('git rev-parse --verify "refs/tags/$PREVIOUS_TAG"');
  const verifyReleaseTag = fetchReleaseContext.indexOf('git rev-parse --verify "refs/tags/$RELEASE_TAG"');

  assert.match(fetchReleaseContext, /fetch --force origin "refs\/tags\/\$tag:refs\/tags\/\$tag"/);
  assert.ok(fetchPreviousTag !== -1, "previous release tag must be fetched when present");
  assert.ok(fetchReleaseTag !== -1, "new draft release tag must be fetched");
  assert.ok(fetchPreviousTag < verifyPreviousTag, "previous tag must be fetched before verification");
  assert.ok(fetchReleaseTag < verifyReleaseTag, "release tag must be fetched before verification");
});
