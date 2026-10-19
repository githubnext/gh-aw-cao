import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { normalizeCrossRepoRun } from "../../scripts/collect-cross-repo-creation-evidence.mjs";
import {
  scoreCrossRepoCreation, verifyCrossRepoDelivery, verifyCrossRepoGitObjects,
} from "../../scripts/native-cross-repo-creation-value.mjs";

const directory = "docs/operational-value/proof/cross-repo-creation";
const profile = { target: "github/gh-aw-side-repo", sourceGitBlob: "4d112feef189a2c36c76927a25bf96fee2efdb41" };
function nativeFixture({ line = "1.  Tell me, O Muse, of that ingenious hero who travelled far and wide",
  timestamp = "2026-10-17T00:29:00Z", finalNewline = true, existing = false, disconnected = false,
  repository = "github/gh-aw" } = {}) {
  const objects = [];
  const object = (type, bytes) => {
    bytes = Buffer.from(bytes);
    const id = createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
    if (!objects.some(row => row.id === id)) objects.push({ id, type, content: bytes.toString("base64") });
    return id;
  };
  const entry = (mode, name, id) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
  const text = `Smoke test run: 123\nRepository: ${repository}\nTimestamp: ${timestamp}\nStatus: cross-repo PR creation smoke test\n\n${line}${finalNewline ? "\n" : ""}`;
  const blob = object("blob", text);
  const inner = object("tree", entry("100644", "smoke-123.txt", blob));
  const headTree = object("tree", entry("40000", "smoke-tests", inner));
  const baseTree = existing ? headTree : object("tree", "");
  const base = object("commit", `tree ${baseTree}\nauthor fixture <fixture@example.invalid> 0 +0000\ncommitter fixture <fixture@example.invalid> 0 +0000\n\nbase\n`);
  const head = object("commit", `tree ${headTree}\n${disconnected ? "" : `parent ${base}\n`}author fixture <fixture@example.invalid> 1 +0000\ncommitter fixture <fixture@example.invalid> 1 +0000\n\nhead\n`);
  return {
    run: { id: 123, attempt: 1, repository, repositoryId: 1036865607, sourceGitBlob: profile.sourceGitBlob,
      startedAt: "2026-10-17T00:28:00Z", completedAt: "2026-10-17T00:32:00Z" },
    target: { id: 100, repository: profile.target, visibility: "public" },
    pullRequest: { id: 300, number: 30, baseRepositoryId: 100, headRepositoryId: 100,
      repository: profile.target, headBranch: "salted-new-branch", baseBranch: "main",
      headCommit: head, baseCommit: base, createdAt: "2026-10-17T00:30:00Z", draft: true, labels: ["smoke-test"] },
    objects,
  };
}

test("native checker verifies full Git paths and exact fixture with either final-newline form", () => {
  assert.equal(verifyCrossRepoDelivery(nativeFixture(), profile).passed, true);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ finalNewline: false }), profile).passed, true);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ repository: "githubnext/gh-aw" }), profile).passed, true);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ line: "agent says PASS" }), profile).passed, false);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ timestamp: "2026-10-17T00:31:00Z" }), profile).passed, false);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ timestamp: "2026-02-30T00:29:00Z" }), profile).passed, false);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ existing: true }), profile).passed, false);
  assert.equal(verifyCrossRepoDelivery(nativeFixture({ disconnected: true }), profile).passed, false);
  const partial = nativeFixture();
  partial.pullRequest.draft = false;
  partial.pullRequest.labels = [];
  const result = verifyCrossRepoDelivery(partial, profile);
  assert.equal(result.passed, true);
  assert.deepEqual(result.safeguards, { draft: false, smokeLabel: false });
});

test("PR existence, target substitution, reruns and incomplete Git proofs never establish delivery", () => {
  assert.equal(verifyCrossRepoDelivery(null, profile).passed, null);
  const wrongTarget = nativeFixture();
  wrongTarget.target.repository = "githubnext/gh-aw-side-repo";
  assert.throws(() => verifyCrossRepoDelivery(wrongTarget, profile), /Unbound/);
  const rerun = nativeFixture();
  rerun.run.attempt = 2;
  assert.throws(() => verifyCrossRepoDelivery(rerun, profile), /Unbound/);
  const privateTarget = nativeFixture();
  privateTarget.target.visibility = "private";
  assert.throws(() => verifyCrossRepoDelivery(privateTarget, profile), /Unbound/);
  const noBlob = nativeFixture();
  noBlob.objects = noBlob.objects.filter(row => row.type !== "blob");
  assert.throws(() => verifyCrossRepoDelivery(noBlob, profile), /Missing exact/);
  assert.throws(() => verifyCrossRepoDelivery({ ...nativeFixture(), objects: [] }, profile), /Missing target ancestry/);
  const forged = nativeFixture().objects;
  forged[0].content = Buffer.from("different").toString("base64");
  assert.throws(() => verifyCrossRepoGitObjects(forged), /digest/);
});

test("native counts distinguish full zero, missing, lower bounds and incomplete totals", () => {
  const evidence = { valid: true, coverageStatus: "partial", assessments: [{ id: 1, passed: null }] };
  assert.equal(scoreCrossRepoCreation("verified-deliveries", evidence), null);
  evidence.assessments.push({ id: 2, passed: true });
  assert.equal(scoreCrossRepoCreation("verified-deliveries", evidence), 1);
  assert.equal(scoreCrossRepoCreation("complete-deliveries", evidence), null);
  evidence.assessments = [{ id: 1, passed: false }];
  assert.equal(scoreCrossRepoCreation("verified-deliveries", evidence), null);
  evidence.coverageStatus = "complete";
  assert.equal(scoreCrossRepoCreation("verified-deliveries", evidence), 0);
  evidence.assessments.push({ id: 1, passed: true });
  assert.equal(scoreCrossRepoCreation("verified-deliveries", evidence), null);
});

test("real retained evidence remains open-blocked with no invented native value", async () => {
  const value = await import("../../docs/operational-value/proof/functions/smoke-create-cross-repo-pr.mjs");
  const index = readCensusJson(`${directory}/index.json`);
  const discovery = readCensusJson(`${directory}/discovery.json.gz`);
  const sources = readCensusJson(`${directory}/sources.json.gz`);
  assert.equal(index.status, "open-blocked");
  assert.equal(index.measured, false);
  assert.equal(index.acceptedReceipts, null);
  assert.equal(index.discoverySha256, censusDigest(discovery));
  assert.equal(index.sourcesSha256, censusDigest(sources));
  assert.equal(discovery.retained.length, 2265);
  assert.equal(discovery.candidates.length, 83);
  assert.equal(sources.history.length, 24);
  assert.equal(sources.compiledHistory.length, 853);
  const [{ evidence }] = value.collectBatch([{ windowStart: "2026-03-02T01:25:35Z",
    windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" }]);
  assert.equal(evidence.assessments.length, 2265);
  assert.equal(evidence.eligibleCount, null);
  assert.equal(value.scoreMetric("verified-deliveries", evidence), null);
  assert.equal(value.scoreMetric("complete-deliveries", evidence), null);
  assert.throws(() => normalizeCrossRepoRun({ id: 1 }), /Invalid/);
});

test("actual collector fails closed when retained receipts disappear or are corrupted", () => {
  const temporary = mkdtempSync(path.join(process.cwd(), ".cross-repo-evidence-test-"));
  const module = new URL("../../docs/operational-value/proof/functions/smoke-create-cross-repo-pr.mjs", import.meta.url).href;
  const script = `import {collectBatch} from ${JSON.stringify(module)};collectBatch([{windowStart:"2026-10-01T00:00:00Z",windowEnd:"2026-10-08T00:00:00Z",observedAt:"2026-10-08T00:00:00Z"}]);`;
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: temporary, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    assert.throws(run, /Command failed/);
    cpSync(directory, path.join(temporary, directory), { recursive: true });
    assert.doesNotThrow(run);
    const file = path.join(temporary, directory, "index.json");
    const index = JSON.parse(readFileSync(file, "utf8"));
    index.nativeValue = 0;
    writeFileSync(file, JSON.stringify(index));
    assert.throws(run, /Cross-repository evidence integrity/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
