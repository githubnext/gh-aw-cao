import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDocument, visit } from "yaml";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { HostLogEvidenceGap, readProtectedHostLog } from "./protected-host-log.mjs";
import { assessChoiceReceipt, projectChoicePayload } from "./native-choice-value.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
class ChoiceEvidenceGap extends Error {}
const parseYaml = content => {
  const document = parseDocument(content, { strict: true, uniqueKeys: true });
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (document.errors.length || document.warnings.length || alias) throw new ChoiceEvidenceGap("Unsupported workflow YAML profile.");
  return document.toJS({ maxAliasCount: 0 });
};
export function choiceSourceProfile(source, compiled) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new ChoiceEvidenceGap("No exact choice task/frontmatter boundary.");
  const config = parseYaml(match[1]), workflow = parseYaml(compiled), job = workflow.jobs?.test_environment;
  const inputs = config["safe-outputs"]?.jobs?.test_environment?.inputs;
  if (censusDigest(inputs?.environment?.options) !== censusDigest(["staging", "production"])
    || censusDigest(inputs?.test_type?.options) !== censusDigest(["smoke", "integration", "e2e"])
    || job?.name !== "test_environment" || job.env?.GH_AW_PROJECT_UTC !== "-08:00"
    || !Array.isArray(job.steps) || job.steps.length !== 2
    || job.steps[1]?.name !== "Display Test Config") throw new ChoiceEvidenceGap("Unreviewed choice options, project day or readback job.");
  const uploads = workflow.jobs?.agent?.steps?.filter(step =>
    ["agent", "agent-output-fallback"].includes(step.with?.name));
  if (uploads?.length !== 2 || uploads.some(step => !/^actions\/upload-artifact@[a-f0-9]{40}$/.test(step.uses ?? "")
    || step.with.overwrite || !step.with.path?.split("\n").includes("/tmp/gh-aw/agent_output.json"))) {
    throw new ChoiceEvidenceGap("No reviewed immutable upload steps for both merged choice payloads.");
  }
  return { taskSha256: hash(match[2]), jobSha256: censusDigest(job) };
}

export function readChoicePayloadArchive(bytes) {
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-choice-artifact-"));
  try {
    const file = path.join(temporary, "artifact.zip");
    writeFileSync(file, bytes);
    const execute = args => {
      try {
        return execFileSync("unzip", args, { encoding: "utf8", maxBuffer: 65536, timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        if (Number.isInteger(error.status) || error.code === "ENOBUFS" || error.signal === "SIGTERM") {
          throw new ChoiceEvidenceGap("Choice payload archive cannot be safely decoded within its budget.");
        }
        throw error;
      }
    };
    const names = execute(["-Z1", file]).trim().split("\n");
    const matches = names.filter(name => name === "agent_output.json");
    if (names.length > 2000 || names.some(name => name.startsWith("/") || name.split("/").includes(".."))
      || matches.length !== 1) throw new ChoiceEvidenceGap("No unique root choice payload in the native artifact.");
    const content = execute(["-p", file, matches[0]]);
    let value;
    try { value = JSON.parse(content); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new ChoiceEvidenceGap("Native choice payload is not valid JSON.");
    }
    const selection = projectChoicePayload(value);
    if (!selection) throw new ChoiceEvidenceGap("Payload does not establish exactly one allowed choice configuration.");
    return { selection, payloadSha256: hash(content) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function readChoiceRootLog(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024) throw new ChoiceEvidenceGap("Choice host archive exceeds its budget.");
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-choice-host-"));
  try {
    const file = path.join(temporary, "logs.zip");
    writeFileSync(file, bytes);
    let entries, text;
    try {
      entries = execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 65536, timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").filter(name => /^\d+_test_environment\.txt$/.test(name));
      if (entries.length !== 1) throw new ChoiceEvidenceGap("No unique protected root custom-job log.");
      text = execFileSync("unzip", ["-p", file, entries[0]], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (Number.isInteger(error.status) || error.code === "ENOBUFS" || error.signal === "SIGTERM") {
        throw new ChoiceEvidenceGap("Protected root custom-job log cannot be decoded within its budget.");
      }
      throw error;
    }
    return { text, hostEntry: entries[0], archiveSha256: hash(bytes), hostLogSha256: hash(text) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function collectChoiceHistory(cache, apiCache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "daily-choice-test", repositoryId = 1036865607;
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/weekday-choice", sourcePath = `.github/workflows/${workflowId}.md`;
  const compiledPath = sourcePath.replace(/\.md$/, ".lock.yml"), reader = publicGitSourceReader(cache, repository);
  const metadata = reader.metadata;
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous choice workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  if (metadata(["ls-tree", "-r", baseline, "--", sourcePath])) throw new Error("Choice source adoption is not a true parent-relative addition");
  const date = revision => {
    const timestamp = metadata(["cat-file", "commit", revision]).match(/^committer .+> (\d+) [+-]\d{4}$/m)?.[1];
    if (!timestamp) throw new Error("Missing choice commit timestamp");
    return new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z");
  };
  const source = reader.read(sourceRevision, sourcePath), compiled = reader.read(sourceRevision, compiledPath);
  if (!source || !compiled) throw new Error("Frozen choice source/compiled artifact missing");
  const contract = { repository, repositoryId, workflowId, sourcePath, compiledPath, sourceRevision, until, directory,
    sourceGitBlob: source.id, ...choiceSourceProfile(source.bytes.toString("utf8"), compiled.bytes.toString("utf8")),
    interpreterSha256: hash(readFileSync("scripts/native-choice-value.mjs")),
    sourceReaderSha256: hash(readFileSync("scripts/immutable-public-git-source.mjs")),
    hostLogReaderSha256: hash(readFileSync("scripts/protected-host-log.mjs")),
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(`${directory}/sources`, { recursive: true });
  mkdirSync(apiCache, { recursive: true });
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const wrapper = `import { nativeChoiceModule } from "../../../../scripts/native-choice-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeChoiceModule(${JSON.stringify(contract, null, 2)});\n`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to alter frozen native choice function");
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  if (prepareOnly) return { prepared: workflowId, adoption: contract.adoption.adoptedAt };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) throw new Error("Frozen native choice acquisition changed");
    return { reused: true, observations: index.observations, proven: index.proven };
  }
  let requests = 0, downloadedBytes = 0;
  const execute = args => {
    if (++requests > 1500) throw new Error("Choice API request budget exceeded");
    try {
      const bytes = execFileSync("gh", ["api", ...args], { timeout: 60000, maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PAGER: "cat" } });
      downloadedBytes += bytes.length;
      if (downloadedBytes > 256 * 1024 * 1024) throw new Error("Choice API byte budget exceeded");
      return bytes;
    } catch (error) {
      if (/HTTP (?:404|410)/.test(String(error.stderr))) throw new ChoiceEvidenceGap("Required initial-attempt receipt is no longer available.");
      throw error;
    }
  };
  const request = (endpoint, normalize) => {
    const file = path.join(apiCache, `${hash(endpoint)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const value = normalize(JSON.parse(execute([endpoint]).toString("utf8")));
    writeFileSync(file, JSON.stringify(value));
    return value;
  };
  const identity = request(`repos/${repository}`, row => ({ id: row.id, fullName: row.full_name }));
  if (identity.id !== repositoryId || identity.fullName !== repository) throw new Error("Native choice repository identity changed");
  const inventory = new Map();
  for (let start = Date.parse(contract.adoption.adoptedAt); start < Date.parse(until);) {
    const end = Math.min(start + 28 * 86400000, Date.parse(until));
    const interval = encodeURIComponent(`${new Date(start).toISOString()}..${new Date(end).toISOString()}`);
    let traversed = 0, complete = false;
    for (let page = 1; page <= 10; page++) {
      const result = request(`repos/${repository}/actions/workflows/${workflowId}.lock.yml/runs?created=${interval}&per_page=100&page=${page}`,
        row => ({ count: row.total_count, runs: row.workflow_runs?.map(run => ({ id: run.id, attempt: run.run_attempt,
          headSha: run.head_sha, path: run.path?.split("@")[0], event: run.event,
          createdAt: run.created_at, repositoryId: run.head_repository?.id ?? null })) }));
      if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > 1000 || !Array.isArray(result.runs)) {
        throw new Error("Invalid or over-budget choice run slice");
      }
      for (const run of result.runs) {
        if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isFinite(Date.parse(run.createdAt))
          || run.path !== compiledPath || Date.parse(run.createdAt) < start || Date.parse(run.createdAt) > end) {
          throw new Error("Invalid scoped choice execution identity");
        }
        if (run.createdAt >= until) continue;
        if (inventory.has(run.id) && censusDigest(inventory.get(run.id)) !== censusDigest(run)) throw new Error("Conflicting choice run identity");
        inventory.set(run.id, run);
      }
      traversed += result.runs.length;
      if (traversed === result.count) { complete = true; break; }
      if (!result.runs.length || traversed > result.count) throw new Error("Choice run pagination failed closed");
    }
    if (!complete || inventory.size > 1000) throw new Error("Native choice run inventory incomplete or over budget");
    start = end;
  }
  const observations = [];
  for (const run of [...inventory.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const rowFile = path.join(apiCache, `${censusDigest([contract, run])}.receipt.json`);
    if (existsSync(rowFile)) {
      const retained = JSON.parse(readFileSync(rowFile, "utf8"));
      if (censusDigest(retained.run) !== censusDigest(run)) throw new Error("Retained choice execution identity changed");
      if (retained.source) for (const [file, key] of [[sourcePath, "sourceGitBlob"], [compiledPath, "compiledGitBlob"]]) {
        if (reader.read(run.headSha, file)?.id !== retained.source[key]) throw new Error("Retained choice source identity changed");
      }
      observations.push(retained);
      continue;
    }
    const row = { run };
    try {
      if (run.attempt !== 1 || run.repositoryId !== repositoryId || !["schedule", "workflow_dispatch"].includes(run.event)) {
        throw new ChoiceEvidenceGap("No unmixed same-repository initial scheduled/manual execution.");
      }
      const artifacts = request(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`, result => ({
        count: result.total_count, artifacts: result.artifacts?.filter(item => ["agent", "agent-output-fallback"].includes(item.name))
          .map(item => ({ id: item.id, name: item.name, expired: item.expired, size: item.size_in_bytes,
            createdAt: item.created_at, digest: item.digest, runId: item.workflow_run?.id,
            headSha: item.workflow_run?.head_sha })) }));
      if (!Number.isSafeInteger(artifacts.count) || artifacts.count > 100 || artifacts.artifacts?.length !== 2
        || artifacts.artifacts.some(item => item.expired || item.runId !== run.id || item.headSha !== run.headSha
          || !Number.isSafeInteger(item.size) || item.size > 8 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(item.digest ?? ""))) {
        throw new ChoiceEvidenceGap("Both original choice artifacts with provider digests do not survive.");
      }
      try { metadata(["merge-base", "--is-ancestor", run.headSha, sourceRevision]); }
      catch (error) {
        if (Number.isInteger(error.status)) throw new ChoiceEvidenceGap("Run head is not available in reviewed frozen mainline history.");
        throw error;
      }
      const original = reader.read(run.headSha, sourcePath), lock = reader.read(run.headSha, compiledPath);
      if (!original || !lock) throw new ChoiceEvidenceGap("Execution source/compiled workflow absent.");
      const profile = choiceSourceProfile(original.bytes.toString("utf8"), lock.bytes.toString("utf8"));
      if (profile.taskSha256 !== contract.taskSha256 || profile.jobSha256 !== contract.jobSha256) {
        throw new ChoiceEvidenceGap("Historical task/readback profile differs from the frozen native contract.");
      }
      row.source = { headSha: run.headSha, sourceGitBlob: original.id, compiledGitBlob: lock.id, ...profile };
      const jobs = request(`repos/${repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`, result => ({
        count: result.total_count, jobs: result.jobs?.filter(job => ["agent", "test_environment"].includes(job.name))
          .map(job => ({ id: job.id, name: job.name, steps: job.steps?.map(step => ({
            name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
            started_at: step.started_at, completed_at: step.completed_at })) })) }));
      if (!Number.isSafeInteger(jobs.count) || jobs.count > 100 || jobs.jobs?.length !== 2) {
        throw new ChoiceEvidenceGap("No unique initial agent and custom readback job.");
      }
      row.artifacts = artifacts.artifacts.map(artifact => {
        const agent = jobs.jobs.find(job => job.name === "agent");
        const name = artifact.name === "agent" ? "Upload agent artifacts" : "Upload agent output fallback artifact";
        const steps = agent?.steps?.filter(step => step.name === name);
        if (steps?.length !== 1 || steps[0].conclusion !== "success") throw new ChoiceEvidenceGap("Native artifact upload step did not establish its receipt.");
        const bytes = execute([`repos/${repository}/actions/artifacts/${artifact.id}/zip`]);
        const archiveSha256 = hash(bytes);
        if (`sha256:${archiveSha256}` !== artifact.digest) throw new Error("Native choice artifact/provider digest mismatch");
        return { id: artifact.id, name: artifact.name, createdAt: artifact.createdAt,
          runId: artifact.runId, headSha: artifact.headSha, archiveSha256, providerDigest: artifact.digest,
          jobId: agent.id, jobName: agent.name, uploadStep: steps[0], ...readChoicePayloadArchive(bytes) };
      });
      const job = jobs.jobs.find(job => job.name === "test_environment");
      const steps = job?.steps?.filter(step => step.name === "Display Test Config");
      if (steps?.length !== 1 || steps[0].conclusion !== "success") throw new ChoiceEvidenceGap("No successful protected choice readback step.");
      const bytes = execute([`repos/${repository}/actions/runs/${run.id}/attempts/1/logs`]);
      let log;
      try { log = readProtectedHostLog(bytes, "Display Test Config", "test_environment"); }
      catch (error) {
        if (!(error instanceof HostLogEvidenceGap)) throw error;
        log = readChoiceRootLog(bytes);
      }
      const lines = log.text.split(/\r?\n/).filter(line => /^\d{4}-\d\d-\d\dT.+Z Test would be executed on /.test(line));
      if (lines.length !== 1) throw new ChoiceEvidenceGap("No unique protected configuration readback line.");
      row.host = { jobId: job.id, jobName: job.name, step: steps[0], line: lines[0], entry: log.hostEntry,
        archiveSha256: log.archiveSha256, hostLogSha256: log.hostLogSha256 };
    } catch (error) {
      if (!(error instanceof ChoiceEvidenceGap) && !(error instanceof HostLogEvidenceGap)) throw error;
      row.reason = error.message;
    }
    observations.push(row);
    writeFileSync(rowFile, JSON.stringify(row));
    console.log(JSON.stringify({ runId: run.id, assessment: assessChoiceReceipt(row, contract).status }));
  }
  const sources = reader.sources().map(source => {
    writeCensusJson(`${directory}/sources/${source.id}.json.gz`, source);
    return { gitBlob: source.id, sha256: censusDigest(source) };
  });
  const facts = { observations };
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  const assessments = observations.map(row => assessChoiceReceipt(row, contract));
  const proven = assessments.filter(row => row.status === "assessed" && row.correct).length;
  writeCensusJson(`${directory}/index.json`, { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sources, observations: observations.length, proven,
    acquiredAt: new Date().toISOString(), requests, downloadedBytes,
    producer: { path: "scripts/collect-choice-history.mjs", sha256: hash(readFileSync(import.meta.filename)) } });
  return { complete: true, observations: observations.length, proven };
}

if (process.argv[1] === import.meta.filename) {
  const [cache, apiCache, flag, ...extra] = process.argv.slice(2);
  if (!cache || !apiCache || extra.length || flag && flag !== "--prepare-only") {
    throw new Error("usage: collect-choice-history.mjs BARE_CACHE API_CACHE [--prepare-only]");
  }
  console.log(JSON.stringify(collectChoiceHistory(cache, apiCache, flag === "--prepare-only")));
}
