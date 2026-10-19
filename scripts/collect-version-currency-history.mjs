import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { parseSpecTree } from "./collect-spec-condition-history.mjs";
import { stableVersion } from "./native-version-currency-value.mjs";

export const currencyTools = [
  ["claude", "DefaultClaudeCodeVersion", "npm", "@anthropic-ai/claude-code"],
  ["copilot", "DefaultCopilotVersion", "npm", "@github/copilot"],
  ["codex", "DefaultCodexVersion", "npm", "@openai/codex"],
  ["playwright", "DefaultPlaywrightCLIVersion", "npm", "@playwright/cli"],
  ["pi", "DefaultPiVersion", "npm", "@earendil-works/pi-coding-agent"],
  ["github-mcp", "DefaultGitHubMCPServerVersion", "github", "github/github-mcp-server"],
  ["mcpg", "DefaultMCPGatewayVersion", "github", "github/gh-aw-mcpg"],
  ["threat-detect", "DefaultThreatDetectVersion", "github", "github/gh-aw-threat-detection"],
].map(([id, constant, registry, name]) => ({ id, constant, registry, name, cooldownDays: id === "playwright" ? 3 : 0 }));

export function normalizePublishedVersions(entries, until) {
  if (!Number.isFinite(Date.parse(until))) throw new Error("Invalid release history cutoff");
  const byVersion = new Map();
  for (const entry of entries) {
    if (!stableVersion(entry.version)) continue;
    if (!Number.isFinite(Date.parse(entry.publishedAt))) throw new Error("Invalid stable release publication");
    const version = stableVersion(entry.version).join(".");
    const publishedAt = new Date(entry.publishedAt).toISOString().replace(".000Z", "Z");
    if (Date.parse(publishedAt) > Date.parse(until)) continue;
    if (byVersion.has(version) && byVersion.get(version).publishedAt !== publishedAt) {
      throw new Error("Ambiguous publication times for one stable version");
    }
    byVersion.set(version, { version, publishedAt });
  }
  return [...byVersion.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.version.localeCompare(b.version));
}

export function collectVersionCurrencyHistory(cache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "cli-version-checker";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/version-currency";
  const execute = (command, args, options = {}) => execFileSync(command, args,
    { encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
  const git = args => execute("git", [`--git-dir=${cache}`, ...args]);
  const metadata = args => git(args).trim();
  if (metadata(["remote", "get-url", "origin"]) !== `https://github.com/${repository}.git`) throw new Error("Version source remote mismatch");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const sourcePath = `.github/workflows/${workflowId}.md`;
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous version-workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  for (const file of [sourcePath, sourcePath.replace(/\.md$/, ".lock.yml")]) {
    if (metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]) !== `A\t${file}`) {
      throw new Error("Version-workflow adoption is not a source/compiled pair");
    }
  }
  const date = revision => new Date(metadata(["show", "-s", "--format=%cI", revision])).toISOString().replace(".000Z", "Z");
  const contract = { repository, repositoryId: 1036865607, workflowId, sourceRevision, until,
    sourceGitBlob: metadata(["rev-parse", `${sourceRevision}:${sourcePath}`]), tools: currencyTools,
    interpreterSha256: hash(readFileSync("scripts/native-version-currency-value.mjs")),
    parserSha256: hash(readFileSync("scripts/version-pin-oracle.go")),
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(directory, { recursive: true });
  const wrapper = `import { versionCurrencyModule } from "../../../../scripts/native-version-currency-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = versionCurrencyModule(${JSON.stringify(contract, null, 2)});\n`;
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) {
    if (existsSync(`${directory}/index.json`) || existsSync(`${directory}/facts.json.gz`)) {
      throw new Error("Refusing to alter frozen version function");
    }
    const previous = readFileSync(functionFile, "utf8"), archive = `${directory}/preflight/${hash(previous)}`;
    mkdirSync(archive, { recursive: true });
    writeFileSync(`${archive}/function.txt`, previous);
    writeCensusJson(`${archive}/contracts.json`, readCensusJson(`${directory}/contracts.json`));
  }
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (prepareOnly) return { prepared: workflowId, tools: currencyTools.length };
  const indexFile = `${directory}/index.json`;
  if (existsSync(indexFile)) {
    const index = readCensusJson(indexFile);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) throw new Error("Frozen version evidence changed");
    return { reused: true, states: index.states };
  }
  const acquiredAt = new Date().toISOString(), releasesFile = `${directory}/releases.json.gz`;
  const retained = existsSync(releasesFile) ? readCensusJson(releasesFile) : null;
  if (retained && retained.contractSha256 !== censusDigest(contract)) throw new Error("Official publication scope changed");
  const releases = retained?.releases ?? {};
  for (const tool of currencyTools) {
    if (releases[tool.id]) {
      if (!releases[tool.id].complete || releases[tool.id].name !== tool.name) throw new Error("Invalid retained publication history");
      continue;
    }
    let entries = [], pages = 1;
    const origin = tool.registry === "npm" ? `https://registry.npmjs.org/${encodeURIComponent(tool.name)}`
      : `https://api.github.com/repos/${tool.name}/releases`;
    if (tool.registry === "npm") {
      const times = JSON.parse(execute("npm", ["view", tool.name, "time", "--json", "--registry=https://registry.npmjs.org",
        "--fetch-timeout=60000", "--fetch-retries=1"], { timeout: 180000,
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512", NPM_CONFIG_UPDATE_NOTIFIER: "false" } }));
      if (!times || typeof times !== "object" || Array.isArray(times)) throw new Error("Unexpected official npm release metadata");
      entries = Object.entries(times).filter(([version]) => stableVersion(version))
        .map(([version, publishedAt]) => ({ version, publishedAt }));
    } else {
      let complete = false;
      for (pages = 1; pages <= 50; pages++) {
        const data = JSON.parse(execute("gh", ["api", "--method", "GET", `repos/${tool.name}/releases?per_page=100&page=${pages}`]));
        if (!Array.isArray(data)) throw new Error("Unexpected official GitHub release metadata");
        entries.push(...data.filter(row => !row.draft && !row.prerelease)
          .map(row => ({ version: row.tag_name, publishedAt: row.published_at })));
        if (data.length < 100) { complete = true; break; }
      }
      if (!complete) throw new Error("Official release history exceeds pagination budget");
    }
    releases[tool.id] = { complete: true, registry: tool.registry, name: tool.name, origin, pages, acquiredAt,
      versions: normalizePublishedVersions(entries, until) };
    writeCensusJson(releasesFile, { contractSha256: censusDigest(contract), releases });
    console.log(JSON.stringify({ tool: tool.id, releases: releases[tool.id].versions.length }));
  }
  const start = Date.parse(contract.adoption.adoptedAt), end = Date.parse(until), week = 7 * 86400000;
  const endpoints = new Set([end, end - week]);
  for (let at = start + week; at <= end; at += week) endpoints.add(at);
  const blobs = new Map();
  const states = [...endpoints].filter(at => at > start).sort((a, b) => a - b).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Missing version source endpoint");
    const files = [...parseSpecTree(git(["ls-tree", "-rz", commit, "--", "pkg/constants"])).values()]
      .filter(row => /^pkg\/constants\/[^/]+\.go$/.test(row.path) && !row.path.endsWith("_test.go"));
    if (files.length > 50 || files.some(file => !["100644", "100755"].includes(file.mode))) throw new Error("Unsupported version-source files");
    for (const file of files) {
      if (blobs.has(file.blob)) continue;
      const content = git(["show", `${commit}:${file.path}`]);
      if (createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex") !== file.blob) {
        throw new Error("Version source Git digest mismatch");
      }
      blobs.set(file.blob, { id: file.blob, content });
      if (blobs.size > 2000 || [...blobs.values()].reduce((sum, row) => sum + Buffer.byteLength(row.content), 0) > 16 * 1024 * 1024) {
        throw new Error("Version source byte budget exhausted");
      }
    }
    return { windowEnd, commit, files: files.map(row => ({ path: row.path, gitBlob: row.blob })) };
  });
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-version-oracle-"));
  try {
    const binary = path.join(temporary, "oracle");
    execute("go", ["build", "-o", binary, "scripts/version-pin-oracle.go"],
      { env: { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" } });
    const facts = JSON.parse(execute(binary, [], { input: JSON.stringify([...blobs.values()]), stdio: ["pipe", "pipe", "pipe"] }));
    if (facts.length !== blobs.size || facts.some((row, i) => row.id !== [...blobs.keys()][i])) throw new Error("Version AST parser identity mismatch");
    const parsed = new Map(facts.map(row => [row.id, row.constants]));
    for (const state of states) {
      state.constants = {};
      for (const file of state.files) {
        for (const tool of currencyTools) {
          const value = parsed.get(file.gitBlob)[tool.constant];
          if (value == null) continue;
          if (Object.hasOwn(state.constants, tool.constant)) throw new Error("Duplicate or build-dependent native version pin");
          state.constants[tool.constant] = value;
        }
      }
    }
    const evidence = { states, releases, sources: [...blobs.values()] };
    writeCensusJson(`${directory}/facts.json.gz`, evidence);
    const index = { schemaVersion: 1, complete: true, contractSha256: censusDigest(contract),
      factsSha256: censusDigest(evidence), states: states.length, sourceBlobs: blobs.size, acquiredAt, until,
      producer: { path: "scripts/collect-version-currency-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } };
    writeCensusJson(indexFile, index);
    return { complete: true, states: states.length, sourceBlobs: blobs.size };
  } finally {
    rmSync(temporary, { recursive: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  if (!process.argv[2] || process.argv.length > 4 || process.argv[3] && process.argv[3] !== "--prepare-only") {
    throw new Error("usage: collect-version-currency-history.mjs BARE_GIT_CACHE [--prepare-only]");
  }
  console.log(JSON.stringify(collectVersionCurrencyHistory(process.argv[2], process.argv[3] === "--prepare-only")));
}
