import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const oracle = "scripts/operational-value-schema-references.py";
const dialect = "http://json-schema.org/draft-07/schema#";
export const schemaReferenceProbes = [
  { id: "escaped-pointer", schema: { $schema: dialect, properties: { example: { $ref: "#/$defs/a~1b~0c" } },
    $defs: { "a/b~c": { type: "string" } } }, expected: [0, 0] },
  { id: "encoded-pointer", schema: { $schema: dialect, properties: { example: { $ref: "#/$defs/space%20key" } },
    $defs: { "space key": true } }, expected: [0, 0] },
  { id: "unused-cycle", schema: { $schema: dialect, type: "object",
    $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } }, expected: [2, 0] },
  { id: "reachable-cycle", schema: { $schema: dialect, $ref: "#/$defs/a",
    $defs: { a: { anyOf: [{ $ref: "#/$defs/b" }, { type: "string" }] }, b: { $ref: "#/$defs/a" } } }, expected: [0, 0] },
  { id: "missing", schema: { $schema: dialect, properties: { a: { $ref: "#/$defs/absent" } } }, expected: [0, 1] },
  { id: "annotation-is-not-usage", schema: { $schema: dialect, default: { $ref: "#/$defs/a" },
    examples: [{ $ref: "#/$defs/missing" }], $defs: { a: {} } }, expected: [1, 0] },
  { id: "ref-siblings-ignored", schema: { $schema: dialect, $ref: "#/$defs/a",
    properties: { ignored: { $ref: "#/$defs/b" } }, $defs: { a: {}, b: {} } }, expected: [1, 0] },
  { id: "optional-properties-valid", schema: { $schema: dialect, properties: { optional: { type: "string" } } }, expected: [0, 0] },
  { id: "scalar-target", schema: { $schema: dialect, $ref: "#/title", title: "Not a schema" }, expected: [0, 1] },
  { id: "invalid-target", schema: { $schema: dialect, $ref: "#/$defs/a", $defs: { a: { type: 123 } } }, expected: [1, 1] },
  { id: "external-unknown", schema: { $schema: dialect, $ref: "https://example.invalid/schema.json" }, expected: null },
  { id: "nested-id-unknown", schema: { $schema: dialect, properties: { a: { $id: "other.json" } } }, expected: null },
  { id: "bad-schema-unknown", schema: { $schema: dialect, required: "not-an-array" }, expected: null },
  { id: "bad-definitions-unknown", schema: { $schema: dialect, $defs: { broken: 123 } }, expected: null },
  { id: "annotation-target-scope-unknown", schema: { $schema: dialect, $ref: "#/default",
    default: { $id: "other.json", $ref: "#/properties/a" } }, expected: null },
];

export function runSchemaReferenceOracle(rows, toolDirectory) {
  const response = JSON.parse(execFileSync("python3", ["-S", oracle], { encoding: "utf8", timeout: 600000,
    maxBuffer: 32 * 1024 * 1024, input: JSON.stringify(rows.map(({ id, schema }) => ({ id, schema }))),
    env: { ...process.env, PYTHONPATH: path.resolve(toolDirectory), PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" } }));
  if (censusDigest(response.tool) !== censusDigest({ jsonschema: "4.23.0", referencing: "0.37.0" })
    || response.facts?.length !== rows.length || response.facts.some((row, i) => row.id !== rows[i].id)) {
    throw new Error("Native schema reference oracle identity mismatch");
  }
  return response;
}

export function schemaReferenceToolIdentity(toolDirectory) {
  const program = `import hashlib,json,pathlib,sys
from importlib.metadata import version
root=pathlib.Path(sys.argv[1]).resolve()
files=[]
for file in sorted(root.rglob("*")):
 if "__pycache__" in file.parts or file.suffix==".pyc": continue
 if file.is_symlink(): raise RuntimeError("Tool closure contains a symlink")
 if file.is_file():
  content=file.read_bytes()
  files.append({"path":str(file.relative_to(root)),"size":len(content),"sha256":hashlib.sha256(content).hexdigest()})
if len(files)>5000 or sum(f["size"] for f in files)>64*1024*1024: raise RuntimeError("Tool identity budget exceeded")
print(json.dumps({"python":sys.version.split()[0],"versions":{n:version(n) for n in ["jsonschema","referencing","attrs","rpds-py","jsonschema-specifications","typing_extensions"]},"files":files},separators=(",",":")))`;
  return JSON.parse(execFileSync("python3", ["-S", "-c", program, path.resolve(toolDirectory)], { encoding: "utf8",
    timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONPATH: path.resolve(toolDirectory) } }));
}

export function collectSchemaReferenceHistory(cache, toolDirectory, prepareOnly = false) {
  const repository = "github/gh-aw", sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
  const until = "2026-10-18T15:00:12Z", directory = "docs/operational-value/proof/schema-references";
  const schemaPath = "pkg/parser/schemas/main_workflow_schema.json";
  const reader = publicGitSourceReader(cache, repository), metadata = reader.metadata;
  const tool = schemaReferenceToolIdentity(toolDirectory);
  const toolSha256 = censusDigest(tool), interpreterSha256 = hash(readFileSync("scripts/native-schema-reference-value.mjs"));
  const contracts = [
    { workflowId: "daily-schema-audit-cursor", workflowName: "Daily Schema Consistency Audit", primaryMetric: "unused-root-definitions" },
    { workflowId: "schema-consistency-checker", workflowName: "Schema Consistency Checker", primaryMetric: "unresolved-local-references" },
  ].map(workflow => {
    const sourcePath = `.github/workflows/${workflow.workflowId}.md`;
    const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
    if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous schema-audit source adoption");
    const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
    if (metadata(["ls-tree", "-r", baseline, "--", sourcePath])
      || !metadata(["ls-tree", "-r", adopted, "--", sourcePath]).startsWith("100644 blob ")) {
      throw new Error("Schema-audit source adoption is not a true addition against its parent");
    }
    const date = revision => {
      const timestamp = metadata(["cat-file", "commit", revision]).match(/^committer .+> (\d+) [+-]\d{4}$/m)?.[1];
      if (!timestamp) throw new Error("Missing immutable schema-audit commit timestamp");
      return new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z");
    };
    const contract = { ...workflow, repository, sourceRevision, sourcePath, schemaPath, until, directory,
      sourceGitBlob: metadata(["rev-parse", `${sourceRevision}:${sourcePath}`]),
      interpreterSha256, oracleSha256: hash(readFileSync(oracle)), toolSha256,
      sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
      adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
    const functionFile = `docs/operational-value/proof/functions/${workflow.workflowId}.mjs`;
    const wrapper = `import { nativeSchemaReferenceModule } from "../../../../scripts/native-schema-reference-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeSchemaReferenceModule(${JSON.stringify(contract, null, 2)});\n`;
    if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen schema reference function");
    writeFileSync(functionFile, wrapper);
    return contract;
  });
  mkdirSync(`${directory}/sources`, { recursive: true });
  writeCensusJson(`${directory}/contracts.json`, contracts);
  writeCensusJson(`${directory}/tool.json.gz`, tool);
  const probe = runSchemaReferenceOracle(schemaReferenceProbes, toolDirectory);
  for (let i = 0; i < probe.facts.length; i++) {
    const fact = probe.facts[i], expected = schemaReferenceProbes[i].expected;
    if (expected === null) assert.equal(fact.known, false);
    else {
      assert.equal(fact.known, true);
      assert.deepEqual([fact.unusedDefinitions.length, fact.unresolvedReferences.length], expected);
    }
  }
  const receipt = { inputs: schemaReferenceProbes, response: probe, oracleSha256: contracts[0].oracleSha256, toolSha256 };
  const probeFile = `${directory}/probe.json.gz`;
  if (existsSync(probeFile) && censusDigest(readCensusJson(probeFile)) !== censusDigest(receipt)) throw new Error("Native schema probe changed");
  writeCensusJson(probeFile, receipt);
  if (prepareOnly) return { prepared: contracts.map(contract => contract.workflowId), nativeProbes: probe.facts.length };
  const indexFile = `${directory}/index.json`;
  if (existsSync(indexFile)) {
    const index = readCensusJson(indexFile);
    if (!index.complete || censusDigest(index.contracts) !== censusDigest(contracts.map(censusDigest))
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))
      || index.probeSha256 !== censusDigest(receipt) || index.toolSha256 !== toolSha256) throw new Error("Frozen schema reference acquisition changed");
    for (const source of index.sources) if (censusDigest(readCensusJson(`${directory}/sources/${source.gitBlob}.json.gz`)) !== source.sha256) {
      throw new Error("Retained schema reference source changed");
    }
    return { reused: true, states: index.states, sourceBlobs: index.sources.length };
  }
  const week = 7 * 86400000, end = Date.parse(until), endpoints = new Set([end, end - week, end - 2 * week]);
  for (const contract of contracts) {
    const start = Date.parse(contract.adoption.adoptedAt);
    endpoints.add(start);
    for (let at = start + week; at <= end; at += week) endpoints.add(at);
    reader.read(sourceRevision, contract.sourcePath);
    reader.read(contract.adoption.commit, contract.sourcePath);
  }
  if (endpoints.size > 200) throw new Error("Schema reference endpoint budget exceeded");
  const schemas = new Map();
  const states = [...endpoints].sort((a, b) => a - b).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Schema reference endpoint has no immutable commit");
    const source = reader.read(commit, schemaPath);
    if (source && !schemas.has(source.id)) schemas.set(source.id, { id: source.id, schema: JSON.parse(source.bytes.toString("utf8")) });
    return { windowEnd, commit, schemaGitBlob: source?.id ?? null };
  });
  const response = runSchemaReferenceOracle([...schemas.values()], toolDirectory);
  const sources = reader.sources().map(source => {
    writeCensusJson(`${directory}/sources/${source.id}.json.gz`, source);
    return { gitBlob: source.id, sha256: censusDigest(source) };
  });
  const facts = { states, features: response.facts };
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  writeCensusJson(indexFile, { schemaVersion: 1, complete: true, repository, sourceRevision, until,
    contracts: contracts.map(censusDigest), factsSha256: censusDigest(facts), sources, states: states.length,
    toolSha256, probeSha256: censusDigest(receipt), acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-schema-reference-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } });
  return { complete: true, states: states.length, sourceBlobs: sources.length, nativeSchemas: response.facts.length };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, toolDirectory, flag, ...extra] = process.argv.slice(2);
  if (!cache || !toolDirectory || extra.length || flag && flag !== "--prepare-only") {
    throw new Error("usage: collect-schema-reference-history.mjs BARE_CACHE VALIDATOR_DIRECTORY [--prepare-only]");
  }
  console.log(JSON.stringify(collectSchemaReferenceHistory(cache, toolDirectory, flag === "--prepare-only")));
}
