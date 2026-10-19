import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { eligibleFunctionLengthPath } from "./native-function-length-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function collectFunctionLengthHistory(cache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "lint-monster";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/function-length", sourcePath = `.github/workflows/${workflowId}.md`;
  const source = gitEvidence(repository, cache);
  const git = (args, options = {}) => source.git(args, {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, ...options });
  const metadata = args => git(args).trim();
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous lint-workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  for (const file of [sourcePath, sourcePath.replace(/\.md$/, ".lock.yml")]) {
    if (metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]) !== `A\t${file}`) {
      throw new Error("Lint-workflow adoption is not a source/compiled addition");
    }
  }
  const date = revision => new Date(metadata(["show", "-s", "--format=%cI", revision])).toISOString().replace(".000Z", "Z");
  const oracleSource = "scripts/operational-value-function-length-oracle.go";
  const rulePaths = ["Makefile", "pkg/linters/largefunc/largefunc.go",
    "pkg/linters/internal/nolint/nolint.go", "pkg/linters/internal/filecheck/filecheck.go"];
  const rules = rulePaths.map(file => {
    const id = metadata(["rev-parse", `${sourceRevision}:${file}`]), content = git(["show", `${sourceRevision}:${file}`]);
    if (createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex") !== id) {
      throw new Error("Native rule source identity mismatch");
    }
    return { path: file, gitBlob: id, sha256: hash(content), content };
  });
  const contract = { repository, workflowId, sourcePath, sourceRevision, until, directory, threshold: 60,
    sourceGitBlob: metadata(["rev-parse", `${sourceRevision}:${sourcePath}`]),
    interpreterSha256: hash(readFileSync("scripts/native-function-length-value.mjs")),
    oracleSha256: hash(readFileSync(oracleSource)), ruleSourcesSha256: censusDigest(rules),
    toolchain: execFileSync("go", ["version"], { encoding: "utf8", timeout: 30000 }).trim(),
    scope: "All tracked regular non-test non-generated cmd/pkg Go sources across platforms; raw native body spans before suppression.",
    limits: { maxStates: 100, maxFiles: 10000, maxBlobs: 20000, maxBytes: 256 * 1024 * 1024 },
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(directory, { recursive: true });
  const wrapper = `import { nativeFunctionLengthModule } from "../../../../scripts/native-function-length-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeFunctionLengthModule(${JSON.stringify(contract, null, 2)});\n`;
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen native function-length definition");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  writeCensusJson(`${directory}/rules.json.gz`, rules);
  if (prepareOnly) return { prepared: workflowId, sourceFacet: contract.scope };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) {
      throw new Error("Frozen native function-length acquisition changed");
    }
    return { reused: true, states: index.states, sourceBlobs: index.sourceBlobs };
  }
  const week = 7 * 86400000, end = Date.parse(until), endpoints = new Set([end, end - week]);
  for (let at = Date.parse(contract.adoption.adoptedAt) + week; at <= end; at += week) endpoints.add(at);
  if (endpoints.size > contract.limits.maxStates) throw new Error("Native function-length endpoint budget exceeded");
  const states = [...endpoints].sort((a, b) => a - b).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Native source endpoint has no immutable commit");
    const entries = git(["ls-tree", "-r", "-z", commit, "--", "cmd", "pkg"]).split("\0").filter(Boolean);
    const files = entries.map(entry => {
      const match = entry.match(/^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/s);
      if (!match) throw new Error("Invalid native Go source tree entry");
      return { mode: match[1], type: match[2], gitBlob: match[3], path: match[4] };
    }).filter(file => eligibleFunctionLengthPath(file.path));
    if (!files.length || files.length > contract.limits.maxFiles
      || files.some(file => file.mode !== "100644" || file.type !== "blob")) throw new Error("Unsupported or over-budget native Go source cohort");
    return { windowEnd, commit, complete: true, files: files.map(({ path, gitBlob }) => ({ path, gitBlob })) };
  });
  const binary = path.join(cache, "function-length-oracle");
  execFileSync("go", ["build", "-o", binary, oracleSource], { timeout: 120000 });
  let analyzed = 0;
  const measured = source.features(states.flatMap(state => state.files.map(file => file.gitBlob)), batch => {
    const output = execFileSync(binary, [], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
      input: batch.map(value => JSON.stringify(value)).join("\n") + "\n" });
    const facts = output.trim().split("\n").map(line => JSON.parse(line));
    for (let i = 0; i < facts.length; i++) if (facts[i].contentSha256 !== hash(batch[i].content)) {
      throw new Error("Native function-length oracle source digest mismatch");
    }
    analyzed += facts.length;
    console.log(JSON.stringify({ analyzedNativeBlobs: analyzed }));
    return facts;
  }, { maxBlobs: contract.limits.maxBlobs, maxBytes: contract.limits.maxBytes });
  const facts = { states, features: [...measured.features.values()] };
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  const index = { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), rulesSha256: censusDigest(rules),
    states: states.length, sourceBlobs: measured.uniqueBlobs, sourceBytes: measured.totalBytes,
    acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-function-length-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } };
  writeCensusJson(`${directory}/index.json`, index);
  return { complete: true, states: states.length, sourceBlobs: measured.uniqueBlobs };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, flag, ...extra] = process.argv.slice(2);
  if (!cache || extra.length || flag && flag !== "--prepare-only") {
    throw new Error("usage: collect-function-length-history.mjs BARE_CACHE [--prepare-only]");
  }
  console.log(JSON.stringify(collectFunctionLengthHistory(cache, flag === "--prepare-only")));
}
