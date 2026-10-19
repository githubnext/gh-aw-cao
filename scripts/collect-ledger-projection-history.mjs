import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { localCheckerDependencies } from "./author-host-assertion-functions.mjs";
import { safeLedgerFixture } from "./ledger-projection-oracle.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { parseSpecTree } from "./collect-spec-condition-history.mjs";

export function collectLedgerProjectionHistory(cache, prepareOnly = false) {
  const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/ledger-projections";
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  const metadata = args => git(args).trim();
  if (metadata(["remote", "get-url", "origin"]) !== "https://github.com/github/gh-aw.git") throw new Error("Unexpected ledger source remote");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const fileHash = filename => hash(readFileSync(filename));
  const base = "actions/setup/js", pending = ["ledger_store.cjs", "ledger_builtin.cjs", "ledger_replay.cjs"], sources = new Map();
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  const permitted = new Set(["node:crypto", "node:fs", "node:path", "node:util", "node:sqlite", "node:string_decoder"]);
  while (pending.length) {
    const file = pending.pop();
    if (sources.has(file)) continue;
    if (!/^[a-z0-9_-]+\.cjs$/.test(file) || sources.size >= 30) throw new Error("Unsupported native ledger dependency");
    const text = git(["show", `${revision}:${base}/${file}`]);
    sources.set(file, { file, path: `${base}/${file}`, gitBlob: metadata(["rev-parse", `${revision}:${base}/${file}`]),
      sha256: hash(text), text });
    if ([...sources.values()].reduce((sum, row) => sum + Buffer.byteLength(row.text), 0) > 2 * 1024 * 1024) {
      throw new Error("Native ledger source budget exhausted");
    }
    for (const requested of localCheckerDependencies(text)) {
      const builtin = requested.startsWith("node:") ? requested : `node:${requested}`;
      if (builtins.has(requested)) {
        if (!permitted.has(builtin)) throw new Error(`Unreviewed native ledger builtin: ${requested}`);
        continue;
      }
      if (!/^\.\/[a-z0-9_-]+\.cjs$/.test(requested)) throw new Error(`Unreviewed native ledger dependency: ${requested}`);
      pending.push(requested.slice(2));
    }
  }
  mkdirSync(directory, { recursive: true });
  const nativeSources = [...sources.values()].map(({ text: _, ...source }) => source);
  writeCensusJson(`${directory}/native-sources.json.gz`, { revision, sources: [...sources.values()] });
  if (prepareOnly) return { nativeSources: nativeSources.length };
  const contracts = [];
  for (const [workflowId, ledgerName, name, limitation] of [
    ["smoke-builtin-ledgers", "log", "Smoke Built-in Ledgers",
      "Partial append-only log facet; set/map/table/counter/notes operations and actual historical agent inspection are not established."],
    ["smoke-repo-memory-ledger", "smoke", "Smoke Repo-Memory Ledger",
      "Partial durable table-upsert round-trip facet; actual historical agent inspection and unrelated ledger diagnostics are not established."],
  ]) {
    const sourcePath = `.github/workflows/${workflowId}.md`, execution = sourcePath.replace(/\.md$/, ".lock.yml");
    const source = git(["show", `${revision}:${sourcePath}`]);
    const frontmatter = parse(source.slice(4, source.indexOf("\n---", 4)));
    const config = { name: ledgerName, max_segment_kb: 100, ...frontmatter.tools.ledger[ledgerName] };
    if (!(config.type === "log" && ledgerName === "log"
      || config.type === "table" && config.key === "workflow_run_id" && ledgerName === "smoke")) throw new Error("Ledger intent changed");
    const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", revision, "--", sourcePath]).split("\n");
    if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous ledger workflow adoption");
    const commit = additions[0], parent = metadata(["rev-parse", `${commit}^`]);
    for (const file of [sourcePath, execution]) {
      if (metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", parent, commit, "--", file]) !== `A\t${file}`) {
        throw new Error("Ledger adoption is not a true source/compiled-workflow addition");
      }
    }
    const date = commit => new Date(metadata(["show", "-s", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
    const contract = { repository: "github/gh-aw", repositoryId: 1036865607, workflowId, ledgerName, name,
      sourceRevision: revision, sourceGitBlob: metadata(["rev-parse", `${revision}:${sourcePath}`]), until, config,
      goal: "Preserve source-defined run fixtures as correctly replayable durable ledger state.",
      acceptance: "The pinned production canonical reconstruction, built-in reducer and SQLite materializer restore the independent expected fixture rows exactly in a read-only database.",
      limitation, nativeSources, interpreterSha256: fileHash("scripts/native-ledger-projection-value.mjs"),
      oracleSha256: fileHash("scripts/ledger-projection-oracle.mjs"),
      adoption: { commit, adoptedAt: date(commit), baselineCommit: parent, baselineAt: date(parent) } };
    const module = `import { ledgerProjectionModule } from "../../../../scripts/native-ledger-projection-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = ledgerProjectionModule(${JSON.stringify(contract, null, 2)});\n`;
    const target = `docs/operational-value/proof/functions/${workflowId}.mjs`;
    if (existsSync(target) && readFileSync(target, "utf8") !== module) throw new Error("Refusing to change frozen ledger function");
    writeFileSync(target, module);
    contracts.push(contract);
  }
  writeCensusJson(`${directory}/contracts.json`, contracts);
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-native-ledger-"));
  let decodedBytes = 0;
  try {
    const nativeDirectory = path.join(temporary, "native");
    mkdirSync(nativeDirectory);
    for (const source of sources.values()) writeFileSync(path.join(nativeDirectory, source.file), source.text);
    const blobsFile = `${directory}/fixture-blobs.json.gz`;
    const blobs = new Map((existsSync(blobsFile) ? readCensusJson(blobsFile) : []).map(({ gitBlob, text }) => {
      if (typeof text !== "string" || !/^[a-f0-9]{40}$/.test(gitBlob)
        || createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex") !== gitBlob) {
        throw new Error("Retained ledger fixture bytes changed");
      }
      const lines = text.split("\n");
      if (lines.pop() !== "" || !lines.every(line => contracts.some(contract => safeLedgerFixture(JSON.parse(line), contract.config)))) {
        throw new Error("Retained ledger fixture exceeds the safe projection scope");
      }
      return [gitBlob, text];
    }));
    for (const contract of contracts) {
      const indexPath = `${directory}/${contract.workflowId}-index.json`;
      if (existsSync(indexPath)) {
        const index = readCensusJson(indexPath);
        if (!index.complete || index.contractSha256 !== censusDigest(contract)
          || !/^[a-z0-9-]+-states\.json\.gz$/.test(index.statesFile)
          || censusDigest(readCensusJson(`${directory}/${index.statesFile}`)) !== index.statesSha256) {
          throw new Error("Retained native ledger acquisition changed");
        }
        console.log(JSON.stringify({ workflowId: contract.workflowId, reused: true, states: index.states }));
        continue;
      }
      const ref = `refs/cao-ledgers/${contract.ledgerName}`;
      const commits = metadata(["log", "--first-parent", "--reverse", "--max-count=1001", "--format=%H", ref]).split("\n");
      if (commits.length > 1000 || !/^[a-f0-9]{40}$/.test(commits[0])
        || git(["cat-file", "-p", commits[0]]).split("\n\n")[0].split("\n").some(line => line.startsWith("parent "))) {
        throw new Error("Ledger lineage exceeds budget or starts at a shallow boundary");
      }
      const states = [];
      for (const commit of commits) {
        const at = new Date(metadata(["show", "-s", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
        if (at >= until) continue;
        if (states.length && at < states.at(-1).at) throw new Error("Nonmonotonic ledger commit dates cannot establish historical endpoints");
        const tree = parseSpecTree(git(["ls-tree", "-rz", commit, "--", "ledger/shards", "ledger/coverage"]));
        if (tree.size > 1024) throw new Error("Native ledger file budget exhausted");
        const state = { commit, at, files: [], result: null };
        const memory = path.join(temporary, `${contract.ledgerName}-${commit}`);
        mkdirSync(path.join(memory, "ledger/shards"), { recursive: true });
        let gap = null;
        for (const entry of tree.values()) {
          if (!/^ledger\/shards\/[a-f0-9-]{36}\.jsonl$/.test(entry.path)
            || !["100644", "100755"].includes(entry.mode)) { gap = "Unsupported canonical ledger file or compaction coverage."; break; }
          const text = blobs.get(entry.blob) ?? git(["show", `${commit}:${entry.path}`]);
          if (!blobs.has(entry.blob)) {
            decodedBytes += Buffer.byteLength(text);
            if (decodedBytes > 64 * 1024 * 1024 || Buffer.byteLength(text) > 100 * 1024) throw new Error("Native ledger byte budget exhausted");
          }
          const lines = text.split("\n");
          if (lines.pop() !== "") { gap = "Incomplete canonical ledger line."; break; }
          let records;
          try { records = lines.map(line => JSON.parse(line)); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            gap = "Invalid canonical ledger JSON."; break;
          }
          if (!records.every(record => safeLedgerFixture(record, contract.config))) {
            gap = "Historical records do not match the frozen safe fixture facet."; break;
          }
          blobs.set(entry.blob, text);
          writeFileSync(path.join(memory, entry.path), text);
          state.files.push({ path: entry.path, gitBlob: entry.blob });
        }
        state.result = gap ? { status: "unavailable", reason: gap }
          : JSON.parse(execFileSync(process.execPath, ["scripts/ledger-projection-oracle.mjs",
            nativeDirectory, memory, JSON.stringify(contract.config)], { encoding: "utf8", timeout: 15000,
            maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: temporary, NODE_NO_WARNINGS: "1" } }));
        states.push(state);
      }
      const statesFile = `${contract.workflowId}-states.json.gz`;
      writeCensusJson(`${directory}/${statesFile}`, states);
      writeCensusJson(blobsFile, [...blobs].map(([gitBlob, text]) => ({ gitBlob, text })));
      const index = { schemaVersion: 1, complete: true, workflowId: contract.workflowId,
        contractSha256: censusDigest(contract), statesFile, statesSha256: censusDigest(states), states: states.length,
        acquiredAt: new Date().toISOString(), sourceRevision: revision, until,
        producer: { path: "scripts/collect-ledger-projection-history.mjs", sha256: fileHash(import.meta.filename) } };
      writeCensusJson(indexPath, index);
      console.log(JSON.stringify({ workflowId: contract.workflowId, states: states.length,
        available: states.filter(row => row.result.status === "available").length,
        latest: states.at(-1)?.result }));
    }
    writeCensusJson(blobsFile, [...blobs].map(([gitBlob, text]) => ({ gitBlob, text })));
  } finally {
    rmSync(temporary, { recursive: true });
  }
  return { complete: true, workflows: contracts.length };
}

if (process.argv[1] === import.meta.filename) {
  if (!process.argv[2] || process.argv.length > 4 || process.argv[3] && process.argv[3] !== "--prepare-only") {
    throw new Error("usage: collect-ledger-projection-history.mjs BARE_GIT_CACHE [--prepare-only]");
  }
  console.log(JSON.stringify(collectLedgerProjectionHistory(process.argv[2], process.argv[3] === "--prepare-only")));
}
