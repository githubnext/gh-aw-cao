import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessVersionCurrency, compareStableVersions, scoreVersionCurrency, stableVersion, versionCurrencyModule } from "../../scripts/native-version-currency-value.mjs";
import { normalizePublishedVersions } from "../../scripts/collect-version-currency-history.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("stable release comparison is numeric, rejects previews and normalizes publication times", () => {
  assert.equal(compareStableVersions("v1.10.0", "1.9.99"), 1);
  for (const version of ["01.2.3", "1.2", "1.2.3-beta", "latest", "1.9007199254740992.0"]) assert.equal(stableVersion(version), null);
  assert.deepEqual(normalizePublishedVersions([
    { version: "v1.2.3", publishedAt: "2026-10-01T01:00:00+01:00" },
    { version: "2.0.0", publishedAt: "2026-10-20T00:00:00Z" },
    { version: "3.0.0-preview", publishedAt: "2026-10-01T00:00:00Z" },
  ], "2026-10-18T00:00:00Z"), [{ version: "1.2.3", publishedAt: "2026-10-01T00:00:00Z" }]);
  assert.throws(() => normalizePublishedVersions([{ version: "1.2.3", publishedAt: "bad" }], "2026-10-18T00:00:00Z"));
  assert.deepEqual(normalizePublishedVersions([{ version: "1.2.3", publishedAt: "2026-10-18T00:00:00.001Z" }],
    "2026-10-18T00:00:00Z"), []);
});

test("source-defined cooldown and missing historical pins cannot produce fake complete-cohort improvement", () => {
  const tools = [{ id: "tool", constant: "Pin", cooldownDays: 3 }];
  const releases = { tool: { complete: true, versions: [
    { version: "1.9.0", publishedAt: "2026-10-01T00:00:00Z" },
    { version: "1.10.0", publishedAt: "2026-10-17T00:00:00Z" },
  ] } };
  const before = assessVersionCurrency({ Pin: "1.9.0" }, tools, releases, "2026-10-18T00:00:00Z");
  assert.equal(scoreVersionCurrency("stale-pins", before), 0);
  const after = assessVersionCurrency({ Pin: "1.9.0" }, tools, releases, "2026-10-21T00:00:00Z");
  assert.equal(scoreVersionCurrency("stale-pins", after), 1);
  assert.equal(scoreVersionCurrency("stale-pins", assessVersionCurrency({ Pin: "1.10.0" }, tools, releases, "2026-10-21T00:00:00Z")), 0);
  assert.equal(scoreVersionCurrency("stale-pins", assessVersionCurrency({ Pin: "1.10.0" }, tools, releases, "2026-10-15T00:00:00Z")), null);
  const partial = assessVersionCurrency({ Pin: "1.9.0" }, [...tools, { id: "absent", constant: "Missing" }], releases, "2026-10-21T00:00:00Z");
  assert.equal(scoreVersionCurrency("stale-pins", partial), null);
  assert.equal(scoreVersionCurrency("known-stale-pins", partial), 1);
  assert.equal(partial.known, 1);
  assert.equal(scoreVersionCurrency("stale-pins", { ...after, stale: 2 }), null);
  assert.equal(scoreVersionCurrency("stale-pins", assessVersionCurrency({ Pin: "1.10.0" }, [{ ...tools[0], cooldownDays: 0 }],
    { tool: { complete: true, versions: [{ version: "1.10.0", publishedAt: "2026-10-17T00:00:00.001Z" }] } },
    "2026-10-17T00:00:00Z")), null);
});

test("the Go AST oracle excludes comments, variables and unrelated string content", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-version-parser-test-"));
  try {
    const binary = path.join(temporary, "oracle");
    execFileSync("go", ["build", "-o", binary, "scripts/version-pin-oracle.go"],
      { env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" } });
    const input = [{ id: "test", content: `package constants
/* const Pin = "99.0.0" */
const (Pin Version = "1.10.0"; Other = "value")
var Fake = "9.0.0"
const Indirect = Pin
` }];
    const facts = JSON.parse(execFileSync(binary, [], { input: JSON.stringify(input), encoding: "utf8" }));
    assert.deepEqual(facts, [{ id: "test", constants: { Pin: "1.10.0", Other: "value" } }]);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});

test("all genuine native pin observations replay from retained Git blobs and official publication histories", () => {
  const directory = "docs/operational-value/proof/version-currency";
  const [contract] = readCensusJson(`${directory}/contracts.json`);
  const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
  assert.equal(index.complete, true);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(facts.states.length, 55);
  assert.equal(facts.sources.length, 141);
  assert.equal(contract.parserSha256, createHash("sha256").update(readFileSync("scripts/version-pin-oracle.go")).digest("hex"));
  for (const source of facts.sources) {
    assert.equal(createHash("sha1").update(`blob ${Buffer.byteLength(source.content)}\0`).update(source.content).digest("hex"), source.id);
  }
  for (const tool of contract.tools) {
    assert.equal(facts.releases[tool.id].complete, true);
    assert.ok(facts.releases[tool.id].versions.every(row => Date.parse(row.publishedAt) <= Date.parse(contract.until)));
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-version-history-test-"));
  try {
    const binary = path.join(temporary, "oracle");
    execFileSync("go", ["build", "-o", binary, "scripts/version-pin-oracle.go"],
      { env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" } });
    const parsed = new Map(JSON.parse(execFileSync(binary, [], { input: JSON.stringify(facts.sources),
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).map(row => [row.id, row.constants]));
    for (const state of facts.states) {
      const constants = {};
      for (const file of state.files) {
        for (const tool of contract.tools) {
          const value = parsed.get(file.gitBlob)[tool.constant];
          if (value != null) {
            assert.equal(Object.hasOwn(constants, tool.constant), false);
            constants[tool.constant] = value;
          }
        }
      }
      assert.deepEqual(state.constants, constants);
    }
  } finally {
    rmSync(temporary, { recursive: true });
  }
  const timeline = JSON.parse(readFileSync("docs/operational-value/proof/reports/github-gh-aw/cli-version-checker-timeline.json", "utf8"));
  const module = versionCurrencyModule(contract);
  const replay = module.collectBatch(timeline.snapshots.map(snapshot => ({ repository: contract.repository,
    windowEnd: snapshot.window.endAt })));
  assert.equal(timeline.snapshots.filter(snapshot => snapshot.evidence.completeCohort).length, 17);
  assert.equal(timeline.snapshots.at(-1).metrics["stale-pins"], 1);
  assert.equal(timeline.snapshots.at(-1).evidence.rows.find(row => row.stale).tool, "claude");
  for (const [position, snapshot] of timeline.snapshots.entries()) {
    assert.deepEqual(snapshot.evidence, replay[position].evidence);
    assert.deepEqual(snapshot.provenance, replay[position].provenance);
    for (const id of ["stale-pins", "known-stale-pins"]) {
      assert.equal(snapshot.metrics[id], scoreVersionCurrency(id, replay[position].evidence));
    }
  }
});
