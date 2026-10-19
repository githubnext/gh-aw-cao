import assert from "node:assert/strict";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readZip } from "../../scripts/native-smoke-pydantic.mjs";
import { extractClaims, gpl3Terms, inspectPackage, moduleDirectoryHash } from "../../scripts/native-gpl-audit-value.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/gpclean.mjs";

const proof = "docs/operational-value/proof/gpl-audit";
const index = readJsonArchive(`${proof}/index.json.gz`);
const packet = label => readJsonArchive(`${proof}/${index.receipts[label].file}`);
const binary = label => Buffer.from(packet(label).body, "base64");
const goSum = Buffer.from(JSON.parse(packet("finding-source-go-sum").body).content.replace(/\s/g, ""), "base64").toString();
const reference = binary("gpl3-reference").toString();
const request = { windowStart: "2026-02-11T15:18:10Z", windowEnd: "2026-02-18T15:18:10Z",
  observedAt: "2026-10-18T15:00:12Z" };

test("six real versioned ZIPs match immutable Go sums and independent complete GPL3 declarations", async () => {
  const [{ evidence }] = await collectBatch([request]);
  assert.equal(scoreMetric("verified-license-facts", evidence), 6);
  assert.equal(evidence.records.length, 6);
  for (const row of evidence.records) {
    assert.equal(row.actualSum, row.expectedSum);
    assert.equal(row.termsSha256, row.canonicalTermsSha256);
    assert.equal(row.status, "verified");
    assert.ok(row.claim.quote.includes(row.module));
  }
  assert.equal(evidence.fullAcceptance, null);
  assert.equal(evidence.contribution, null);
  assert.equal(evidence.costs, null);
  assert.match(definition.limitations.join(" "), /not a legal determination/);
});

test("canonical Go directory hashes bind every byte, filename, module and version", () => {
  const module = index.modules[0], files = readZip(binary(module.receipt));
  const expected = moduleDirectoryHash(files, module.module, module.version);
  assert.ok(goSum.includes(`${module.module} ${module.version} ${expected}`));
  const altered = new Map(files);
  const [name, value] = altered.entries().next().value;
  altered.set(name, Buffer.concat([value, Buffer.from("\n")]));
  assert.notEqual(moduleDirectoryHash(altered, module.module, module.version), expected);
  assert.throws(() => moduleDirectoryHash(files, module.module, "v9.9.9"), /prefix/);
  assert.throws(() => moduleDirectoryHash(new Map([["bad\nname", Buffer.from("x")]]), module.module, module.version), /prefix/);
});

test("a package download or current license is not enough without its exact immutable sum", () => {
  const module = index.modules[0], zip = binary(module.receipt);
  const wrong = goSum.replace(moduleDirectoryHash(readZip(zip), module.module, module.version), `h1:${"A".repeat(43)}=`);
  const result = inspectPackage(module.module, module.version, zip, wrong, reference);
  assert.equal(result.status, "rejected");
  assert.equal(result.accepted, false);
  const absent = inspectPackage(module.module, module.version, zip, "", reference);
  assert.equal(absent.status, "missing");
  assert.equal(absent.accepted, false);
});

test("a GPL title, abbreviated notice or modified terms cannot substitute for full reference terms", () => {
  assert.equal(gpl3Terms("GPL-3.0"), null);
  assert.equal(gpl3Terms("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"), null);
  const module = index.modules[0];
  const changed = reference.replace("TERMS AND CONDITIONS", "TERMS AND CONDITIONS altered");
  assert.equal(inspectPackage(module.module, module.version, binary(module.receipt), goSum, changed).accepted, false);
  assert.throws(() => inspectPackage(module.module, module.version, binary(module.receipt), goSum, "GPL"), /complete GPL3 reference/);
});

test("claim extraction binds exact package/version statements instead of loose body co-occurrence", () => {
  const body = JSON.parse(packet("issue-15048").body).body;
  const claims = extractClaims(body);
  assert.equal(claims.length, 6);
  assert.equal(claims[0].module, "github.com/OpenPeeDeeP/depguard/v2");
  assert.equal(claims[0].version, "v2.2.1");
  assert.deepEqual(extractClaims("The audit passed. See github.com/example/lib and GPL v3 elsewhere."), []);
  assert.throws(() => extractClaims(`${body}\n${claims[1].quote}`), /Ambiguous repeated/);
});

test("native license facts cannot be forged, duplicated or promoted to legal clearance", async () => {
  const [{ evidence }] = await collectBatch([request]);
  for (const altered of [
    { ...evidence, records: [null] },
    { ...evidence, records: [...evidence.records, evidence.records[0]] },
    { ...evidence, records: [{ ...evidence.records[0], expectedSum: "invented" }] },
  ]) assert.equal(scoreMetric("verified-license-facts", altered), null);
  assert.equal(scoreMetric("license-compliance", evidence), null);
  assert.equal(scoreMetric("verified-license-facts", { valid: true, records: [] }), null);
});

test("failure-style objects and empty weeks are unknown, not completed audits or clean licenses", async () => {
  const [first, later] = await collectBatch([request, { ...request,
    windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z" }]);
  assert.equal(scoreMetric("verified-license-facts", first.evidence), 6);
  assert.equal(scoreMetric("verified-license-facts", later.evidence), null);
  assert.ok(later.evidence.discoveryObjects.length > 0);
  assert.ok(later.evidence.discoveryObjects.every(row => row.substantive === false));
  assert.equal(later.evidence.records.length, 0);
  assert.match(later.evidence.missingReason, /absence is not zero/);
});

test("half-open boundaries and authority checks preserve one delivered fact cohort", async () => {
  const at = "2026-02-12T00:41:12Z";
  const rows = await collectBatch([{ ...request, windowEnd: at }, { ...request, windowStart: at }]);
  assert.deepEqual(rows.map(row => scoreMetric("verified-license-facts", row.evidence)), [null, 6]);
  await assert.rejects(collectBatch([request], { claims: [] }), /authority/);
  await assert.rejects(collectBatch([{ ...request, repository: "private/target" }]), /period/);
  await assert.rejects(collectBatch([{ ...request, windowEnd: "2026-02-11T15:18:10Z" }]), /period/);
});
