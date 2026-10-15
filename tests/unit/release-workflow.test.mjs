import assert from "node:assert/strict";
import test from "node:test";

import { generatedJobs, stepBlock, workflow } from "./workflow-contract.helpers.mjs";

test("tag and version-named draft exist before runtime assets are attached", () => {
  const source = workflow("release.md");
  const prepareRelease = stepBlock(source, "Generate draft release notes");
  const jobs = generatedJobs(workflow("release.lock.yml"));

  assert.match(prepareRelease, /github\.rest\.git\.createRef/);
  assert.match(prepareRelease, /ref: `refs\/tags\/\$\{releaseTag\}`/);
  assert.match(prepareRelease, /sha: context\.sha/);
  assert.match(prepareRelease, /github\.rest\.repos\.createRelease/);
  assert.match(prepareRelease, /tag_name: releaseTag/);
  assert.match(prepareRelease, /name: releaseTag/);
  assert.match(prepareRelease, /draft: true/);
  assert.match(prepareRelease, /prerelease: false/);
  assert.match(prepareRelease, /make_latest: 'false'/);
  assert.match(prepareRelease, /if \(release\.tag_name !== releaseTag\)/);
  assert.match(prepareRelease, /core\.setOutput\('release_tag', releaseTag\)/);
  assert.ok(
    prepareRelease.indexOf("github.rest.git.createRef") < prepareRelease.indexOf("github.rest.repos.createRelease"),
    "git tag must be created before the draft release",
  );
  assert.ok(jobs.get("attach-runtime-assets")?.needs.includes("prepare-release"));
});

test("release attaches an exact-SHA attested runtime before publishing", () => {
  const source = workflow("release.md");
  const attach = stepBlock(source, "Attach verified runtime assets to draft release");
  const jobs = generatedJobs(workflow("release.lock.yml"));

  assert.match(source, /attach-runtime-assets:[\s\S]*needs: prepare-release/);
  assert.match(source, /permissions:[\s\S]*actions: read[\s\S]*attestations: read[\s\S]*contents: write/);
  assert.match(attach, /cao-runtime\.yml\/runs\?head_sha=\$\{REVISION\}&event=push/);
  assert.match(attach, /conclusion == \\"success\\"/);
  assert.match(attach, /gh run download/);
  assert.match(attach, /sha256sum --check/);
  assert.match(attach, /gh attestation verify/);
  assert.match(attach, /--source-digest "\$\{REVISION\}"/);
  assert.match(attach, /--signer-digest "\$\{REVISION\}"/);
  assert.match(attach, /--deny-self-hosted-runners/);
  assert.match(attach, /\.draft == true[\s\S]*\.prerelease == false/);
  assert.match(attach, /target_commitish == \$revision/);
  assert.match(attach, /gh release upload/);
  assert.match(attach, /length == 2/);
  assert.deepEqual(jobs.get("attach-runtime-assets")?.needs, ["prepare-release"]);
  assert.ok(jobs.get("publish-release")?.needs.includes("attach-runtime-assets"));
});

test("release publishes the completed draft under the exact version tag", () => {
  const source = workflow("release.md");
  const publish = stepBlock(source, "Publish verified draft as prerelease");
  const jobs = generatedJobs(workflow("release.lock.yml"));

  assert.match(source, /publish-release:[\s\S]*needs: \[prepare-release, attach-runtime-assets\]/);
  assert.match(source, /publish-release:[\s\S]*permissions:[\s\S]*contents: write/);
  assert.match(publish, /RELEASE_ID: \$\{\{ needs\.prepare-release\.outputs\.release_id \}\}/);
  assert.match(publish, /RELEASE_TAG: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/);
  assert.match(publish, /RUNTIME_ARCHIVE: \$\{\{ needs\.attach-runtime-assets\.outputs\.runtime_archive \}\}/);
  assert.match(publish, /draft\.tag_name !== releaseTag/);
  assert.match(publish, /draft\.target_commitish !== revision/);
  assert.match(publish, /draft\.draft !== true/);
  assert.match(publish, /github\.rest\.git\.getRef/);
  assert.match(publish, /releaseRef\.object\.sha !== revision/);
  assert.match(publish, /listReleaseAssets/);
  assert.match(publish, /github\.rest\.repos\.updateRelease/);
  assert.match(publish, /tag_name: releaseTag/);
  assert.match(publish, /draft: false/);
  assert.match(publish, /prerelease: true/);
  assert.match(publish, /make_latest: 'false'/);
  assert.match(publish, /published\.tag_name !== releaseTag/);
  assert.match(publish, /published\.immutable !== true/);
  assert.match(publish, /releaseByTag\.id !== releaseId/);
  assert.deepEqual(jobs.get("publish-release")?.needs, ["attach-runtime-assets", "prepare-release"]);
  assert.ok(jobs.get("agent")?.needs.includes("publish-release"));
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

test("agent consumes and verifies the published prerelease identity", () => {
  const source = workflow("release.md");
  const fetchReleaseContext = stepBlock(source, "Fetch release context");

  assert.match(source, /prepare-release:[\s\S]*outputs:[\s\S]*release_tag: \$\{\{ steps\.release\.outputs\.release_tag \}\}/);
  assert.match(fetchReleaseContext, /RELEASE_TAG: \$\{\{ needs\.publish-release\.outputs\.release_tag \}\}/);
  assert.match(fetchReleaseContext, /RUNTIME_ARCHIVE: \$\{\{ needs\.attach-runtime-assets\.outputs\.runtime_archive \}\}/);
  assert.match(fetchReleaseContext, /gh api "\/repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_ID"/);
  assert.match(fetchReleaseContext, /\.tag_name == \$tag[\s\S]*\.draft == false[\s\S]*\.prerelease == true[\s\S]*\.immutable == true/);
  assert.match(fetchReleaseContext, /test "\$RUNTIME_ARCHIVE" = "cao-runtime-\$\{GITHUB_SHA\}\.tgz"/);
  assert.match(source, /- `tag`: `\$\{\{ needs\.publish-release\.outputs\.release_tag \}\}`/);
  assert.doesNotMatch(source, /safeoutputs\/publish_release/);
});
