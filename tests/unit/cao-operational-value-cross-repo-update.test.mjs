import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectExactLineAppend, inspectUpdateReceipt, crossRepoUpdateScore } from "../../scripts/native-cross-repo-update-value.mjs";
import { verifyUpdateBlob } from "../../scripts/collect-cross-repo-update-value.mjs";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition, collectBatch } from "../../docs/operational-value/proof/functions/smoke-update-cross-repo-pr.mjs";

const bytes = value => Buffer.from(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const root = "docs/operational-value/proof/cross-repo-update";
const fixture = () => {
  const before = bytes("first\n"), after = bytes("first\nsecond\n");
  const profile = { targetRepository: "public/example", repositoryId: 42, pullId: 100,
    expectedBranch: "example", gitBlob: "a".repeat(40), compiledGitBlob: "d".repeat(40),
    sourceHead: "e".repeat(40), runtimeTree: "f".repeat(40), workflowRepository: "public/workflows",
    workflowRepositoryId: 43, workflowPath: ".github/workflows/example.lock.yml", runId: 1000, attempt: 1,
    runStartedAt: "2026-10-01T00:00:00Z", runCompletedAt: "2026-10-01T00:05:00Z",
    evidenceCutoff: "2026-10-02T00:00:00Z",
    host: { jobId: 2000, jobName: "protected-push", stepNumber: 3, checkerGitBlob: "1".repeat(40),
      startedAt: "2026-10-01T00:01:00Z", completedAt: "2026-10-01T00:04:00Z" },
    artifact: { id: 3000, createdAt: "2026-10-01T00:04:30Z" } };
  const receipt = { repository: profile.targetRepository, repositoryId: 42, pullId: 100, pullNumber: 1,
    visibility: "public", branch: "example", preBranch: "example",
    beforeCommit: "b".repeat(40), afterCommit: "c".repeat(40), beforeIsAncestor: true,
    kind: "protected-host-push-receipt", workflowSourceBlob: profile.gitBlob,
    compiledGitBlob: profile.compiledGitBlob, sourceHead: profile.sourceHead, runtimeTree: profile.runtimeTree,
    workflowRepository: profile.workflowRepository, workflowRepositoryId: profile.workflowRepositoryId,
    workflowPath: profile.workflowPath, runId: profile.runId, attempt: profile.attempt,
    preObservedAt: "2026-10-01T00:01:30Z", pushedAt: "2026-10-01T00:02:00Z", postObservedAt: "2026-10-01T00:03:00Z",
    host: { ...profile.host }, changedPaths: ["README.md"], beforeSha256: digest(before), afterSha256: digest(after) };
  const artifactBytes = bytes(JSON.stringify(receipt));
  profile.artifact.sha256 = digest(artifactBytes);
  receipt.artifact = { ...profile.artifact, runId: profile.runId, attempt: profile.attempt,
    repositoryId: profile.workflowRepositoryId, jobId: profile.host.jobId, sourceHead: profile.sourceHead };
  return { before, after, profile, receipt, artifactBytes };
};
const inspectFixture = value => inspectUpdateReceipt(value.receipt, value.profile,
  value.before, value.after, bytes("second"), value.artifactBytes);

test("exact native append oracle preserves bytes and independently supplied intended line", () => {
  assert.deepEqual(inspectExactLineAppend(bytes("first\n"), bytes("first\nsecond\n"), bytes("second")),
    { structuralAppend: true, sequentialAppend: true });
  assert.deepEqual(inspectExactLineAppend(bytes("first"), bytes("first\nsecond"), bytes("second")),
    { structuralAppend: true, sequentialAppend: true });
  assert.deepEqual(inspectExactLineAppend(bytes(""), bytes("first\n"), bytes("first")),
    { structuralAppend: true, sequentialAppend: true });
  assert.deepEqual(inspectExactLineAppend(bytes("first\n"), bytes("first\nwrong\n"), bytes("second")),
    { structuralAppend: true, sequentialAppend: false });
  const partial = inspectExactLineAppend(bytes("first\n"), bytes("first\nsecond\n"));
  assert.equal(partial.structuralAppend, true);
  assert.equal(partial.sequentialAppend, null);
});

test("native oracle rejects duplicates, rewritten prefixes, multiple lines, blanks and no-ops", () => {
  for (const after of ["first\nfirst\n", "altered\nsecond\n", "first\nsecond\nthird\n", "first\n\n", "first\n"]) {
    const result = inspectExactLineAppend(bytes("first\n"), bytes(after), bytes("second"));
    assert.equal(result.structuralAppend, false, after);
    assert.equal(result.sequentialAppend, false, after);
  }
  assert.equal(inspectExactLineAppend(null, bytes("second")).structuralAppend, null);
  assert.equal(inspectExactLineAppend(Buffer.from([255]), bytes("second")).structuralAppend, null);
});

test("receipt cannot substitute another target, branch, profile, file or private visibility", () => {
  const value = fixture();
  assert.equal(inspectFixture(value).sequentialAppend, true);
  for (const mutation of [{ visibility: "private" }, { repository: "different/example" },
    { branch: "other" }, { workflowSourceBlob: "f".repeat(40) }, { beforeIsAncestor: false },
    { branch: "other", preBranch: "other" }, { beforeCommit: value.receipt.afterCommit }, { changedPaths: ["README.md", "extra"] },
    { beforeSha256: "0".repeat(64) }, { kind: "agent-self-report" }, { repositoryId: 43 }, { pullId: null }]) {
    assert.equal(inspectFixture({ ...value, receipt: { ...value.receipt, ...mutation } }).sequentialAppend, null);
  }
});

test("receipt rejects different or absent independent execution/source/runtime/branch identities", () => {
  const value = fixture();
  for (const mutation of [{ runId: 1001 }, { attempt: 2 }, { runId: null }, { sourceHead: "2".repeat(40) },
    { compiledGitBlob: "2".repeat(40) }, { runtimeTree: "2".repeat(40) },
    { workflowRepository: "other/workflows" }, { workflowRepositoryId: 44 },
    { workflowPath: ".github/workflows/different.lock.yml" }, { pullId: 101 }]) {
    assert.equal(inspectFixture({ ...value, receipt: { ...value.receipt, ...mutation } }).sequentialAppend, null);
  }
  for (const field of ["runId", "attempt", "sourceHead", "runtimeTree", "compiledGitBlob", "expectedBranch",
    "workflowRepository", "workflowRepositoryId", "workflowPath", "pullId"]) {
    const profile = { ...value.profile };
    delete profile[field];
    assert.equal(inspectFixture({ ...value, profile }).sequentialAppend, null, field);
  }
});

test("native host and artifact joins require exact identities, bytes and projected payload", () => {
  const value = fixture();
  for (const mutation of [{ jobId: 2001 }, { jobName: "agent" }, { stepNumber: 4 }, { checkerGitBlob: "2".repeat(40) }]) {
    assert.equal(inspectFixture({ ...value, receipt: { ...value.receipt,
      host: { ...value.receipt.host, ...mutation } } }).sequentialAppend, null);
  }
  for (const mutation of [{ id: 3001 }, { runId: 1001 }, { attempt: 2 }, { sourceHead: "2".repeat(40) },
    { repositoryId: 44 }, { jobId: 2001 }, { sha256: "0".repeat(64) }]) {
    assert.equal(inspectFixture({ ...value, receipt: { ...value.receipt,
      artifact: { ...value.receipt.artifact, ...mutation } } }).sequentialAppend, null);
  }
  assert.equal(inspectFixture({ ...value, artifactBytes: null }).sequentialAppend, null);
  assert.equal(inspectFixture({ ...value, artifactBytes: bytes("{}") }).sequentialAppend, null);
  assert.equal(inspectFixture({ ...value, receipt: { ...value.receipt, forged: true } }).sequentialAppend, null);
  const malformed = fixture();
  malformed.artifactBytes = bytes("{");
  malformed.profile.artifact.sha256 = malformed.receipt.artifact.sha256 = digest(malformed.artifactBytes);
  assert.match(inspectFixture(malformed).reason, /Malformed native receipt/);
});

test("protected chronology rejects reordered events, wrong metadata times and invalid cutoffs", () => {
  const mutations = [
    value => { value.receipt.preObservedAt = value.receipt.pushedAt; },
    value => { value.receipt.preObservedAt = "2026-10-01T00:00:30Z"; },
    value => { value.receipt.postObservedAt = "2026-10-01T00:01:59Z"; },
    value => { value.receipt.postObservedAt = "2026-10-01T00:04:01Z"; },
    value => { value.receipt.host.startedAt = "2026-10-01T00:00:59Z"; },
    value => { value.receipt.artifact.createdAt = "2026-10-01T00:03:59Z"; },
    value => { value.profile.runStartedAt = "2026-10-01T00:01:01Z"; },
    value => { value.profile.runCompletedAt = "2026-10-01T00:04:29Z"; },
    value => { value.profile.evidenceCutoff = value.profile.runCompletedAt; },
    value => { value.receipt.pushedAt = "2026-02-30T00:00:00Z"; },
    value => { delete value.profile.runCompletedAt; },
  ];
  for (const mutate of mutations) {
    const value = fixture();
    mutate(value);
    const { artifact, ...payload } = value.receipt;
    value.artifactBytes = bytes(JSON.stringify(payload));
    value.profile.artifact.sha256 = artifact.sha256 = digest(value.artifactBytes);
    assert.match(inspectFixture(value).reason, /chronology/);
  }
});

test("native scores distinguish proven zero, partial progress, unknown and malformed evidence", () => {
  const row = { id: "synthetic", structuralAppend: true, sequentialAppend: null };
  assert.equal(crossRepoUpdateScore("sequential-appends", { valid: true, assessments: [row] }), null);
  assert.equal(crossRepoUpdateScore("nonduplicate-line-appends", { valid: true, assessments: [row] }), 1);
  assert.equal(crossRepoUpdateScore("sequential-appends", { valid: true, assessments: [
    { id: "failed", structuralAppend: false, sequentialAppend: false }] }), 0);
  for (const evidence of [{ valid: true, assessments: [] }, { valid: false },
    { valid: true, assessments: [row, row] },
    { valid: true, assessments: [{ ...row, structuralAppend: false, sequentialAppend: true }] }]) {
    assert.equal(crossRepoUpdateScore("sequential-appends", evidence), null);
  }
});

test("actual frozen public acquisition is complete but contains no private target content", () => {
  const acquisition = readJsonArchive(`${root}/acquisition.json`);
  const sources = readJsonArchive(`${root}/sources.json`);
  assert.equal(sources.profiles.length, 27);
  assert.equal(acquisition.runs.length, 2266);
  assert.equal(acquisition.completeness.retainedRunInventory, true);
  assert.equal(acquisition.completeness.historicalBranchUpdates, false);
  assert.equal(acquisition.targets.prose.private, true);
  assert.equal(acquisition.targets.prose.visibility, "private");
  assert.deepEqual(Object.keys(acquisition.targets.prose).sort(), ["fullName", "id", "private", "visibility"]);
  assert.equal(Object.hasOwn(acquisition, "legacyTarget"), false);
  assert.equal(Object.hasOwn(acquisition, "native"), false);
  assert.equal(acquisition.completeness.partitions.reduce((sum, row) => sum + row.totalCount, 0), acquisition.runs.length);
  for (const source of [...sources.profiles, ...sources.sources]) {
    const content = Buffer.from(source.content, "base64");
    assert.equal(digest(content), source.sha256);
    verifyUpdateBlob({ content: source.content, encoding: "base64", size: content.length, sha: source.gitBlob });
    if (source.compiled) {
      const compiled = Buffer.from(source.compiled.content, "base64");
      assert.equal(digest(compiled), source.compiled.sha256);
      verifyUpdateBlob({ content: source.compiled.content, encoding: "base64", size: compiled.length, sha: source.compiled.gitBlob });
    }
  }
});

test("actual source archive fails closed when a required part disappears or blob is changed", () => {
  const manifest = JSON.parse(readFileSync(`${root}/sources.json`, "utf8"));
  assert.equal(manifest.kind, "partitioned-census-json");
  const directory = mkdtempSync(path.resolve(".cross-repo-update-test-"));
  try {
    copyFileSync(`${root}/sources.json`, `${directory}/sources.json`);
    for (const part of manifest.parts) copyFileSync(`${root}/${part.file}`, `${directory}/${part.file}`);
    assert.equal(readJsonArchive(`${directory}/sources.json`).profiles.length, 27);
    unlinkSync(`${directory}/${manifest.parts[0].file}`);
    assert.throws(() => readJsonArchive(`${directory}/sources.json`), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true });
  }
  assert.throws(() => verifyUpdateBlob({ content: "eA==", encoding: "base64", size: 1, sha: "a".repeat(40) }), /identity mismatch/);
});

test("real offline collector never coerces unavailable private target evidence into zero", () => {
  assert.equal(definition.sourceReview.profiles.length, 27);
  assert.deepEqual(definition.sourceReview.acceptedSequenceOracles, []);
  const results = collectBatch([
    { windowStart: "2026-03-02T01:25:35Z", windowEnd: "2026-03-09T01:25:35Z", observedAt: "2026-03-09T01:25:35Z" },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
  ]);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.evidence.coverageStatus, "missing");
    assert.equal(result.evidence.eligibleCount, null);
    assert.match(result.evidence.missingReason, /private visibility/);
    assert.equal(result.evidence.nativeAssessmentCount, 0);
    assert.equal(crossRepoUpdateScore("sequential-appends", result.evidence), null);
    assert.equal(crossRepoUpdateScore("nonduplicate-line-appends", result.evidence), null);
    assert.equal(result.provenance.length, 2);
    const index = readJsonArchive(`${root}/index.json`);
    assert.equal(index.registration.provenanceKind, "public-source-and-run-inventory");
    assert.equal(index.registration.provenancePath, `${root}/acquisition.json`);
    assert.equal(index.registration.provenanceRef, digest(JSON.stringify(readJsonArchive(`${root}/acquisition.json`))));
    assert(result.provenance.some(row => row.kind === index.registration.provenanceKind && row.ref === index.registration.provenanceRef));
    assert.equal(index.complete, false);
    assert.equal(index.nativeEvidenceReady, false);
  }
});
