import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { instructionLineLimit, instructionSizePolicy } from "./native-instruction-size-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function nativeInstructionLineCount(bytes, binary = "/usr/bin/wc") {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) throw new Error("Instruction input exceeds the native count budget");
  const text = execFileSync(binary, ["-l"], { input: bytes, encoding: "utf8", maxBuffer: 1024, timeout: 10000 }).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid native wc result");
  return Number(text);
}

export function directInstructionEntries(tree) {
  if (typeof tree !== "string") throw new Error("Instruction tree must be native ls-tree output");
  const files = [];
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = entry.match(/^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("Unsupported native instruction tree entry");
    if (!/^\.github\/aw\/[^./][^/]*\.md$/.test(match[3])) continue;
    if (match[1] !== "100644" || !/^[A-Za-z0-9_./-]+$/.test(match[3])) {
      return { known: false, reason: "Direct instruction mode or filename is outside the immutable reader's supported profile.", files: [] };
    }
    files.push({ path: match[3], gitBlob: match[2] });
  }
  if (files.length > 1000) throw new Error("Instruction population exceeds its frozen budget");
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Duplicate native instruction path");
  return { known: true, files };
}

export function collectInstructionSizeHistory(cache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "instructions-janitor";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/instruction-size", sourcePath = `.github/workflows/${workflowId}.md`;
  let reader = publicGitSourceReader(cache, repository), reads = 0, retainedBytes = 0;
  const metadata = reader.metadata, retainedSources = new Map();
  const retainSources = () => {
    for (const source of reader.sources()) {
      const sha256 = censusDigest(source), prior = retainedSources.get(source.id);
      if (prior && prior.sha256 !== sha256) throw new Error("Conflicting immutable instruction source");
      if (prior) continue;
      retainedBytes += Buffer.byteLength(JSON.stringify(source));
      if (retainedSources.size >= 10000 || retainedBytes > 128 * 1024 * 1024) throw new Error("Instruction source archive exceeds its budget");
      writeCensusJson(`${directory}/sources/${source.id}.json.gz`, source);
      retainedSources.set(source.id, { gitBlob: source.id, sha256 });
    }
  };
  const read = (commit, file) => {
    if (reads >= 200) {
      retainSources();
      reader = publicGitSourceReader(cache, repository);
      reads = 0;
    }
    reads++;
    return reader.read(commit, file);
  };
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous instruction workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  if (metadata(["ls-tree", "-r", baseline, "--", sourcePath])) throw new Error("Instruction source adoption is not a true addition");
  const date = revision => {
    const timestamp = metadata(["cat-file", "commit", revision]).match(/^committer .+> (\d+) [+-]\d{4}$/m)?.[1];
    if (!timestamp) throw new Error("Missing immutable instruction commit timestamp");
    return new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z");
  };
  const source = read(sourceRevision, sourcePath), binary = "/usr/bin/wc", toolBytes = readFileSync(binary);
  if (instructionSizePolicy(source?.bytes.toString())?.limit !== instructionLineLimit) throw new Error("Frozen instruction goal does not declare the expected audit ceiling");
  const contract = { repository, workflowId, sourcePath, sourceRevision, until, directory, sourceGitBlob: source.id,
    lineLimit: instructionLineLimit, scope: ".github/aw/*.md", interpreterSha256: hash(readFileSync("scripts/native-instruction-size-value.mjs")),
    sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
    tool: { command: "wc -l", binary, sha256: hash(toolBytes), size: toolBytes.length, platform: process.platform, architecture: process.arch },
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(`${directory}/sources`, { recursive: true });
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const wrapper = `import { nativeInstructionSizeModule } from "../../../../scripts/native-instruction-size-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeInstructionSizeModule(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen instruction-size function");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (prepareOnly) return { prepared: workflowId, adoption: contract.adoption.adoptedAt };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) throw new Error("Frozen instruction acquisition changed");
    for (const source of index.sources) if (censusDigest(readCensusJson(`${directory}/sources/${source.gitBlob}.json.gz`)) !== source.sha256) {
      throw new Error("Retained instruction source changed");
    }
    return { reused: true, states: index.states, sources: index.sources.length };
  }
  const probes = [Buffer.alloc(0), Buffer.from("unterminated"), Buffer.from("one\n"), Buffer.from("one\r\ntwo\r\n"),
    Buffer.from("\n\n"), Buffer.from("a\nb"), Buffer.from("x\n".repeat(400)), Buffer.from("x\n".repeat(401))].map(bytes => {
    const lines = nativeInstructionLineCount(bytes, binary), expected = [...bytes].filter(byte => byte === 10).length;
    if (lines !== expected) throw new Error("Native instruction line-count probe failed");
    return { bytes: bytes.toString("base64"), sha256: hash(bytes), lines };
  });
  const policies = metadata(["log", "--first-parent", "--reverse", "--format=%H", `${baseline}..${sourceRevision}`, "--", sourcePath])
    .split("\n").filter(Boolean).map(commit => {
      const source = read(commit, sourcePath);
      return { commit, at: date(commit), sourceGitBlob: source?.id ?? null, policy: instructionSizePolicy(source?.bytes.toString()) };
    }).sort((a, b) => a.at.localeCompare(b.at) || a.commit.localeCompare(b.commit));
  if (policies.length > 500) throw new Error("Instruction policy history exceeds its budget");
  const end = Date.parse(until), week = 7 * 86400000;
  const endpoints = new Set([Date.parse(contract.adoption.adoptedAt), end, end - week, end - 2 * week]);
  for (let at = Date.parse(contract.adoption.adoptedAt) + week; at <= end; at += week) endpoints.add(at);
  if (endpoints.size > 100) throw new Error("Instruction endpoint budget exceeded");
  const features = new Map();
  const states = [...endpoints].sort((a, b) => a - b).map(at => {
    const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
    const commit = metadata(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, sourceRevision]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Instruction endpoint lacks an immutable mainline revision");
    const source = read(commit, sourcePath);
    const entries = directInstructionEntries(metadata(["ls-tree", "-rz", commit, "--", ".github/aw"]));
    const files = entries.known ? entries.files.map(file => {
      const input = read(commit, file.path);
      if (!input || input.id !== file.gitBlob) throw new Error("Instruction tree/blob identity mismatch");
      if (!features.has(input.id)) features.set(input.id, nativeInstructionLineCount(input.bytes, binary));
      return { ...file, lines: features.get(input.id), sha256: hash(input.bytes) };
    }) : [];
    console.log(JSON.stringify({ windowEnd, files: files.length, uniqueInputs: features.size }));
    return { windowEnd, commit, sourceGitBlob: source?.id ?? null, policy: instructionSizePolicy(source?.bytes.toString()),
      known: entries.known, reason: entries.reason ?? null, files };
  });
  retainSources();
  const sources = [...retainedSources.values()];
  const facts = { states, policies, probes };
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  writeCensusJson(`${directory}/index.json`, { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sources, states: states.length, features: features.size,
    comparableStates: states.filter(state => state.known && state.files.length && state.policy?.limit === instructionLineLimit).length,
    tool: contract.tool, acquiredAt: new Date().toISOString(),
    producer: { path: "scripts/collect-instruction-size-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } });
  return { complete: true, states: states.length, sources: sources.length, features: features.size };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, flag, ...extra] = process.argv.slice(2);
  if (!cache || extra.length || flag && flag !== "--prepare-only") throw new Error("usage: collect-instruction-size-history.mjs BARE_CACHE [--prepare-only]");
  console.log(JSON.stringify(collectInstructionSizeHistory(cache, flag === "--prepare-only")));
}
