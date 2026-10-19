import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { FormalSearchEvidenceGap, normalizeFormalSearch } from "./native-formal-search-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0;

export function readFormalSearchArchive(archive, model) {
  if (!Buffer.isBuffer(archive) || archive.length > 32 * 1024 * 1024) throw new FormalSearchEvidenceGap("Formal artifact exceeds its byte budget.");
  const directory = mkdtempSync(path.join(tmpdir(), "cao-formal-artifact-"));
  try {
    const file = path.join(directory, "artifact.zip");
    writeFileSync(file, archive);
    const unzip = args => {
      try {
        return execFileSync("unzip", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
          timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        if (Number.isInteger(error.status) || error.code === "ENOBUFS" || error.signal === "SIGTERM") {
          throw new FormalSearchEvidenceGap("Formal artifact cannot be decoded within its execution/byte budget.");
        }
        throw error;
      }
    };
    const names = unzip(["-Z1", file]).trim().split("\n");
    const required = ["result.json", "tlc.log", ...Object.keys(model.sourceSha256)];
    if (required.some(name => !/^[A-Za-z0-9_.-]+$/.test(name) || names.filter(entry => entry === name).length !== 1)) {
      throw new FormalSearchEvidenceGap("Missing or ambiguous root-level native formal artifact entries.");
    }
    const values = Object.fromEntries(required.map(name => [name, unzip(["-p", file, name])]));
    for (const [name, sha256] of Object.entries(model.sourceSha256)) {
      if (hash(values[name]) !== sha256) throw new FormalSearchEvidenceGap("Artifact model/configuration differs from the frozen source cohort.");
    }
    let result;
    try { result = JSON.parse(values["result.json"]); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new FormalSearchEvidenceGap("Malformed native formal result JSON.");
    }
    return { result, log: values["tlc.log"], archiveSha256: hash(archive), logSha256: hash(values["tlc.log"]) };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

export function collectFormalSearchEvidence(cache, apiCache, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "daily-work-queue-formal-verification";
  const sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
  const directory = "docs/operational-value/proof/formal-search";
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  const metadata = args => git(args).trim();
  if (metadata(["remote", "get-url", "origin"]) !== `https://github.com/${repository}.git`) throw new Error("Formal source remote mismatch");
  const sourcePath = `.github/workflows/${workflowId}.md`, execution = sourcePath.replace(/\.md$/, ".lock.yml");
  const producerPath = ".github/scripts/work-queue-formal-check.cjs";
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", sourceRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous formal-workflow adoption");
  const adopted = additions[0], baseline = metadata(["rev-parse", `${adopted}^`]);
  for (const file of [sourcePath, execution]) {
    if (metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adopted, "--", file]) !== `A\t${file}`) {
      throw new Error("Formal adoption is not an original source/compiled pair");
    }
  }
  const show = (revision, file) => git(["show", `${revision}:${file}`]);
  const date = revision => new Date(metadata(["show", "-s", "--format=%cI", revision])).toISOString().replace(".000Z", "Z");
  const models = [["FairDAGGitHub", "FairWorkQueue"], ["QueueOrdering", "WorkQueue"]].map(([id, module]) => ({
    id, module, sourceSha256: Object.fromEntries([`${module}.tla`, `${id}.cfg`].map(name =>
      [name, hash(show(sourceRevision, `specs/work-queue/${name}`))])),
  }));
  const job = parse(show(sourceRevision, execution)).jobs.formal_checks;
  if (job["runs-on"] !== "ubuntu-latest" || job.container || job["continue-on-error"]
    || censusDigest(job.strategy.matrix.config) !== censusDigest(models.map(model => model.id))
    || !job.steps.some(step => step.run === "node .github/scripts/work-queue-formal-check.cjs")) {
    throw new Error("Formal producer is not the reviewed independent native matrix job");
  }
  const files = [sourcePath, execution, producerPath, ...models.flatMap(model =>
    Object.keys(model.sourceSha256).map(name => `specs/work-queue/${name}`))];
  const sources = files.map(file => ({ path: file, gitBlob: metadata(["rev-parse", `${sourceRevision}:${file}`]),
    text: show(sourceRevision, file) }));
  const contract = { repository, repositoryId: 1036865607, workflowId, sourceRevision, until,
    sourceGitBlob: sources[0].gitBlob, producerGitBlob: sources[2].gitBlob,
    jobSha256: censusDigest(job), models, tlcSha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
    interpreterSha256: hash(readFileSync("scripts/native-formal-search-value.mjs")),
    adoption: { commit: adopted, adoptedAt: date(adopted), baselineCommit: baseline, baselineAt: date(baseline) } };
  mkdirSync(directory, { recursive: true });
  const factory = `formalSearchModule(${JSON.stringify(contract, null, 2)})`;
  const prefix = `import { formalSearchModule } from "../../../../scripts/native-formal-search-value.mjs";\n\n`;
  const wrapper = `${prefix}const value = ${factory};\nexport const { collectBatch, scoreMetric } = value;\nexport const definition = { ...value.definition, evidence: { ...value.definition.evidence,\n  sourcePolicySha256: "${censusDigest(contract)}" } };\n`;
  const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) {
    const previous = readFileSync(functionFile, "utf8");
    if (previous !== `${prefix}export const { definition, collectBatch, scoreMetric } = ${factory};\n`) {
      throw new Error("Refusing to alter frozen formal-search function");
    }
    const archive = `${directory}/versions/${hash(previous)}`;
    const retained = [[functionFile, "function.txt"], ["scripts/native-formal-search-value.mjs", "interpreter.txt"],
      ...["contracts.json", "index.json", "facts.json.gz", "sources.json.gz"].filter(name => existsSync(`${directory}/${name}`))
        .map(name => [`${directory}/${name}`, name])];
    for (const [file, name] of retained) {
      if (existsSync(`${archive}/${name}`) && !readFileSync(file).equals(readFileSync(`${archive}/${name}`))) {
        throw new Error("Prior formal-search version changed");
      }
    }
    mkdirSync(archive, { recursive: true });
    for (const [file, name] of retained) copyFileSync(file, `${archive}/${name}`);
  }
  writeFileSync(functionFile, wrapper);
  writeCensusJson(`${directory}/contracts.json`, [contract]);
  writeCensusJson(`${directory}/sources.json.gz`, sources);
  if (prepareOnly) return { prepared: workflowId, models: models.map(model => model.id) };
  if (existsSync(`${directory}/index.json`)) {
    const index = readCensusJson(`${directory}/index.json`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract)
      || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))) throw new Error("Frozen formal evidence changed");
    return { reused: true, available: index.available, observations: index.observations };
  }
  mkdirSync(apiCache, { recursive: true });
  let requests = 0, bytes = 0;
  const request = endpoint => {
    if (++requests > 200) throw new Error("Formal evidence request budget exhausted");
    let value;
    try {
      value = execFileSync("gh", ["api", endpoint], { maxBuffer: 32 * 1024 * 1024, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const status = String(error.stderr).match(/HTTP (\d{3})/)?.[1];
      if (["403", "404", "410"].includes(status)) throw new FormalSearchEvidenceGap(`Native formal evidence is unavailable (HTTP ${status}).`);
      if (error.code === "ENOBUFS" || error.signal === "SIGTERM") throw new FormalSearchEvidenceGap("Formal response exceeds its execution/byte budget.");
      throw new Error(`Formal API request failed (${status ?? error.code ?? error.status ?? "unknown"}).`);
    }
    bytes += value.length;
    if (bytes > 256 * 1024 * 1024) throw new Error("Formal evidence total byte budget exhausted");
    return value;
  };
  const json = (endpoint, normalize) => {
    const file = path.join(apiCache, `${hash(endpoint)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const value = normalize(JSON.parse(request(endpoint)));
    writeFileSync(file, JSON.stringify(value));
    return value;
  };
  const identity = json(`repos/${repository}`, row => ({ id: row.id, full_name: row.full_name }));
  if (identity.id !== contract.repositoryId || identity.full_name !== repository) throw new Error("Formal repository identity changed");
  const runs = [];
  let complete = false;
  for (let page = 1; page <= 3; page++) {
    const response = json(`repos/${repository}/actions/workflows/${workflowId}.lock.yml/runs?created=${encodeURIComponent(`${contract.adoption.adoptedAt}..${until}`)}&per_page=100&page=${page}`,
      row => ({ total_count: row.total_count, runs: row.workflow_runs.map(run => ({ id: run.id, head_sha: run.head_sha,
        path: run.path, event: run.event, created_at: run.created_at, repositoryId: run.head_repository?.id })) }));
    if (!Number.isSafeInteger(response.total_count) || response.total_count > 300) throw new Error("Invalid or over-budget formal inventory");
    runs.push(...response.runs);
    if (runs.length === response.total_count) { complete = true; break; }
    if (!response.runs.length) throw new Error("Formal inventory traversal stopped early");
  }
  if (!complete || new Set(runs.map(run => run.id)).size !== runs.length) throw new Error("Incomplete or duplicated formal execution inventory");
  const facts = [];
  for (const run of runs) {
    if (!positive(run.id) || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.path?.split("@")[0] !== execution
      || !Number.isFinite(Date.parse(run.created_at))) throw new Error("Invalid formal run identity");
    if (Date.parse(run.created_at) >= Date.parse(until)) continue;
    let sourceGap = null;
    if (run.repositoryId !== contract.repositoryId || !["schedule", "workflow_dispatch"].includes(run.event)) {
      sourceGap = "No independent same-repository initial checkout source.";
    } else {
      try {
        if (metadata(["rev-parse", `${run.head_sha}:${sourcePath}`]) !== contract.sourceGitBlob
          || metadata(["rev-parse", `${run.head_sha}:${producerPath}`]) !== contract.producerGitBlob
          || censusDigest(parse(show(run.head_sha, execution)).jobs.formal_checks) !== contract.jobSha256
          || models.some(model => Object.entries(model.sourceSha256).some(([name, sha256]) =>
            hash(show(run.head_sha, `specs/work-queue/${name}`)) !== sha256))) {
          sourceGap = "Historical goal, native producer/job or model/configuration differs from the frozen cohort.";
        }
      } catch (error) {
        if (!/does not exist|Not a valid object|invalid object|bad object|exists on disk, but not in/.test(String(error.stderr))) throw error;
        sourceGap = "Exact historical native source is unavailable in the retained Git closure.";
      }
    }
    let jobs = null, artifacts = null, acquisitionGap = sourceGap;
    if (!sourceGap) {
      try {
        jobs = json(`repos/${repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
          row => ({ total_count: row.total_count, jobs: row.jobs.map(job => ({ id: job.id, name: job.name,
            started_at: job.started_at, completed_at: job.completed_at })) }));
        artifacts = json(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
          row => ({ total_count: row.total_count, artifacts: row.artifacts.map(artifact => ({
            id: artifact.id, name: /^work-queue-formal-(?:FairDAGGitHub|QueueOrdering)-\d+-1$/.test(artifact.name) ? artifact.name : null,
            expired: artifact.expired, size_in_bytes: artifact.size_in_bytes, digest: artifact.digest,
            workflow_run: { id: artifact.workflow_run?.id, head_sha: artifact.workflow_run?.head_sha } })) }));
        if (jobs.total_count !== jobs.jobs.length || artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete formal job/artifact inventory");
      } catch (error) {
        if (!(error instanceof FormalSearchEvidenceGap)) throw error;
        acquisitionGap = error.message;
      }
    }
    for (const model of models) {
      const fact = { runId: run.id, model: model.id, headSha: run.head_sha, at: run.created_at, status: "unavailable", reason: acquisitionGap };
      if (!acquisitionGap) {
        try {
          const matches = jobs.jobs.filter(job => job.name === `formal_checks (${model.id})`);
          const matchesArtifacts = artifacts.artifacts.filter(artifact => artifact.name === `work-queue-formal-${model.id}-${run.id}-1`);
          if (matches.length !== 1 || !positive(matches[0].id) || !matches[0].completed_at
            || matchesArtifacts.length !== 1 || !positive(matchesArtifacts[0].id) || matchesArtifacts[0].expired
            || matchesArtifacts[0].size_in_bytes > 32 * 1024 * 1024
            || matchesArtifacts[0].workflow_run?.id !== run.id || matchesArtifacts[0].workflow_run?.head_sha !== run.head_sha) {
            throw new FormalSearchEvidenceGap("No retained unique bounded initial-attempt protected formal job artifact.");
          }
          const artifact = matchesArtifacts[0], job = matches[0], file = path.join(apiCache, `formal-${artifact.id}.json.gz`);
          let normalized;
          if (existsSync(file)) normalized = readCensusJson(file);
          else {
            const { result, log, archiveSha256, logSha256 } = readFormalSearchArchive(
              request(`repos/${repository}/actions/artifacts/${artifact.id}/zip`), model);
            if (artifact.digest && artifact.digest !== `sha256:${archiveSha256}`) throw new FormalSearchEvidenceGap("Formal artifact digest mismatch.");
            normalized = { ...normalizeFormalSearch(result, log, contract, model, run, job), archiveSha256, logSha256 };
            writeCensusJson(file, normalized);
          }
          const replay = normalizeFormalSearch(normalized.result, normalized.safeLog, contract, model, run, job);
          if (censusDigest(replay) !== censusDigest(Object.fromEntries(Object.entries(normalized)
            .filter(([key]) => !["archiveSha256", "logSha256"].includes(key))))) throw new Error("Cached native formal counters changed");
          Object.assign(fact, normalized, { status: "available", reason: null, artifactId: artifact.id, job });
        } catch (error) {
          if (!(error instanceof FormalSearchEvidenceGap)) throw error;
          fact.reason = error.message;
        }
      }
      facts.push(fact);
    }
  }
  writeCensusJson(`${directory}/facts.json.gz`, facts);
  const index = { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision, until,
    contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sourcesSha256: censusDigest(sources),
    inventoryRuns: runs.length, observations: facts.length, available: facts.filter(row => row.status === "available").length,
    knownModels: new Set(facts.filter(row => row.status === "available").map(row => row.model)).size,
    acquiredAt: new Date().toISOString(), producer: { path: "scripts/collect-formal-search-evidence.mjs", sha256: hash(readFileSync(import.meta.filename)) } };
  writeCensusJson(`${directory}/index.json`, index);
  return { runs: index.inventoryRuns, observations: index.observations, available: index.available,
    gaps: [...new Set(facts.map(row => row.reason).filter(Boolean))] };
}

if (process.argv[1] === import.meta.filename) {
  if (!process.argv[2] || !process.argv[3] || process.argv.length > 5 || process.argv[4] && process.argv[4] !== "--prepare-only") {
    throw new Error("usage: collect-formal-search-evidence.mjs BARE_GIT_CACHE API_CACHE [--prepare-only]");
  }
  console.log(JSON.stringify(collectFormalSearchEvidence(process.argv[2], process.argv[3], process.argv[4] === "--prepare-only")));
}
