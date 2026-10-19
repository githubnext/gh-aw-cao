import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { contract, cutoff, directory, hash, validateCustody, inspectMkdir, inspectGo,
  discovery, commitInfo, selectedGraph, coordinatedOriginals } from "../../docs/operational-value/proof/lint-rule/native.mjs";
import * as miner from "../../docs/operational-value/proof/functions/eslint-miner.mjs";
import * as refiner from "../../docs/operational-value/proof/functions/eslint-refiner.mjs";
import * as go from "../../docs/operational-value/proof/functions/linter-miner.mjs";

const modules = [miner, refiner, go];
const request = (start = "2026-05-15T03:09:19Z", end = cutoff) => ({
  windowStart: start, windowEnd: end, observedAt: cutoff,
});
const withRaw = (module, native) => ({ workflow: module.definition.slug,
  profileDigest: module.definition.partialFacetSha256, native });

test("complete production discovery verifies all 346 partitions and 58048 original entities", () => {
  const history = discovery();
  assert.equal(history.partitions, 346);
  assert.equal(history.entities, 58048);
  assert.deepEqual(Object.fromEntries(Object.entries(history.direct).map(([name, rows]) => [name, rows.length])),
    { "eslint-miner": 68, "eslint-refiner": 176, "linter-miner": 115 });
});

test("frozen source-first contracts remain independent and retrospective facets are labelled", () => {
  assert.equal(Object.keys(contract.workflows).length, 3);
  assert.match(contract.workflows["eslint-refiner"].acceptance, /incorrect-before\/correct-after/);
  assert.match(contract.workflows["eslint-miner"].goal, /JavaScript/);
  assert.match(contract.workflows["linter-miner"].goal, /Go analysis/);
  for (const module of modules) {
    assert.equal(module.definition.sourceFirstContractSha256, hash(readFileSync(path.join(directory, "contract.json"))));
    assert.match(module.definition.intent.acceptance, /Retrospective/);
    assert.equal(module.definition.limitations.fullGoal, null);
    assert.equal(module.definition.limitations.keepDecision, "not rated");
  }
});

test("all raw positive, negative, missing and malformed schema3 examples score independently", () => {
  for (const module of modules) {
    const examples = module.definition.validationExamples;
    assert.ok(module.scoreMetric("observed-partial", examples.targetAttained) >
      module.scoreMetric("observed-partial", examples.targetMissed));
    assert.equal(module.scoreMetric("observed-partial", examples.missing), null);
    assert.equal(module.scoreMetric("observed-partial", examples.malformed), null);
    assert.equal(module.scoreMetric("unknown-metric", examples.targetAttained), null);
    assert.equal(module.scoreMetric("observed-partial", { accepted: true, value: 999 }), null);
  }
});

test("JavaScript native AST distinguishes try body, catch, finally and nested function barriers", () => {
  const prefix = 'const fs = require("fs");\n';
  assert.equal(inspectMkdir(prefix + 'fs.mkdirSync("a")').rawUnguarded, 1);
  assert.equal(inspectMkdir(prefix + 'try { fs.mkdirSync("a") } catch(e){}').rawUnguarded, 0);
  assert.equal(inspectMkdir(prefix + 'try {} catch(e){fs.mkdirSync("a")}').rawUnguarded, 1);
  assert.equal(inspectMkdir(prefix + 'try {} finally {fs.mkdirSync("a")}').rawUnguarded, 1);
  assert.equal(inspectMkdir(prefix + 'try { const f = () => fs.mkdirSync("a") } catch(e){}').rawUnguarded, 1);
  assert.equal(inspectMkdir(prefix + '/* fs.mkdirSync("fake") */ "fs.mkdirSync(\\"fake\\")"').opportunities, 0);
  assert.equal(inspectMkdir(prefix + 'function f(fs){fs.mkdirSync("a")}').known, false);
  assert.equal(inspectMkdir('function require(){};\n' + prefix + 'fs.mkdirSync("a")').known, false);
  assert.equal(inspectMkdir(prefix + '({fs} = other);\nfs.mkdirSync("a")').known, false);
  assert.equal(inspectMkdir("const ???").known, false);
});

test("new suppression, deletion and changed mkdir arguments cannot masquerade as retained-call repair", () => {
  const prefix = 'const fs = require("fs");\n', before = prefix + 'fs.mkdirSync("a")';
  const score = after => miner.scoreMetric("observed-partial", withRaw(miner,
    { known: true, files: [{ path: "actions/setup/js/example.cjs", before, after }] }));
  assert.equal(score(prefix + '// eslint-disable-next-line\nfs.mkdirSync("a")'), 0);
  assert.equal(score(prefix), null);
  assert.equal(score(prefix + 'try { fs.mkdirSync("different") } catch(e){}'), null);
});

test("native Go AST ignores strings, comments, main packages, tests and shadowed os imports", () => {
  const cases = [
    { path: "pkg/example.go", source: 'package library\nimport "os"\nfunc f(){os.Exit(0)}' },
    { path: "pkg/example.go", source: 'package library\nimport process "os"\nfunc f(){process.Exit(0)}' },
    { path: "pkg/example.go", source: 'package library\nimport "os"\nfunc f(os interface{Exit(int)}){os.Exit(0)}' },
    { path: "pkg/example.go", source: 'package library\nvar text="os.Exit(0)"\n// os.Exit(0)\n' },
    { path: "pkg/example_test.go", source: "package library" },
    { path: "pkg/example.go", source: "package main" },
    { path: "pkg/example.go", source: "not Go" },
  ];
  const rows = inspectGo(cases);
  assert.deepEqual(rows.slice(0, 4).map(row => row.rawExits), [1, 1, 0, 0]);
  assert.ok(rows.slice(4).every(row => !row.known));
});

test("native EventEmitter alias/control proves API equivalence, not real diagnostic resolution", () => {
  assert.equal(refiner.nativeAlias(), true);
  const sample = structuredClone(refiner.definition.validationExamples.targetAttained);
  sample.native.after = sample.native.after.replace('"addListener"', '"imaginaryListener"');
  assert.equal(refiner.scoreMetric("observed-partial", sample), 0);
  sample.native.after = '// ' + sample.native.after.replaceAll("\n", "\n// ");
  assert.equal(refiner.scoreMetric("observed-partial", sample), null);
});

test("coordinated originals remain lossless and selected output links bind actual merge-source identities", () => {
  assert.equal(coordinatedOriginals().files.size, 49);
  const packet = validateCustody();
  assert.equal(packet.custody.missing.length, 0);
  const graph = selectedGraph(packet);
  assert.deepEqual(graph.links.find(link => link.number === 59679).references, [59646]);
  assert.equal(graph.links.find(link => link.number === 45709).files.find(row =>
    row.path.endsWith("require-mkdirsync-try-catch.ts")).agreesAtMerge, true);
  assert.equal(graph.links.find(link => link.number === 32448).files.find(row =>
    row.path.endsWith("osexitinlibrary.go")).agreesAtMerge, true);
  assert.ok(graph.issues.every(row => row.currentBodyIsUntrusted && /latent gap/.test(row.interpretation)));
});

test("selected actual JavaScript and alias facets preserve their exact narrow native quantities", async () => {
  for (const module of [miner, refiner]) {
    const [row] = await module.collectBatch([request(module.definition.adoption.adoptedAt)]);
    assert.equal(module.scoreMetric("observed-partial", row.evidence), 1);
    assert.equal(row.evidence.fullGoal, null);
    assert.equal(row.evidence.workflowContribution, null);
    assert.ok(row.evidence.sourceEra.profiles.every(profile => profile.actualExecutionIdentity === null));
    assert.ok(row.evidence.adoption.introduced.every(source => source.originalAvailable));
    if (module === refiner) assert.equal(row.evidence.native.realDiagnosticDefectsResolved, null);
  }
});

test("unrelated returns or altered exit-code values cannot satisfy native relocation", () => {
  const before = 'package library\nimport "os"\nfunc run() error { os.Exit(7); return nil }\n';
  const after = 'package library\nfunc run() error { return &ExitCodeError{Code: 0} }\n';
  const moved = 'package library\nfunc other() error { return &ExitCodeError{Code: 7} }\n';
  for (const source of [after, moved]) {
    const evidence = withRaw(go, { known: true, files: [{ path: "pkg/cli/upgrade_command.go", before, after: source }] });
    assert.equal(go.scoreMetric("observed-partial", evidence), null);
  }
});

test("raw Git objects, actual parent and Merkle source paths reject missing or tampered custody", () => {
  const packet = validateCustody();
  const original = packet.custody;
  assert.equal(commitInfo(packet, go.definition.adoption.commit).at, go.definition.adoption.adoptedAt);
  const wrongScope = structuredClone(original);
  wrongScope.repositoryId++;
  assert.throws(() => validateCustody(wrongScope), /scope mismatch/);
  const wrongTree = structuredClone(original);
  wrongTree.paths[0].chain[0] = "f".repeat(40);
  assert.throws(() => validateCustody(wrongTree), /Merkle/);
  assert.throws(() => validateCustody(original, filename => {
    const bytes = readFileSync(path.join(directory, filename));
    if (filename === original.partitions[0].file) bytes[10] ^= 1;
    return bytes;
  }), /integrity/);
  const part = original.partitions[0], rows = JSON.parse(gunzipSync(readFileSync(path.join(directory, part.file))));
  rows[0].base64 = Buffer.from("invented original").toString("base64");
  const forged = gzipSync(JSON.stringify(rows));
  const forgedIndex = structuredClone(original);
  forgedIndex.partitions[0] = { ...part, bytes: forged.length, sha256: hash(forged) };
  assert.throws(() => validateCustody(forgedIndex, filename => filename === part.file ? forged :
    readFileSync(path.join(directory, filename))), /object identity/);
});

test("real Go library transition has two known process-exit removals, not a context TODO benefit", async () => {
  const [row] = await go.collectBatch([request()]);
  assert.equal(go.scoreMetric("observed-partial", row.evidence), 2);
  assert.equal(row.evidence.fullGoal, null);
  assert.equal(row.evidence.workflowContribution, null);
  assert.equal(row.evidence.receiptVerifiedContribution, null);
  assert.equal(row.evidence.costs, null);
  assert.equal(row.evidence.keepDecision, "not rated");
  assert.equal(row.evidence.native.files.length, 1);
  assert.match(row.evidence.native.interpretation, /context TODO substitutions/);
});

test("cutoff-aligned disjoint windows deliver a selected transition once; missing intervals are null", async () => {
  const start = go.definition.adoption.adoptedAt, middle = "2026-10-11T15:00:12Z";
  const [whole, earlier, recent] = await go.collectBatch([request(start), request(start, middle), request(middle)]);
  assert.equal(go.scoreMetric("observed-partial", whole.evidence), 2);
  assert.equal(go.scoreMetric("observed-partial", earlier.evidence), 2);
  assert.equal(go.scoreMetric("observed-partial", recent.evidence), null);
  assert.equal(recent.evidence.selectedTransition, null);
  assert.equal(recent.evidence.coverageStatus, "missing");
});

test("collector rejects invalid dates, repositories, overlapping bounds and future cutoff assumptions", async () => {
  for (const module of modules) {
    await assert.rejects(module.collectBatch([request(cutoff, cutoff)]), /Invalid/);
    await assert.rejects(module.collectBatch([request("2026-02-30T00:00:00Z")]), /Invalid/);
    await assert.rejects(module.collectBatch([{ ...request(), repository: "private/other" }]), /Invalid/);
    const [future] = await module.collectBatch([{
      windowStart: cutoff, windowEnd: "2026-10-25T15:00:12Z", observedAt: "2026-10-25T15:00:12Z",
    }]);
    assert.equal(module.scoreMetric("observed-partial", future.evidence), null);
  }
});
