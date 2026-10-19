import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { boundedPublicGitArchive } from "../../scripts/bounded-public-git-archive.mjs";
import { inspectNativeModel, modelFormatInvocation, modelFormatRecipe, modelJsonOptions } from "../../scripts/collect-model-format-history.mjs";
import { modelCatalogPaths, nativeModelFormatModule, scanModelFormatting, scoreModelFormatting } from "../../scripts/native-json-format-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const config = { parser: "typescript", semi: true, singleQuote: false, tabWidth: 2, trailingComma: "es5",
  printWidth: 240, bracketSpacing: true, arrowParens: "avoid", proseWrap: "never", bracketSameLine: true,
  singleAttributePerLine: false, overrides: [{ files: "*.cjs", options: { singleQuote: false } },
    { files: "*.json", options: { parser: "json" } }] };
const evidence = formatted => ({ valid: true, files: modelCatalogPaths.map(path => ({ path, formatted })) });

test("native model scoring preserves the exact two-catalog scope and unknowns", () => {
  assert.deepEqual(scanModelFormatting(evidence(true)), { "unformatted-model-catalogs": 0, eligible: 2 });
  assert.equal(scoreModelFormatting("unformatted-model-catalogs", evidence(false)), 2);
  for (const value of [{ valid: false }, { valid: true, files: [] },
    { valid: true, files: [evidence(true).files[0], evidence(true).files[0]] },
    { valid: true, files: [{ path: "other.json", formatted: true }, evidence(true).files[0]] }]) {
    assert.equal(scanModelFormatting(value), null);
  }
  assert.throws(() => scoreModelFormatting("invented", evidence(true)), /Unknown/);
});

test("formatter configuration is JSON-only, closed and independent of property order", () => {
  const options = modelJsonOptions(config);
  assert.equal(options.parser, "json");
  assert.equal(options.overrides, undefined);
  assert.equal(censusDigest(modelJsonOptions(Object.fromEntries(Object.entries(config).reverse()))), censusDigest(options));
  for (const value of [{ ...config, plugins: ["untrusted.js"] }, { ...config, printWidth: 80 },
    { ...config, overrides: [{ files: "*", options: { parser: "babel" } }] }]) assert.equal(modelJsonOptions(value), null);
  assert.equal(modelFormatRecipe("fmt: fmt-go\nfmt-json:\n\tignored\n"), null);
  assert.equal(modelFormatRecipe("fmt: fmt-json\nfmt-json:\n\tformatter\n\nnext:\n\tother\n"), "\tformatter\n");
  const command = '\t@"$(PRETTIER)" --write \'pkg/cli/data/models.json\' \'actions/setup/js/models.json\' --ignore-path .prettierignore\n';
  assert.equal(modelFormatInvocation(command), modelFormatInvocation("\t@echo unrelated\n" + command + "\t@echo finished\n"));
  assert.equal(modelFormatInvocation(command + command), null);
  assert.equal(modelFormatInvocation(command.replace("'actions/setup/js/models.json'", "'other.json'")), null);
});

test("formatter adapter checks ignore status, JSON validity, fixed points and unchanged parsed values", async () => {
  const options = modelJsonOptions(config), file = modelCatalogPaths[0], output = '{\n  "a": 1\n}\n';
  const formatter = { async getFileInfo() { return { ignored: false, inferredParser: "json" }; },
    async format(_input, received) { assert.equal(received.parser, "json"); assert.equal(received.plugins, undefined); return output; } };
  assert.equal((await inspectNativeModel(formatter, Buffer.from('{"a":1}'), file, options, "")).formatted, false);
  assert.equal((await inspectNativeModel(formatter, Buffer.from(output), file, options, "")).formatted, true);
  assert.equal((await inspectNativeModel(formatter, Buffer.from("{"), file, options, "")).known, false);
  assert.equal((await inspectNativeModel({ ...formatter, async getFileInfo() { return { ignored: true }; } },
    Buffer.from(output), file, options, "models.json")).known, false);
  await assert.rejects(inspectNativeModel({ ...formatter, async format() { return '{"a":2}\n'; } },
    Buffer.from(output), file, options, ""), /changed parsed/);
  await assert.rejects(inspectNativeModel(formatter, Buffer.from(output), file, { ...options, plugins: ["unsafe"] }, ""), /Unsupported/);
});

test("bounded public archives retain every source beyond a single-reader closure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cao-bounded-git-"));
  try {
    const checkout = path.join(directory, "repo"), archive = path.join(directory, "archive");
    mkdirSync(checkout);
    const git = args => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8",
      timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--quiet", "--object-format=sha1"]);
    git(["remote", "add", "origin", "https://github.com/fixture/repo.git"]);
    for (let i = 0; i < 305; i++) writeFileSync(path.join(checkout, `file-${i}.txt`), `Native fixture ${i}\n`);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Native archive fixtures"]);
    const revision = git(["rev-parse", "HEAD"]), reader = boundedPublicGitArchive(path.join(checkout, ".git"), "fixture/repo", archive);
    for (let i = 0; i < 305; i++) assert.equal(reader.read(revision, `file-${i}.txt`).bytes.toString(), `Native fixture ${i}\n`);
    const sources = reader.sources();
    assert.equal(sources.length, 305);
    for (const source of sources) assert.equal(censusDigest(readCensusJson(`${archive}/${source.gitBlob}.json.gz`)), source.sha256);
    reader.read(revision, "file-0.txt");
    assert.equal(reader.sources().length, 305, "Repeated source identities must deduplicate without dropping new inputs.");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("model formatter module exposes the native repository-condition facet, not runtime success", () => {
  const module = nativeModelFormatModule({ workflowId: "hourly-ci-cleaner", repository: "github/gh-aw",
    sourcePath: ".github/workflows/hourly-ci-cleaner.md", paths: modelCatalogPaths,
    interpreterSha256: hash(readFileSync("scripts/native-json-format-value.mjs")) });
  assert.equal(module.definition.evidence.measurementKind, "snapshot");
  assert.equal(module.definition.metrics[0].unit, "catalogs");
  assert.equal(module.scoreMetric("unformatted-model-catalogs", module.definition.validationExamples.targetMissed), 2);
  assert.ok(module.definition.evidence.filters.some(item => item.includes("not fresh workflow delivery")));
});

test("retained model-format evidence binds native receipts to every immutable input", () => {
  const directory = "docs/operational-value/proof/model-format", [contract] = readCensusJson(`${directory}/contracts.json`);
  const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
  const tool = readCensusJson(`${directory}/tool.json.gz`);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.producer.sha256, hash(readFileSync(index.producer.path)));
  assert.equal(contract.archiveReaderSha256, hash(readFileSync("scripts/bounded-public-git-archive.mjs")));
  assert.equal(contract.toolSha256, censusDigest(tool));
  assert.equal(index.toolSha256, censusDigest(tool));
  assert.ok(tool.files.length > 10);
  const sources = new Map(index.sources.map(item => {
    const raw = readCensusJson(`${directory}/sources/${item.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), item.sha256);
    verifyPublicGitBlob(Buffer.from(raw.native, "base64"), item.gitBlob);
    const bytes = Buffer.from(raw.content, "base64");
    assert.equal(hash(bytes), raw.sha256);
    return [item.gitBlob, bytes];
  }));
  assert.ok(index.comparableStates > 0);
  for (const state of facts.states) for (const file of state.files.filter(file => file.known)) {
    assert.equal(hash(sources.get(file.gitBlob)), file.inputSha256);
    assert.equal(file.formatted, file.inputSha256 === file.outputSha256);
  }
  assert.equal(facts.probes[0].result.formatted, false);
  assert.equal(facts.probes[1].result.formatted, true);
  assert.equal(facts.probes[3].result.known, false);
  const archived = `${directory}/versions/${contract.predecessorSha256}`;
  assert.equal(hash(readFileSync(`${archived}/function.txt`)), contract.predecessorSha256);
  const prior = readCensusJson(`${archived}/facts.json.gz`);
  assert.deepEqual(facts.states.map(state => state.files), prior.states.map(state => state.files),
    "Historical compatibility must not change any established native quantity or receipt.");
});
