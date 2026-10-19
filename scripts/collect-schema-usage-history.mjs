import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { parseSpecTree } from "./collect-spec-condition-history.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const require = createRequire(import.meta.url);
const digestFile = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");

export function schemaExampleFacts({ id, content }) {
  const match = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { id, status: "no-frontmatter", data: null };
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) return { id, status: "invalid-yaml", data: null };
  if (document.warnings.length) return { id, status: "unsupported-yaml", data: null };
  const data = document.toJS({ maxAliasCount: 100 });
  JSON.stringify(data, (_, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-JSON numeric value in example");
    return value;
  });
  return { id, status: "parsed", data };
}

export function collectSchemaUsageHistory(historyDirectory, cache, validatorDirectory, facet = "schema-usage") {
  if (!["schema-usage", "safe-output-fixtures"].includes(facet)) throw new Error("Unknown structural coverage facet");
  const fixtureFacet = facet === "safe-output-fixtures";
  const { index: inventory } = readOutputHistory(historyDirectory);
  const workflowId = fixtureFacet ? "daily-safe-output-integrator" : "schema-feature-coverage";
  const workflow = inventory.workflows.find(row => row.id === workflowId);
  if (!workflow) throw new Error("Schema workflow is absent from frozen inventory");
  const { git, features: acquire } = gitEvidence(inventory.repository, cache);
  const adopted = fixtureFacet ? "57982094ad68087ed43382a1a9dea4c08a413a63" : "759d1461747a3fa7e7f2a5b6c86ae96ee2f84667";
  const baseline = fixtureFacet ? "fb7d3e808e18be2903b6c089f9997cdc11bb7399" : "550245d3a5126f8e8f4a0553ff57db0a4131b8dd";
  git(["merge-base", "--is-ancestor", adopted, inventory.sourceRevision]);
  if (!git(["rev-list", "--first-parent", "--max-count=100000", inventory.sourceRevision]).trim().split("\n").includes(baseline)) {
    throw new Error("Schema adoption is outside the bounded first-parent history");
  }
  for (const file of [workflow.path, workflow.path.replace(/\.md$/, ".lock.yml")]) {
    if (git(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]).trim() !== `A\t${file}`) {
      throw new Error("Schema adoption is not an actual source and compiled-workflow addition");
    }
  }
  const date = revision => new Date(git(["show", "--no-patch", "--format=%cI", revision]).trim()).toISOString().replace(".000Z", "Z");
  const contract = { workflowId, repository: inventory.repository, sourceRevision: inventory.sourceRevision,
    sourceGitBlob: workflow.gitBlob, until: inventory.until,
    nativeModelSha256: digestFile(fixtureFacet ? "scripts/native-safe-output-fixture-value.mjs" : "scripts/native-schema-coverage-value.mjs"),
    validatorSha256: digestFile("scripts/operational-value-schema-validator.py"),
    yamlVersion: JSON.parse(readFileSync(require.resolve("yaml/package.json"), "utf8")).version,
    validatorVersion: "jsonschema-4.23.0-draft7-no-format-assertions",
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  if (fixtureFacet) contract.schemaInterpreterSha256 = digestFile("scripts/native-schema-coverage-value.mjs");
  const directory = `docs/operational-value/proof/${facet}`;
  mkdirSync(directory, { recursive: true });
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const factory = fixtureFacet ? "nativeSafeOutputFixtureModule" : "nativeSchemaCoverageModule";
  const helper = fixtureFacet ? "native-safe-output-fixture-value" : "native-schema-coverage-value";
  const module = `import { ${factory} } from "../../../../scripts/${helper}.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = ${factory}(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== module) throw new Error("Refusing to replace frozen schema function");
  writeFileSync(functionFile, module);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (existsSync(`${directory}/index.json.gz`)) {
    const retained = readCensusJson(`${directory}/index.json.gz`);
    if (!retained.complete || retained.sourceRevision !== contract.sourceRevision || retained.until !== contract.until
      || retained.nativeModelSha256 !== contract.nativeModelSha256 || retained.validatorSha256 !== contract.validatorSha256
      || retained.yamlVersion !== contract.yamlVersion) throw new Error("Existing schema acquisition scope changed");
    for (const part of retained.partitions) {
      if (!/^facts-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe schema partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Retained schema facts changed");
    }
    writeCensusJson(`${directory}/index.json.gz`, retained);
    return { states: retained.states.length, facts: retained.facts, reused: true };
  }
  const end = Date.parse(inventory.until), start = Date.parse(contract.adoption.adoptedAt), week = 7 * 86400000;
  const endpoints = new Set([end, end - week]);
  for (let at = start + week; at <= end; at += week) endpoints.add(at);
  const states = [...endpoints].filter(at => at > start).sort((left, right) => left - right).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = git(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, inventory.sourceRevision]).trim();
    const tree = parseSpecTree(git(["ls-tree", "-rz", commit]));
    const schema = tree.get("pkg/parser/schemas/main_workflow_schema.json");
    if (!schema || schema.mode !== "100644") throw new Error("No immutable main schema at observation endpoint");
    const candidates = [...tree.values()].filter(row => fixtureFacet
      ? /^pkg\/cli\/workflows\/test-[^/]+\.md$/.test(row.path)
      : /^(?:\.github\/workflows|schema-demos)\/.+\.md$/.test(row.path));
    const registry = fixtureFacet ? tree.get("pkg/workflow/js/safe_outputs_tools.json") : null;
    if (fixtureFacet && (!registry || registry.mode !== "100644")) throw new Error("No immutable static safe-output registry");
    return { windowEnd, commit, tree: git(["rev-parse", `${commit}^{tree}`]).trim(), schema: schema.blob,
      ...(registry ? { registry: registry.blob } : {}),
      examples: candidates.filter(row => ["100644", "100755"].includes(row.mode))
        .map(row => ({ path: row.path, blob: row.blob, fact: `${schema.blob}:${row.blob}` })),
      excludedModes: candidates.filter(row => !["100644", "100755"].includes(row.mode)).length };
  });
  const schemaIds = new Set(states.map(state => state.schema));
  const registryIds = new Set(states.flatMap(state => state.registry ? [state.registry] : []));
  const blobs = [...schemaIds, ...registryIds, ...states.flatMap(state => state.examples.map(row => row.blob))];
  const acquired = acquire(blobs, rows => rows.map(row => schemaIds.has(row.id) || registryIds.has(row.id)
    ? { id: row.id, kind: "schema", data: JSON.parse(row.content) } : schemaExampleFacts(row)),
  { maxBlobs: 30000, maxBytes: 256 * 1024 * 1024 });
  const schemas = Object.fromEntries([...schemaIds].map(id => [id, acquired.features.get(id).data]));
  const examples = Object.fromEntries([...acquired.features].filter(([id]) => !schemaIds.has(id) && !registryIds.has(id)));
  const pairs = [...new Map(states.flatMap(state => state.examples.map(row =>
    [row.fact, { id: row.fact, schema: state.schema, blob: row.blob }]))).values()];
  const response = JSON.parse(execFileSync("python3", ["scripts/operational-value-schema-validator.py"], {
    input: JSON.stringify({ schemas, examples, pairs }), encoding: "utf8", timeout: 600000,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONPATH: path.resolve(validatorDirectory) },
  }));
  if (response.validator !== contract.validatorVersion || response.facts.length !== pairs.length
    || response.facts.some((row, index) => row.id !== pairs[index].id || row.schema !== pairs[index].schema
      || row.blob !== pairs[index].blob)) throw new Error("Independent schema oracle identity mismatch");
  if (fixtureFacet) {
    for (const fact of response.facts) {
      const value = examples[fact.blob].data?.["safe-outputs"];
      fact.safeOutputProperties = fact.valid && value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).sort() : [];
    }
  }
  const partitions = [];
  for (let offset = 0; offset < response.facts.length; offset += 200) {
    const rows = response.facts.slice(offset, offset + 200), file = `facts-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(`${directory}/${file}`, rows);
    partitions.push({ file, count: rows.length, sha256: censusDigest(rows) });
  }
  for (const state of states) {
    const properties = fixtureFacet ? schemas[state.schema]?.properties?.["safe-outputs"]?.properties : schemas[state.schema]?.properties;
    if (!properties || Array.isArray(properties) || typeof properties !== "object") throw new Error("Invalid schema property population");
    if (fixtureFacet) {
      const registry = acquired.features.get(state.registry).data;
      if (!Array.isArray(registry) || registry.some(row => typeof row.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(row.name))
        || new Set(registry.map(row => row.name)).size !== registry.length) throw new Error("Invalid static safe-output registry");
      state.registeredTools = registry.map(row => row.name).sort();
      state.properties = registry.map(row => row.name.replaceAll("_", "-")).filter(name => Object.hasOwn(properties, name)).sort();
    } else state.properties = Object.keys(properties).sort();
  }
  writeCensusJson(`${directory}/index.json.gz`, { schemaVersion: 1, complete: true, ...contract,
    kind: fixtureFacet ? "validated-safe-output-fixture-history" : "validated-schema-usage-history", acquiredAt: new Date().toISOString(), uniqueBlobs: acquired.uniqueBlobs,
    decodedBytes: acquired.totalBytes, facts: response.facts.length, states, partitions });
  return { states: states.length, facts: response.facts.length, uniqueBlobs: acquired.uniqueBlobs, decodedBytes: acquired.totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [history, cache, validator, facet, ...extra] = process.argv.slice(2);
  if (!history || !cache || !validator || extra.length) throw new Error(
    "usage: collect-schema-usage-history.mjs IDENTITY_HISTORY BARE_CACHE PINNED_PYTHON_PACKAGE_DIRECTORY [schema-usage|safe-output-fixtures]");
  console.log(JSON.stringify(collectSchemaUsageHistory(history, cache, validator, facet)));
}
