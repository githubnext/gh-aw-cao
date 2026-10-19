import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { boundedPublicGitArchive } from "./bounded-public-git-archive.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { modelCatalogPaths } from "./native-json-format-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function modelFormatRecipe(source) {
  return typeof source === "string" && /^fmt:[^\r\n]*\bfmt-json\b/m.test(source)
    ? source.match(/^fmt-json:\r?\n((?:\t[^\n]*(?:\n|$))*)/m)?.[1] ?? null : null;
}
export function modelFormatInvocation(recipe) {
  if (typeof recipe !== "string") return null;
  const lines = recipe.split("\n").filter(line => line.includes('"$(PRETTIER)" --write ')
    && modelCatalogPaths.every(file => line.includes(`'${file}'`)));
  return lines.length === 1 ? lines[0].trim() : null;
}
export function modelJsonOptions(value) {
  const expected = { parser: "typescript", semi: true, singleQuote: false, tabWidth: 2, trailingComma: "es5",
    printWidth: 240, bracketSpacing: true, arrowParens: "avoid", proseWrap: "never", bracketSameLine: true,
    singleAttributePerLine: false, overrides: [{ files: "*.cjs", options: { singleQuote: false } },
      { files: "*.json", options: { parser: "json" } }] };
  if (!isDeepStrictEqual(value, expected)) return null;
  const { overrides: _overrides, ...options } = expected;
  return { ...options, parser: "json" };
}
export async function inspectNativeModel(prettier, bytes, file, options, ignore) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024 || !modelCatalogPaths.includes(file)
    || !modelJsonOptions({ ...options, parser: "typescript", overrides: [
      { files: "*.cjs", options: { singleQuote: false } }, { files: "*.json", options: { parser: "json" } }] })) {
    throw new Error("Unsupported native model formatter input");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "cao-model-format-"));
  try {
    const ignoreFile = path.join(directory, ".prettierignore"), filename = path.join(directory, file);
    writeFileSync(ignoreFile, ignore);
    const info = await prettier.getFileInfo(filename, { ignorePath: ignoreFile, resolveConfig: false });
    if (info.ignored || info.inferredParser !== "json") return { known: false, reason: "Native formatter ignores the model catalog or cannot identify JSON." };
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { known: false, reason: "Model catalog is not valid JSON." };
    }
    const output = await prettier.format(bytes.toString("utf8"), { ...options, filepath: filename });
    if (!isDeepStrictEqual(value, JSON.parse(output))) throw new Error("Native model formatting changed parsed JSON values");
    const outputSha256 = hash(Buffer.from(output));
    return { known: true, ignored: false, inputSha256: hash(bytes), outputSha256, formatted: hash(bytes) === outputSha256 };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function collectModelFormatHistory(cache, toolDirectory, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "hourly-ci-cleaner";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/model-format", sourcePath = `.github/workflows/${workflowId}.md`;
  const reader = boundedPublicGitArchive(cache, repository, `${directory}/sources`), metadata = reader.metadata;
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous CI-cleaner adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  if (metadata(["ls-tree", "-r", baseline, "--", sourcePath])) throw new Error("CI-cleaner adoption is not a true addition");
  const date = revision => {
    const timestamp = metadata(["cat-file", "commit", revision]).match(/^committer .+> (\d+) [+-]\d{4}$/m)?.[1];
    if (!timestamp) throw new Error("Missing model-format commit timestamp");
    return new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z");
  };
  const source = reader.read(sourceRevision, sourcePath), make = reader.read(sourceRevision, "Makefile");
  const config = reader.read(sourceRevision, ".prettierrc.json"), options = modelJsonOptions(JSON.parse(config.bytes.toString()));
  const frozenIgnore = reader.read(sourceRevision, ".prettierignore");
  const recipe = modelFormatRecipe(make.bytes.toString());
  const invocation = modelFormatInvocation(recipe);
  if (!options || !invocation
    || !source.bytes.toString().includes("make fmt")) throw new Error("Unsupported frozen CI-cleaner formatting contract");
  const upstreamLock = JSON.parse(reader.read(sourceRevision, "actions/setup/js/package-lock.json").bytes.toString());
  const installedLock = JSON.parse(readFileSync(path.join(toolDirectory, "package-lock.json"), "utf8"));
  const pinned = upstreamLock.packages["node_modules/prettier"], installed = installedLock.packages["node_modules/prettier"];
  if (pinned.version !== installed.version || pinned.integrity !== installed.integrity) throw new Error("Native formatter differs from the frozen source tool");
  const packageRoot = path.join(toolDirectory, "node_modules/prettier"), toolFiles = [];
  const walk = (relative = "") => {
    for (const entry of readdirSync(path.join(packageRoot, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { const bytes = readFileSync(path.join(packageRoot, file)); toolFiles.push({ path: file, size: bytes.length, sha256: hash(bytes) }); }
      else throw new Error("Unsupported native formatter package entry");
    }
  };
  walk();
  toolFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const tool = { version: pinned.version, integrity: pinned.integrity, node: process.version, files: toolFiles };
  const contract = { repository, workflowId, sourcePath, sourceRevision, until, directory, paths: modelCatalogPaths,
    sourceGitBlob: source.id, recipeSha256: hash(recipe), configSha256: censusDigest(options),
    ignoreSha256: frozenIgnore ? hash(frozenIgnore.bytes) : null, toolSha256: censusDigest(tool),
    interpreterSha256: hash(readFileSync("scripts/native-json-format-value.mjs")),
    sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
    archiveReaderSha256: hash(readFileSync("scripts/bounded-public-git-archive.mjs")),
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  const predecessor = "24131fff6c72a80080949ea4d3f871b7feb8f1d5ebe9a1976e08e7651d33fe5f";
  const archive = `${directory}/versions/${predecessor}`;
  const [priorContract] = readCensusJson(`${archive}/contracts.json`), priorIndex = readCensusJson(`${archive}/index.json`);
  const priorFacts = readCensusJson(`${archive}/facts.json.gz`);
  if (hash(readFileSync(`${archive}/function.txt`)) !== predecessor
    || priorIndex.contractSha256 !== censusDigest(priorContract) || priorIndex.factsSha256 !== censusDigest(priorFacts)
    || priorIndex.producer.sha256 !== hash(readFileSync(`${archive}/producer.txt`))
    || priorContract.interpreterSha256 !== hash(readFileSync(`${archive}/interpreter.txt`))
    || Object.keys(priorContract).some(key => censusDigest(priorContract[key]) !== censusDigest(contract[key]))) {
    throw new Error("Model-format predecessor or frozen native outcome contract changed");
  }
  contract.predecessorSha256 = predecessor;
  contract.modelInvocationSha256 = hash(invocation);
  mkdirSync(`${directory}/sources`, { recursive: true });
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const wrapper = `import { nativeModelFormatModule } from "../../../../scripts/native-json-format-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeModelFormatModule(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper
    && hash(readFileSync(functionFile)) !== predecessor) throw new Error("Refusing to alter frozen model-format function");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  writeCensusJson(`${directory}/tool.json.gz`, tool);
  if (prepareOnly) return { prepared: workflowId, tool: pinned.version };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) throw new Error("Frozen model-format acquisition changed");
    if (index.contractSha256 === censusDigest(contract)) return { reused: true, states: index.states };
    if (censusDigest(index) !== censusDigest(priorIndex)) throw new Error("Unrecognized model-format predecessor index");
  }
  const prettier = await import(pathToFileURL(path.join(packageRoot, "index.mjs")).href);
  if (prettier.version !== pinned.version) throw new Error("Native formatter runtime version mismatch");
  const probes = [];
  for (const text of ['{"b":2,"a":1}', '{\n  "a": 1\n}\n', '{"text":"a\\\\nb","array":[1,true,null]}', '{"x":']) {
    const result = await inspectNativeModel(prettier, Buffer.from(text), modelCatalogPaths[0], options, "");
    probes.push({ input: text, result });
  }
  if (probes[0].result.formatted !== false || probes[1].result.formatted !== true || probes[3].result.known !== false) {
    throw new Error("Native JSON formatter probes failed");
  }
  const configPaths = [".prettierrc.json", "actions/setup/js/.prettierrc.json"];
  const parents = ["", "pkg", "pkg/cli", "pkg/cli/data", "actions", "actions/setup", "actions/setup/js"];
  const names = [".editorconfig", ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5",
    ".prettierrc.toml", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.ts", ".prettierrc.cts", ".prettierrc.mts",
    "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts", "prettier.config.cts", "prettier.config.mts", "package.json"];
  const ancillaryPaths = parents.flatMap(parent => names.map(name => parent ? `${parent}/${name}` : name));
  const policyPaths = [sourcePath, "Makefile", ".prettierignore", ...ancillaryPaths];
  const supported = async commit => {
    const original = reader.read(commit, sourcePath), make = reader.read(commit, "Makefile");
    const candidate = modelFormatInvocation(modelFormatRecipe(make?.bytes.toString()));
    if (!original?.bytes.toString().includes("make fmt") || !candidate || hash(candidate) !== contract.modelInvocationSha256) return false;
    const ignore = reader.read(commit, ".prettierignore");
    for (const file of modelCatalogPaths) {
      const scope = await inspectNativeModel(prettier, Buffer.from("{}\n"), file, options, ignore?.bytes.toString() ?? "");
      if (!scope.known) return false;
    }
    const present = metadata(["ls-tree", "-r", "--name-only", commit, "--", ...ancillaryPaths]).split("\n").filter(Boolean);
    if (present.some(file => !configPaths.includes(file) && !file.endsWith("package.json"))) return false;
    for (const file of present.filter(file => file.endsWith("package.json"))) {
      const value = JSON.parse(reader.read(commit, file).bytes.toString());
      if (Object.hasOwn(value, "prettier")) return false;
    }
    for (const file of configPaths) {
      const raw = reader.read(commit, file);
      if (!raw) return false;
      let parsed;
      try { parsed = JSON.parse(raw.bytes.toString()); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; return false; }
      const profile = modelJsonOptions(parsed);
      if (!profile || censusDigest(profile) !== contract.configSha256) return false;
    }
    return true;
  };
  const policyCommits = metadata(["log", "--first-parent", "--reverse", "--format=%H", `${baseline}..${sourceRevision}`, "--", ...policyPaths])
    .split("\n").filter(Boolean);
  if (policyCommits.length > 4000) throw new Error("Model-format source policy acquisition exceeds its budget");
  const policies = [];
  for (const commit of policyCommits) policies.push({ commit, at: date(commit), supported: await supported(commit) });
  policies.sort((a, b) => a.at.localeCompare(b.at));
  if (policies.length > 500) throw new Error("Model-format policy history exceeds its budget");
  const end = Date.parse(until), week = 7 * 86400000, endpoints = new Set([Date.parse(contract.adoption.adoptedAt), end, end - week, end - 2 * week]);
  for (let at = Date.parse(contract.adoption.adoptedAt) + week; at <= end; at += week) endpoints.add(at);
  if (endpoints.size > 100) throw new Error("Model-format endpoint budget exceeded");
  const states = [];
  for (const at of [...endpoints].sort((a, b) => a - b)) {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Missing immutable model-format endpoint");
    const ignore = reader.read(commit, ".prettierignore"), files = [];
    for (const file of modelCatalogPaths) {
      const input = reader.read(commit, file);
      const result = input ? await inspectNativeModel(prettier, input.bytes, file, options, ignore?.bytes.toString() ?? "")
        : { known: false, reason: "Source-declared model catalog does not exist at this historical endpoint." };
      files.push({ path: file, gitBlob: input?.id ?? null, ...result });
    }
    const known = files.every(file => file.known);
    states.push({ windowEnd, commit, files, known, supported: await supported(commit), ignoreGitBlob: ignore?.id ?? null,
      reason: known ? null : files.find(file => !file.known).reason });
    console.log(JSON.stringify({ windowEnd, known }));
  }
  const sources = reader.sources();
  const facts = { states, policies, probes };
  const outcomes = rows => rows.map(({ windowEnd, commit, files, known, ignoreGitBlob, reason }) =>
    ({ windowEnd, commit, files, known, ignoreGitBlob, reason }));
  if (!isDeepStrictEqual(outcomes(states), outcomes(priorFacts.states)) || !isDeepStrictEqual(probes, priorFacts.probes)
    || priorFacts.states.some((state, i) => state.supported && !states[i].supported)) {
    throw new Error("Historical profile extension must preserve every established native outcome and prior supported state");
  }
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  writeCensusJson(`${directory}/index.json`, { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sources, states: states.length,
    comparableStates: states.filter(state => state.known && state.supported).length,
    toolSha256: censusDigest(tool), acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-model-format-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } });
  return { complete: true, states: states.length, sources: sources.length };
}
if (process.argv[1] === import.meta.filename) {
  const [cache, tool, flag, ...extra] = process.argv.slice(2);
  if (!cache || !tool || extra.length || flag && flag !== "--prepare-only") throw new Error("usage: collect-model-format-history.mjs BARE_CACHE TOOL_DIRECTORY [--prepare-only]");
  console.log(JSON.stringify(await collectModelFormatHistory(cache, tool, flag === "--prepare-only")));
}
