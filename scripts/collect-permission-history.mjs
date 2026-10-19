import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { permissionIntentEra, readCompiledAgentPermissions, requiredExampleReadScopes } from "./native-permission-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function collectPermissionHistory(cache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "example-permissions-warning";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/native-permissions", sourcePath = `.github/workflows/${workflowId}.md`;
  const compiledPath = sourcePath.replace(/\.md$/, ".lock.yml");
  const reader = publicGitSourceReader(cache, repository), metadata = reader.metadata;
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous permissions-example adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  const date = revision => {
    const timestamp = metadata(["cat-file", "commit", revision]).match(/^committer .+> (\d+) [+-]\d{4}$/m)?.[1];
    if (!timestamp) throw new Error("Missing immutable permission commit timestamp");
    return new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z");
  };
  const require = createRequire(import.meta.url), yamlPackage = require.resolve("yaml/package.json");
  const contract = { repository, workflowId, sourcePath, compiledPath, sourceRevision, until, directory,
    sourceGitBlob: metadata(["rev-parse", `${sourceRevision}:${sourcePath}`]),
    requiredScopes: requiredExampleReadScopes,
    interpreterSha256: hash(readFileSync("scripts/native-permission-value.mjs")),
    sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
    yaml: { version: JSON.parse(readFileSync(yamlPackage, "utf8")).version,
      lockSha256: hash(readFileSync("package-lock.json")) },
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) },
    policy: "Current read-scope configuration facet; original intentional warning-demo states are not comparable goal acceptance." };
  mkdirSync(`${directory}/sources`, { recursive: true });
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const wrapper = `import { nativePermissionModule } from "../../../../scripts/native-permission-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativePermissionModule(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen permission function");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (prepareOnly) return { prepared: workflowId, requiredScopes: contract.requiredScopes };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) {
      throw new Error("Frozen permission acquisition changed");
    }
    for (const source of index.sources) if (censusDigest(readCensusJson(`${directory}/sources/${source.gitBlob}.json.gz`)) !== source.sha256) {
      throw new Error("Retained permission source changed");
    }
    return { reused: true, states: index.states, sourceBlobs: index.sources.length };
  }
  const end = Date.parse(until), week = 7 * 86400000;
  const endpoints = new Set([Date.parse(contract.adoption.adoptedAt), end, end - week, end - 2 * week]);
  for (let at = Date.parse(contract.adoption.adoptedAt) + week; at <= end; at += week) endpoints.add(at);
  if (endpoints.size > 100) throw new Error("Permission endpoint budget exceeded");
  const states = [...endpoints].sort((a, b) => a - b).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Permission endpoint has no immutable commit");
    const source = reader.read(commit, sourcePath), compiled = reader.read(commit, compiledPath);
    const native = readCompiledAgentPermissions(compiled?.bytes.toString("utf8"));
    console.log(JSON.stringify({ windowEnd, known: native.known }));
    return { windowEnd, commit, sourceGitBlob: source?.id ?? null, compiledGitBlob: compiled?.id ?? null,
      intentEra: permissionIntentEra(source?.bytes.toString("utf8")), native };
  });
  const sources = reader.sources().map(source => {
    writeCensusJson(`${directory}/sources/${source.id}.json.gz`, source);
    return { gitBlob: source.id, sha256: censusDigest(source) };
  });
  const facts = { states };
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  const index = { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sources, states: states.length,
    acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-permission-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } };
  writeCensusJson(`${directory}/index.json`, index);
  return { complete: true, states: states.length, sourceBlobs: sources.length };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, flag, ...extra] = process.argv.slice(2);
  if (!cache || extra.length || flag && flag !== "--prepare-only") throw new Error("usage: collect-permission-history.mjs BARE_CACHE [--prepare-only]");
  console.log(JSON.stringify(collectPermissionHistory(cache, flag === "--prepare-only")));
}
