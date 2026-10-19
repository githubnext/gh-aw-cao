import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { normalizeNativeSpellingReport, spellingPath } from "./native-spelling-value.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function nativeSpellingTool(toolDirectory) {
  const lockBytes = readFileSync(path.join(toolDirectory, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  for (const name of ["cspell", "cspell-lib", "@cspell/cspell-json-reporter"]) {
    if (JSON.parse(readFileSync(path.join(toolDirectory, "node_modules", name, "package.json"), "utf8")).version !== "8.19.4") {
      throw new Error("Native spelling tool version mismatch");
    }
  }
  const files = [];
  let bytes = 0;
  const walk = relative => {
    for (const entry of readdirSync(path.join(toolDirectory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink() && relative === "node_modules/.bin") continue;
      else if (!entry.isFile()) throw new Error("Unsupported native spelling tool entry");
      else {
        const value = readFileSync(path.join(toolDirectory, file));
        bytes += value.length;
        if (files.length >= 10000 || bytes > 128 * 1024 * 1024) throw new Error("Native spelling tool closure budget exceeded");
        files.push({ path: file, sha256: hash(value) });
      }
    }
  };
  walk("node_modules");
  return { lock, identity: { checker: "cspell", version: "8.19.4", reporterVersion: "8.19.4",
    node: process.version, platform: process.platform, arch: process.arch,
    jq: execFileSync("jq", ["--version"], { encoding: "utf8", timeout: 15000 }).trim(),
    lockSha256: hash(lockBytes), installedFilesSha256: censusDigest(files), installedFiles: files.length, installedBytes: bytes } };
}

export function nativeSpellingConfig(raw, dictionaryPath) {
  const allowed = new Set(["version", "language", "enabledLanguageIds", "ignorePaths", "dictionaryDefinitions", "dictionaries"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))
    || raw.version !== "0.2" || raw.language !== "en-US"
    || JSON.stringify(raw.enabledLanguageIds) !== JSON.stringify(["markdown", "mdx"])
    || JSON.stringify(raw.ignorePaths) !== JSON.stringify(["**/node_modules/**", "**/.git/**"])) {
    throw new Error("Unsupported native spelling configuration; review its policy before replay");
  }
  return { ...raw, dictionaryDefinitions: dictionaryPath ? [{ name: "workflow-dictionary", path: dictionaryPath, addWords: true }] : [],
    dictionaries: dictionaryPath ? ["en", "en-US", "workflow-dictionary"] : ["en", "en-US"] };
}

export function runNativeSpelling(toolDirectory, config, sources) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cao-native-spelling-"));
  try {
    const home = path.join(root, "home");
    mkdirSync(home);
    const write = (file, bytes) => {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    };
    for (const source of sources) {
      if (!spellingPath(source.path) && source.path !== "dictionary.txt") throw new Error("Unsafe native spelling input path");
      write(source.path, source.bytes);
    }
    const paths = sources.filter(source => spellingPath(source.path)).map(source => source.path).sort();
    write("cspell-runtime.json", JSON.stringify(config));
    write("files.txt", paths.map(file => path.join(root, file)).join("\n") + (paths.length ? "\n" : ""));
    if (!paths.length) return { valid: true, complete: true, paths: [], filesChecked: 0, issues: [] };
    const result = spawnSync(process.execPath, [path.join(toolDirectory, "node_modules/cspell/bin.mjs"), "lint",
      "--no-progress", "--no-summary", "--show-suggestions", "--no-cache", "--no-gitignore",
      "--reporter", path.join(toolDirectory, "node_modules/@cspell/cspell-json-reporter/dist/esm/index.js"),
      "--config", path.join(root, "cspell-runtime.json"), "--file-list", path.join(root, "files.txt")], {
      cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
        TMPDIR: root, LANG: "en_US.UTF-8", TZ: "UTC", NO_COLOR: "1" },
    });
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error(`Native spelling process failed (${result.error?.code ?? result.status ?? "signal"}).`);
    }
    const report = JSON.parse(result.stdout);
    if ((result.status === 0) !== (report.issues?.length === 0)) throw new Error("Native spelling exit status contradicts its JSON report");
    const normalized = normalizeNativeSpellingReport(report, paths, root);
    const sourceFilterCount = Number(execFileSync("jq",
      ["[.. | objects | select(has(\"issues\")) | .issues[]? | select((.isFlagged // true) == true)] | length"],
      { input: result.stdout, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }).trim());
    if (sourceFilterCount !== normalized.issues.length) throw new Error("Native workflow filter does not preserve the complete checker issue cohort");
    return { ...normalized, sourceFilterCount };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function collectSpellingHistory(cache, toolDirectory, prepareOnly = false, extendContext = false) {
  const repository = "github/gh-aw", workflowId = "daily-astrostylelite-markdown-spellcheck";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/native-spelling", sourcePath = `.github/workflows/${workflowId}.md`;
  const execute = (args, options = {}) => execFileSync("git", [`--git-dir=${cache}`, ...args], { encoding: "utf8",
    timeout: 45000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, ...options });
  const metadata = args => execute(args).trim();
  let reader = publicGitSourceReader(cache, repository), readCount = 0, totalBytes = 0;
  const sources = new Map();
  const read = (commit, file, expected) => {
    if (expected && sources.has(expected)) return { ...sources.get(expected), path: file };
    if (readCount && readCount % 100 === 0) reader = publicGitSourceReader(cache, repository);
    const value = reader.read(commit, file);
    if (!value) return null;
    if (expected && expected !== value.id) throw new Error("Native spelling source tree mismatch");
    if (!sources.has(value.id)) {
      readCount++;
      totalBytes += value.bytes.length;
      if (readCount > 6000 || totalBytes > 256 * 1024 * 1024) throw new Error("Native spelling source budget exhausted");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
      sources.set(value.id, { ...value, text });
    }
    return { ...sources.get(value.id), path: file };
  };
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous spelling workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  for (const file of [sourcePath, sourcePath.replace(/\.md$/, ".lock.yml")]) {
    if (metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]) !== `A\t${file}`) {
      throw new Error("Spelling adoption is not an actual source/compiled addition");
    }
  }
  const date = commit => new Date(metadata(["show", "-s", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
  const configSource = read(sourceRevision, "docs/.cspell.docs.json");
  if (!configSource) throw new Error("Native spelling configuration is absent");
  let dictionary = null;
  for (const file of ["docs/.cspell-words.txt", "docs/.spellcheck-ignore.txt",
    ".cspell-words.txt", ".spellcheck-ignore.txt", ".github/spellcheck-ignore.txt"]) {
    dictionary = read(sourceRevision, file);
    if (dictionary) break;
  }
  const config = nativeSpellingConfig(JSON.parse(configSource.text), dictionary ? "./dictionary.txt" : null);
  const tool = nativeSpellingTool(toolDirectory);
  const contract = { repository, workflowId, sourceRevision, until, sourcePath, directory,
    sourceGitBlob: metadata(["rev-parse", `${sourceRevision}:${sourcePath}`]),
    interpreterSha256: hash(readFileSync("scripts/native-spelling-value.mjs")),
    sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
    tool: tool.identity, configuration: { gitBlob: configSource.id, sha256: configSource.sha256, runtimeSha256: censusDigest(config) },
    dictionary: dictionary ? { path: dictionary.path, gitBlob: dictionary.id, sha256: dictionary.sha256 } : null,
    policy: "Frozen cutoff-native CSpell configuration and selected technical dictionary across all historical source endpoints; changing in-document waivers are not comparable repairs.",
    limits: { states: 100, filesPerState: 2000, sourceBlobs: 6000, sourceBytes: 256 * 1024 * 1024 },
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(`${directory}/sources`, { recursive: true });
  mkdirSync(`${directory}/checks`, { recursive: true });
  const wrapper = `import { nativeSpellingModule } from "../../../../scripts/native-spelling-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeSpellingModule(${JSON.stringify(contract, null, 2)});\n`;
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen native spelling definition");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  writeCensusJson(`${directory}/tool-lock.json.gz`, tool.lock);
  if (prepareOnly) return { prepared: workflowId, checker: tool.identity, dictionary: contract.dictionary };
  let previousIndex = null, previousFacts = null;
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    const facts = readCensusJson(`${directory}/facts.json.gz`, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)) {
      throw new Error("Retained native spelling acquisition changed");
    }
    if (!extendContext || index.comparisonContextExtension) return { reused: true, states: index.states };
    const version = hash(readFileSync(functionFile));
    const preserved = readCensusJson(`${directory}/versions/${version}/archive.json.gz`,
      { maxDecodedBytes: 128 * 1024 * 1024, maxParts: 1024 });
    const originalIndex = preserved.files?.find(file => file.path === "index.json");
    const originalProducer = preserved.files?.find(file => file.path === "producer.txt");
    if (!originalIndex || !originalProducer || originalIndex.sha256 !== hash(Buffer.from(originalIndex.content, "base64"))
      || originalProducer.sha256 !== index.producer.sha256
      || originalProducer.sha256 !== hash(Buffer.from(originalProducer.content, "base64"))
      || censusDigest(JSON.parse(Buffer.from(originalIndex.content, "base64"))) !== censusDigest(index)) {
      throw new Error("Comparison-context extension requires the verified preserved predecessor");
    }
    previousIndex = index;
    previousFacts = facts;
  }
  if (extendContext && !previousIndex) throw new Error("Comparison-context extension has no preserved original acquisition");
  const nativeDirectives = await import(pathToFileURL(path.join(toolDirectory, "node_modules/cspell-lib/dist/lib/Settings/InDocSettings.js")).href);
  const inlinePolicy = text => {
    const settings = nativeDirectives.getInDocumentSettings(text);
    const ranges = [nativeDirectives.regExSpellingGuardBlock, nativeDirectives.regExSpellingGuardNext,
      nativeDirectives.regExSpellingGuardLine].flatMap(pattern => [...text.matchAll(pattern)].map(match => hash(match[0])));
    const encoded = JSON.stringify({ settings, ranges }, (_key, value) => value instanceof RegExp ? value.toString() : value);
    return encoded === '{"settings":{"id":"in-doc-settings"},"ranges":[]}' ? null : hash(encoded);
  };
  const week = 7 * 86400000, end = Date.parse(until), start = Date.parse(contract.adoption.adoptedAt);
  const endpoints = new Set([start, end, end - week, end - 2 * week]);
  for (let at = start + week; at <= end; at += week) endpoints.add(at);
  if (endpoints.size > contract.limits.states) throw new Error("Native spelling endpoint budget exhausted");
  const probeText = "This is a missspellled sentence.\n";
  const probe = runNativeSpelling(toolDirectory, config,
    [{ path: "docs/src/content/probe.md", bytes: Buffer.from(probeText) }]);
  if (probe.issues.length !== 1 || probe.issues[0].word !== "missspellled" || probe.issues[0].flagged !== false) {
    throw new Error("Pinned native spelling checker failed the ordinary-unknown-word counterexample");
  }
  writeCensusJson(`${directory}/probe.json.gz`, { sourceSha256: hash(probeText), native: probe });
  const states = [];
  for (const at of [...endpoints].sort((a, b) => a - b)) {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Native spelling endpoint has no immutable commit");
    const entries = execute(["ls-tree", "-r", "-z", commit, "--", "docs/src/content"]).split("\0").filter(Boolean);
    const files = entries.map(entry => {
      const match = entry.match(/^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/s);
      if (!match) throw new Error("Malformed native spelling source tree");
      return { mode: match[1], type: match[2], gitBlob: match[3], path: match[4] };
    }).filter(file => /\.(?:md|mdx)$/.test(file.path) && file.mode !== "120000");
    if (files.length > contract.limits.filesPerState || files.some(file => file.mode !== "100644"
      || file.type !== "blob" || !spellingPath(file.path))) throw new Error("Unsupported native spelling source cohort");
    const missing = [...new Set(files.map(file => file.gitBlob))].filter(id => !sources.has(id));
    if (sources.size + missing.length > contract.limits.sourceBlobs) throw new Error("Native spelling source budget exhausted");
    for (let at = 0; at < missing.length; at += 128) {
      execute(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "--stdin"],
        { input: missing.slice(at, at + 128).join("\n") + "\n" });
    }
    const inputs = files.map(file => read(commit, file.path, file.gitBlob));
    const scopeSha256 = censusDigest(files);
    const policies = inputs.map(input => ({ path: input.path, policy: inlinePolicy(input.text) })).filter(input => input.policy);
    const inlinePolicySha256 = censusDigest(policies), checkFile = `${directory}/checks/${commit}.json.gz`;
    let native;
    if (existsSync(checkFile)) {
      const retained = readCensusJson(checkFile);
      if (retained.contractSha256 !== censusDigest(contract) || retained.scopeSha256 !== scopeSha256
        || retained.nativeSha256 !== censusDigest(retained.native)) throw new Error("Retained native spelling check changed");
      native = retained.native;
    } else {
      native = runNativeSpelling(toolDirectory, config, [...inputs,
        ...(dictionary ? [{ path: "dictionary.txt", bytes: dictionary.bytes }] : [])]);
      writeCensusJson(checkFile, { contractSha256: censusDigest(contract), scopeSha256, nativeSha256: censusDigest(native), native });
    }
    states.push({ windowEnd, commit, scopeSha256, inlinePolicySha256, files, native });
    for (const input of [...inputs, configSource, ...(dictionary ? [dictionary] : [])]) {
      const file = `${directory}/sources/${input.id}.json.gz`;
      const record = { id: input.id, native: input.native, lfs: input.lfs, sha256: input.sha256,
        content: input.bytes.toString("base64") };
      if (existsSync(file) && censusDigest(readCensusJson(file)) !== censusDigest(record)) throw new Error("Retained spelling source changed");
      if (!existsSync(file)) writeCensusJson(file, record);
    }
    console.log(JSON.stringify({ windowEnd, files: native.filesChecked, nativeIssues: native.issues.length }));
  }
  const facts = { states };
  if (previousFacts && previousFacts.states.some(prior =>
    !states.some(state => state.windowEnd === prior.windowEnd && censusDigest(state) === censusDigest(prior)))) {
    throw new Error("Comparison-context extension changed an established native observation");
  }
  writeJsonArchive(`${directory}/facts.json.gz`, facts, { spacing: 0, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const index = { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), states: states.length,
    probeSha256: censusDigest(readCensusJson(`${directory}/probe.json.gz`)), toolLockSha256: censusDigest(tool.lock),
    ...(previousIndex ? { comparisonContextExtension: { previousIndexSha256: censusDigest(previousIndex),
      previousFactsSha256: previousIndex.factsSha256,
      policy: "Additional prior comparison endpoint; frozen function and every established observation remain unchanged." } } : {}),
    sourceBlobs: sources.size, sourceBytes: totalBytes, acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-spelling-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } };
  writeCensusJson(`${directory}/index.json`, index);
  return { complete: true, states: states.length, sourceBlobs: sources.size };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, tool, flag, ...extra] = process.argv.slice(2);
  if (!cache || !tool || extra.length || flag && !["--prepare-only", "--extend-comparison-context"].includes(flag)) {
    throw new Error("usage: collect-spelling-history.mjs BARE_CACHE PINNED_CSPELL_DIRECTORY [--prepare-only|--extend-comparison-context]");
  }
  console.log(JSON.stringify(await collectSpellingHistory(cache, tool, flag === "--prepare-only", flag === "--extend-comparison-context")));
}
