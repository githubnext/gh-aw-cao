import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { permissionIntentEra, readCompiledAgentPermissions, scanAgentReadPermissions, scoreAgentReadPermissions } from "../../scripts/native-permission-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const complete = { contents: "read", issues: "read", "pull-requests": "read" };
const evidence = permissions => ({ valid: true, permissions });

test("compiled job permission maps replace, rather than merge with, workflow permissions", () => {
  const value = readCompiledAgentPermissions("permissions:\n  contents: read\n  issues: read\njobs:\n  agent:\n    permissions:\n      pull-requests: read\n");
  assert.equal(value.known, true);
  assert.equal(value.inherited, false);
  assert.deepEqual(value.permissions, { "pull-requests": "read" });
  assert.equal(scoreAgentReadPermissions("read-scope-mismatches", evidence(value.permissions)), 2);
  const empty = readCompiledAgentPermissions("permissions:\n  contents: read\njobs:\n  agent:\n    permissions: {}\n");
  assert.equal(scoreAgentReadPermissions("read-scope-mismatches", evidence(empty.permissions)), 3);
});

test("absent job permissions inherit only an explicit workflow map", () => {
  const value = readCompiledAgentPermissions("permissions:\n  contents: read\n  issues: read\n  pull-requests: read\njobs:\n  agent:\n    runs-on: ubuntu-latest\n");
  assert.equal(value.inherited, true);
  assert.equal(scoreAgentReadPermissions("read-scope-mismatches", evidence(value.permissions)), 0);
  assert.equal(readCompiledAgentPermissions("jobs:\n  agent:\n    runs-on: ubuntu-latest\n").known, false);
});

test("write is not equivalent to the goal's exact read grant, and other jobs are not agent permissions", () => {
  assert.deepEqual(scanAgentReadPermissions(evidence({ ...complete, contents: "write" })),
    { "read-scope-mismatches": 1, "agent-write-grants": 1, eligible: 3 });
  const value = readCompiledAgentPermissions("jobs:\n  agent:\n    permissions:\n      contents: read\n      issues: read\n      pull-requests: read\n  safe_outputs:\n    permissions:\n      issues: write\n  conclusion:\n    permissions:\n      issues: write\n");
  assert.equal(scoreAgentReadPermissions("agent-write-grants", evidence(value.permissions)), 0);
  assert.equal(scoreAgentReadPermissions("agent-write-grants", evidence({ ...complete, actions: "write" })), 1);
});

test("ambiguous or unsupported compiled shapes fail closed, rather than proving access", () => {
  for (const input of [null, "", "jobs: [agent]", "jobs:\n  agent:\n    uses: other/reusable.yml\n",
    "jobs:\n  agent:\n    permissions: read-all\n", "jobs:\n  agent:\n    permissions: null\n",
    "jobs:\n  agent:\n    permissions:\n      issues: read\n      issues: write\n",
    "permissions: &p {contents: read}\njobs:\n  agent:\n    permissions: *p\n",
    "jobs:\n  agent:\n    permissions:\n      contents: true\n"]) {
    const value = readCompiledAgentPermissions(input);
    assert.equal(value.known, false, String(input));
    assert.ok(value.reason);
  }
  for (const input of [{ valid: false }, evidence(null), evidence({ contents: true }), evidence(["read"])]) {
    assert.equal(scoreAgentReadPermissions("read-scope-mismatches", input), null);
  }
  assert.throws(() => scoreAgentReadPermissions("successful-runs", evidence(complete)), /Unknown/);
});

test("intent-era classification never mistakes intentional warning examples for permission failures", () => {
  assert.equal(permissionIntentEra("# Example: Under-provisioned Permissions Warning\n"), "warning-demo");
  assert.equal(permissionIntentEra("# Example: Properly Provisioned Permissions\n"), "read-only-demo");
  assert.equal(permissionIntentEra("# A changed goal\n"), "unknown");
  assert.equal(permissionIntentEra("# Example: Properly Provisioned Permissions\n# Extra goal\n"), "unknown");
});

test("retained permission evidence replays from byte-verified original source and compiled artifacts", async () => {
  const directory = "docs/operational-value/proof/native-permissions";
  const [contract] = readCensusJson(`${directory}/contracts.json`);
  const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
  const originals = new Map(index.sources.map(item => {
    const raw = readCensusJson(`${directory}/sources/${item.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), item.sha256);
    const native = Buffer.from(raw.native, "base64"), bytes = Buffer.from(raw.content, "base64");
    verifyPublicGitBlob(native, item.gitBlob);
    assert.equal(raw.lfs, null);
    assert.ok(native.equals(bytes));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), raw.sha256);
    return [item.gitBlob, bytes.toString("utf8")];
  }));
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.states, 54);
  assert.equal(index.sources.length, 70);
  assert.equal(index.producer.sha256, createHash("sha256").update(readFileSync(index.producer.path)).digest("hex"));
  for (const state of facts.states) {
    assert.ok(isDeepStrictEqual(state.native, readCompiledAgentPermissions(originals.get(state.compiledGitBlob))));
    assert.equal(state.intentEra, permissionIntentEra(originals.get(state.sourceGitBlob)));
  }
  const { collectBatch } = await import("../../docs/operational-value/proof/functions/example-permissions-warning.mjs");
  const rows = collectBatch(facts.states.map(state => ({ windowEnd: state.windowEnd })));
  assert.ok(rows.some(row => row.evidence.intentEra === "warning-demo"));
  assert.ok(rows.filter(row => row.evidence.intentEra === "warning-demo")
    .every(row => row.evidence.coverageStatus !== "complete"));
  assert.ok(rows.some(row => row.evidence.coverageStatus === "complete"));
  assert.equal(rows.at(-1).evidence.coverageStatus, "complete");
  assert.equal(scoreAgentReadPermissions("read-scope-mismatches", rows.at(-1).evidence), 0);
  assert.equal(scoreAgentReadPermissions("agent-write-grants", rows.at(-1).evidence), 0);
  assert.equal(rows.at(-1).evidence.runtimeAccess, "not-measured");
  assert.equal(rows.at(-1).evidence.compilerWarnings, "not-measured");
  assert.equal(rows.at(-1).evidence.mcpReadOnlyEnforcement, "not-measured");
  assert.equal(rows.at(-1).evidence.workflowCausation, "not-measured");
  const pulse = readCensusJson("docs/operational-value/proof/reports/github-gh-aw/example-permissions-warning-pulse.json");
  assert.equal(pulse.signal.status, "steady");
  assert.equal(pulse.signal.attention, "not-indicated");
  assert.equal(pulse.signal.current, 0);
  assert.equal(pulse.signal.previous, 0);
  assert.equal(pulse.signal.opportunities, 3);
});
