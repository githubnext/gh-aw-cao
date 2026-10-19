import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { directInstructionEntries, nativeInstructionLineCount } from "../../scripts/collect-instruction-size-history.mjs";
import { instructionSizePolicy, nativeInstructionSizeModule, scanInstructionSizes, scoreInstructionSize } from "../../scripts/native-instruction-size-value.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const evidence = (...lines) => ({ valid: true, files: lines.map((count, i) => ({ path: `.github/aw/topic-${i}.md`, lines: count })) });
const source = limit => `---\nname: Test\n---\n# Instructions Janitor\n\`\`\`bash\nwc -l .github/aw/*.md\n\`\`\`\n- any file over \`${limit}\` lines must be split or rewritten before the task is considered complete\n`;

test("instruction size measures the native hard audit ceiling, not stricter layout targets", () => {
  assert.deepEqual(scanInstructionSizes(evidence(399, 400, 401, 450)),
    { "excess-instruction-lines": 51, "oversized-instruction-files": 2, eligible: 4 });
  assert.equal(scoreInstructionSize("excess-instruction-lines", evidence(400)), 0);
  assert.equal(scoreInstructionSize("excess-instruction-lines", evidence()), 0);
  assert.equal(scoreInstructionSize("excess-instruction-lines", { valid: false }), null);
});

test("native wc probes cover unterminated text, CRLF and exact ceiling boundaries", () => {
  for (const [text, expected] of [["", 0], ["last line", 0], ["a\nlast line", 1], ["a\r\nb\r\n", 2],
    ["\n\n", 2], ["a\n".repeat(400), 400], ["a\n".repeat(401), 401]]) {
    assert.equal(nativeInstructionLineCount(Buffer.from(text)), expected);
  }
  assert.throws(() => nativeInstructionLineCount("not bytes"), /budget/);
});

test("source policy detection requires the actual body audit rule and declared command", () => {
  assert.deepEqual(instructionSizePolicy(source(400)), { limit: 400, scope: ".github/aw/*.md" });
  assert.deepEqual(instructionSizePolicy(source(800)), { limit: 800, scope: ".github/aw/*.md" });
  assert.equal(instructionSizePolicy(source(400).replace("wc -l", "agent says")), null);
  assert.equal(instructionSizePolicy(source(400) + source(800).split("---\n").at(-1)), null);
  assert.equal(instructionSizePolicy("---\ndescription: 400 lines\n---\n# Nothing verified\n"), null);
  assert.equal(instructionSizePolicy(null), null);
});

test("direct native tree scope matches shell glob semantics and rejects symlink contents", () => {
  const blob = "a".repeat(40);
  const tree = paths => paths.map(([mode, name]) => `${mode} blob ${blob}\t.github/aw/${name}\0`).join("");
  const result = directInstructionEntries(tree([["100644", "syntax.md"], ["100644", "creator.md"],
    ["100644", "nested/other.md"], ["100644", ".hidden.md"], ["100644", "other.txt"]]));
  assert.deepEqual(result, { known: true, files: ["syntax.md", "creator.md"].map(name => ({ path: `.github/aw/${name}`, gitBlob: blob })) });
  assert.equal(directInstructionEntries(tree([["120000", "linked.md"]])).known, false);
  assert.equal(directInstructionEntries(tree([["100755", "executable.md"]])).known, false);
  assert.throws(() => directInstructionEntries("not native tree output"), /Unsupported/);
});

test("malformed, duplicate and out-of-scope native size evidence fails closed", () => {
  for (const files of [
    [{ path: ".github/aw/file.md", lines: -1 }], [{ path: ".github/aw/file.md", lines: 1.5 }],
    [{ path: ".github/aw/file.md", lines: Number.MAX_SAFE_INTEGER }],
    [{ path: ".github/aw/nested/file.md", lines: 3 }], [{ path: ".github/aw/.hidden.md", lines: 3 }],
    [{ path: ".github/aw/file.md", lines: 2 }, { path: ".github/aw/file.md", lines: 3 }],
  ]) assert.equal(scanInstructionSizes({ valid: true, files }), null);
  assert.throws(() => scoreInstructionSize("invented", evidence(1)), /Unknown/);
});

test("instruction module preserves native units and distinguishes incomplete acceptance", () => {
  const module = nativeInstructionSizeModule({ workflowId: "instructions-janitor", repository: "github/gh-aw",
    sourcePath: ".github/workflows/instructions-janitor.md", lineLimit: 400,
    interpreterSha256: hash(readFileSync("scripts/native-instruction-size-value.mjs")) });
  assert.equal(module.definition.evidence.measurementKind, "snapshot");
  assert.equal(module.definition.metrics.find(metric => metric.role === "primary").unit, "lines");
  assert.equal(module.scoreMetric("excess-instruction-lines", module.definition.validationExamples.targetMissed), 25);
  assert.ok(module.definition.evidence.filters.some(item => item.includes("not fresh workflow deliveries")));
});

test("instruction comparisons require policy continuity and a nonempty inspectable population", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cao-instruction-policy-"));
  try {
    const start = "2026-10-04T15:00:12Z", end = "2026-10-11T15:00:12Z";
    const policy = limit => ({ limit, scope: ".github/aw/*.md" });
    const contract = { workflowId: "instructions-janitor", repository: "github/gh-aw", directory,
      sourceRevision: "a".repeat(40), until: end, lineLimit: 400,
      interpreterSha256: hash(readFileSync("scripts/native-instruction-size-value.mjs")) };
    const facts = { states: [{ windowEnd: end, known: true, policy: policy(400), files: evidence(410).files }],
      policies: [{ at: start, policy: policy(400) }, { at: "2026-10-06T00:00:00Z", policy: policy(500) },
        { at: "2026-10-08T00:00:00Z", policy: policy(400) }] };
    const collect = () => {
      writeCensusJson(`${directory}/facts.json.gz`, facts);
      writeCensusJson(`${directory}/index.json`, { complete: true, sourceRevision: contract.sourceRevision, until: end,
        contractSha256: censusDigest(contract), factsSha256: censusDigest(facts) });
      return nativeInstructionSizeModule(contract).collectBatch([{ windowStart: start, windowEnd: end }])[0].evidence;
    };
    assert.equal(collect().coverageStatus, "partial", "Known equal endpoints do not establish policy continuity.");
    facts.policies = [facts.policies[0]];
    assert.equal(collect().coverageStatus, "complete");
    assert.equal(scoreInstructionSize("excess-instruction-lines", collect()), 10);
    facts.states[0].files = [];
    assert.equal(collect().coverageStatus, "partial");
    assert.equal(collect().eligibleCount, 0);
    facts.states[0].known = false;
    assert.equal(collect().coverageStatus, "unknown");
    assert.equal(scoreInstructionSize("excess-instruction-lines", collect()), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retained instruction sizes replay through immutable blobs and the native oracle", () => {
  const directory = "docs/operational-value/proof/instruction-size", [contract] = readCensusJson(`${directory}/contracts.json`);
  const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.producer.sha256, hash(readFileSync(index.producer.path)));
  assert.deepEqual(index.tool, contract.tool);
  assert.match(contract.tool.sha256, /^[a-f0-9]{64}$/);
  assert.ok(contract.tool.size > 0);
  const sources = new Map(index.sources.map(item => {
    const raw = readCensusJson(`${directory}/sources/${item.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), item.sha256);
    verifyPublicGitBlob(Buffer.from(raw.native, "base64"), item.gitBlob);
    const bytes = Buffer.from(raw.content, "base64");
    assert.equal(hash(bytes), raw.sha256);
    return [item.gitBlob, bytes];
  }));
  const counted = new Map();
  for (const state of facts.states) {
    assert.deepEqual(state.policy, instructionSizePolicy(sources.get(state.sourceGitBlob)?.toString()));
    for (const file of state.files) {
      const bytes = sources.get(file.gitBlob);
      assert.ok(bytes, "Every counted file must retain its immutable input.");
      assert.equal(hash(bytes), file.sha256);
      if (!counted.has(file.gitBlob)) counted.set(file.gitBlob, nativeInstructionLineCount(bytes));
      assert.equal(file.lines, counted.get(file.gitBlob));
    }
  }
  assert.equal(counted.size, index.features);
  assert.ok(index.sources.length > 300, "The complete archive must survive bounded native-reader batches.");
  assert.ok(index.comparableStates > 0);
  for (const probe of facts.probes) {
    const bytes = Buffer.from(probe.bytes, "base64");
    assert.equal(hash(bytes), probe.sha256);
    assert.equal(nativeInstructionLineCount(bytes), probe.lines);
  }
});
