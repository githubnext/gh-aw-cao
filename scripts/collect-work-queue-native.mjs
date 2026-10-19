import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { assessQueueRun, workQueueDirectory } from "./native-work-queue-value.mjs";
import { HostLogEvidenceGap, readProtectedHostLog } from "./protected-host-log.mjs";

const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function reviewQueueSource(reader, head, contract) {
  const source = reader.read(head, contract.sourcePath);
  const compiled = reader.read(head, contract.compiledPath);
  if (!source || !compiled) return { headSha: head, reviewed: false, reason: "Historical workflow source unavailable." };
  const locked = parse(compiled.bytes.toString("utf8"));
  const host = locked.jobs?.[contract.smokeReadback.job];
  const runtime = contract.sources.slice(2).map(item => ({ path: item.path, sha256: reader.read(head, item.path)?.sha256 ?? null }));
  const reviewed = source.id === contract.sourceGitBlob && censusDigest(host ?? null) === contract.hostJobSha256
    && censusDigest(runtime) === censusDigest(contract.sources.slice(2));
  const uploads = locked.jobs?.agent?.steps?.filter(step => step.name === "Upload agent artifacts") ?? [];
  return { headSha: head, sourceGitBlob: source.id, compiledGitBlob: compiled.id,
    hostJobSha256: censusDigest(host ?? null), runtime, reviewed,
    unsupportedReason: reviewed ? null : source.id !== contract.sourceGitBlob
      ? "Historical task is not the frozen observer task; exact incompatible intent sources are separately classified."
      : "Observer task and host smoke assertion match, but one or more frozen runtime/checker source identities differ.",
    finishIncludedInAgentUpload: uploads.length === 1
      ? String(uploads[0].with?.path ?? "").split("\n").includes("/tmp/gh-aw/work-queue.finish.jsonl") : null,
    nativeCheckerCount: reviewed ? contract.nativeHostCheckers.length : null };
}

export function collectWorkQueueNative(bareCache, apiCache) {
  const contract = readCensusJson(`${workQueueDirectory}/contract.json`);
  const interpreterSha256 = hash(readFileSync("scripts/native-work-queue-value.mjs"));
  const reader = publicGitSourceReader(bareCache, contract.repository);
  mkdirSync(apiCache, { recursive: true });
  let requests = 0, bytes = 0, fetches = 0;
  const request = endpoint => {
    const file = path.join(apiCache, `${hash(endpoint)}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    if (++requests > 120) throw new Error("Queue acquisition request budget exhausted");
    const response = execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
    bytes += response.length;
    if (bytes > 32 * 1024 * 1024) throw new Error("Queue acquisition byte budget exhausted");
    const value = JSON.parse(response.toString("utf8"));
    writeFileSync(file, response);
    return value;
  };
  const binary = endpoint => {
    const file = path.join(apiCache, `${hash(endpoint)}.zip`);
    if (!existsSync(file)) {
      if (++requests > 120) throw new Error("Queue acquisition request budget exhausted");
      let response;
      try {
        response = execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GH_PAGER: "cat" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        if (/\(HTTP (404|410)\)/.test(String(error.stderr))) return { status: "unavailable", httpStatus: Number(String(error.stderr).match(/\(HTTP (\d+)\)/)[1]) };
        throw error;
      }
      bytes += response.length;
      if (bytes > 32 * 1024 * 1024) throw new Error("Queue acquisition byte budget exhausted");
      writeFileSync(file, response);
    }
    const data = readFileSync(file);
    if (data.length > 8 * 1024 * 1024) throw new Error("Cached queue archive exceeds budget");
    return { status: "available", file, data, sha256: hash(data) };
  };
  const repository = request(`repos/${contract.repository}`);
  if (repository.id !== contract.repositoryId || repository.full_name !== contract.repository
    || repository.private !== false) throw new Error("Queue repository identity/visibility mismatch");
  for (const item of contract.sources) {
    if (reader.read(contract.sourceRevision, item.path)?.sha256 !== item.sha256) throw new Error("Frozen queue source changed");
  }
  const runs = new Map();
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const interval = encodeURIComponent(`${contract.adoption.adoptedAt}..${contract.until}`);
    const response = request(`repos/${contract.repository}/actions/workflows/${contract.workflowId}.lock.yml/runs?created=${interval}&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 || response.total_count > 1000
      || !Array.isArray(response.workflow_runs)) throw new Error("Invalid or over-budget queue inventory");
    for (const run of response.workflow_runs) {
      if (!positive(run.id) || !positive(run.run_attempt) || !/^[a-f0-9]{40}$/.test(run.head_sha)
        || run.path?.split("@")[0] !== contract.compiledPath || runs.has(run.id)
        || !Number.isFinite(Date.parse(run.created_at))) throw new Error("Invalid or duplicate queue run");
      runs.set(run.id, run);
    }
    if (runs.size === response.total_count) { complete = true; break; }
    if (!response.workflow_runs.length) throw new Error("Queue inventory traversal ended early");
  }
  if (!complete) throw new Error("Incomplete queue inventory");
  const sources = new Map(), observations = [];
  for (const candidate of [...runs.values()].sort((a, b) => a.id - b.id)) {
    if (candidate.created_at >= contract.until || candidate.created_at < contract.adoption.adoptedAt
      || candidate.head_repository?.id !== contract.repositoryId
      || !["schedule", "workflow_dispatch"].includes(candidate.event)) continue;
    const run = { id: candidate.id, attempt: 1, repositoryId: contract.repositoryId,
      event: candidate.event, path: contract.compiledPath, headSha: candidate.head_sha, createdAt: candidate.created_at };
    const initial = request(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1`);
    if (initial.id !== run.id || initial.run_attempt !== 1 || initial.head_sha !== run.headSha
      || initial.repository?.id !== contract.repositoryId || initial.head_repository?.id !== contract.repositoryId
      || initial.path?.split("@")[0] !== run.path || initial.event !== run.event
      || !Number.isFinite(Date.parse(initial.created_at))
      || initial.created_at < run.createdAt || initial.created_at >= contract.until) throw new Error("Queue initial-attempt identity mismatch");
    run.initialCreatedAt = initial.created_at;
    if (!sources.has(run.headSha)) {
      try { reader.metadata(["cat-file", "-e", `${run.headSha}^{commit}`]); }
      catch (error) {
        if (error.status !== 128) throw error;
        if (++fetches > 20) throw new Error("Queue exact-head fetch budget exhausted");
        execFileSync("git", [`--git-dir=${bareCache}`, "fetch", "--quiet", "--filter=blob:none", "origin", run.headSha],
          { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      }
      sources.set(run.headSha, reviewQueueSource(reader, run.headSha, contract));
    }
    const response = request(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
    if (!Array.isArray(response.jobs) || response.total_count !== response.jobs.length
      || response.jobs.some(job => job.run_id !== run.id || job.head_sha !== run.headSha || job.run_attempt !== 1)
      || new Set(response.jobs.map(job => job.id)).size !== response.jobs.length) throw new Error("Incomplete or mismatched queue jobs");
    const jobs = response.jobs.map(job => ({ id: job.id, runId: job.run_id, headSha: job.head_sha,
      attempt: job.run_attempt, name: job.name, steps: (job.steps ?? []).map(step => ({
        name: step.name, number: step.number, status: step.status, conclusion: step.conclusion,
        started_at: step.started_at, completed_at: step.completed_at,
      })) }));
    const artifacts = request(`repos/${contract.repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length
      || artifacts.artifacts.some(item => !positive(item.id) || item.workflow_run?.id !== run.id
        || item.workflow_run?.head_sha !== run.headSha)) throw new Error("Incomplete or mismatched queue artifacts");
    const agentArtifacts = artifacts.artifacts.filter(item => item.name === "agent");
    if (agentArtifacts.length > 1 && candidate.run_attempt === 1) throw new Error("Ambiguous queue agent artifacts");
    const archiveDiscovery = [];
    for (const artifact of agentArtifacts) {
      if (artifact.expired || artifact.size_in_bytes > 8 * 1024 * 1024) {
        archiveDiscovery.push({ artifactId: artifact.id, status: artifact.expired ? "expired" : "over-budget" });
        continue;
      }
      const archive = binary(`repos/${contract.repository}/actions/artifacts/${artifact.id}/zip`);
      if (archive.status !== "available") {
        archiveDiscovery.push({ artifactId: artifact.id, ...archive });
        continue;
      }
      if (artifact.digest !== `sha256:${archive.sha256}`) throw new Error("Queue artifact provider digest mismatch");
      const names = execFileSync("unzip", ["-Z1", archive.file], { encoding: "utf8", timeout: 30000,
        maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n");
      if (names.length > 10000 || new Set(names).size !== names.length
        || names.some(name => name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))) {
        throw new Error("Unsafe/ambiguous queue artifact member inventory");
      }
      archiveDiscovery.push({ artifactId: artifact.id, status: "available", archiveSha256: archive.sha256,
        providerDigest: artifact.digest, memberCount: names.length,
        snapshotMember: names.includes("work-queue.snapshot.json"),
        finishMember: names.includes("work-queue.finish.jsonl"),
        independentNativeChecker: false,
        meaning: "Archive membership only, not absence from the agent filesystem or durable queue." });
    }
    const protectedLogs = [];
    if (sources.get(run.headSha).reviewed) {
      const archive = binary(`repos/${contract.repository}/actions/runs/${run.id}/attempts/1/logs`);
      if (archive.status !== "available") protectedLogs.push(archive);
      else {
        for (const [jobName, stepName] of [["activation", "Snapshot work queue state"], ["agent", "Copy work queue claim finish intent"]]) {
          try {
            const receipt = readProtectedHostLog(archive.data, stepName, jobName);
            protectedLogs.push({ status: "available", jobName, stepName,
              jobId: jobs.find(job => job.name === jobName)?.id ?? null,
              archiveSha256: receipt.archiveSha256, hostLogSha256: receipt.hostLogSha256, hostEntry: receipt.hostEntry,
              nativeObserverProof: false });
          } catch (error) {
            if (!(error instanceof HostLogEvidenceGap)) throw error;
            try {
              const receipt = readProtectedHostLog(archive.data, jobName);
              protectedLogs.push({ status: "available", jobName, stepName,
                jobId: jobs.find(job => job.name === jobName)?.id ?? null,
                archiveSha256: receipt.archiveSha256, hostLogSha256: receipt.hostLogSha256,
                hostEntry: receipt.hostEntry, layout: "combined-job-log",
                stepContentAssessed: false, nativeObserverProof: false });
            } catch (combinedError) {
              if (!(combinedError instanceof HostLogEvidenceGap)) throw combinedError;
              protectedLogs.push({ status: "unavailable", jobName, stepName, reason: combinedError.message,
                archiveSha256: archive.sha256 });
            }
          }
        }
      }
    }
    observations.push({ run, source: sources.get(run.headSha), jobs, archiveDiscovery, protectedLogs,
      artifacts: artifacts.artifacts.map(item => ({ id: item.id, name: item.name, expired: item.expired,
        createdAt: item.created_at, expiresAt: item.expires_at, size: item.size_in_bytes, digest: item.digest,
        runId: item.workflow_run.id, headSha: item.workflow_run.head_sha })),
      nativeEvidenceGap: "No source-defined protected native observer assertion or independent read/explain/mutation-safety receipt.",
    });
  }
  const retainedSources = reader.sources();
  writeCensusJson(`${workQueueDirectory}/sources.json.gz`, retainedSources);
  writeCensusJson(`${workQueueDirectory}/observations.json.gz`, observations);
  const assessments = observations.map(row => assessQueueRun(row, contract));
  const index = { schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    sourceRevision: contract.sourceRevision, until: contract.until, acquiredAt: new Date().toISOString(),
    complete: true, contractSha256: censusDigest(contract), interpreterSha256,
    observations: observations.length, observationsSha256: censusDigest(observations),
    sources: retainedSources.length, sourcesSha256: censusDigest(retainedSources),
    reviewedExecutions: observations.filter(row => row.source.reviewed).length,
    observerInitialAttempts: assessments.filter(row => row.eligible !== false).length,
    incompatibleIntentAttempts: assessments.filter(row => row.eligible === false).length,
    downloadedAgentArtifacts: observations.flatMap(row => row.archiveDiscovery).filter(row => row.status === "available").length,
    retainedActivationArtifacts: observations.flatMap(row => row.artifacts).filter(row => row.name === "activation").length,
    agentArchivesContainingSnapshot: observations.flatMap(row => row.archiveDiscovery).filter(row => row.snapshotMember === true).length,
    protectedLogsAvailable: observations.flatMap(row => row.protectedLogs).filter(row => row.status === "available").length,
    smokeReadbacks: assessments.filter(row => row.smokeReadback === true).length,
    nativeKnownPredicates: assessments.flatMap(row => row.predicates).filter(item => item.passed !== null).length,
    nativeCoverage: "not-measured", apiRequestsThisInvocation: requests, apiBytesThisInvocation: bytes,
    collectorSha256: hash(readFileSync(import.meta.filename)),
    protectedHostLogSha256: hash(readFileSync("scripts/protected-host-log.mjs")),
    limitation: "Metadata and exact smoke host receipts were acquired. Native queue receipt acquisition cannot manufacture a checker absent from the immutable source. No public agent prose or editable issue is outcome proof." };
  writeCensusJson(`${workQueueDirectory}/index.json`, index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("usage: collect-work-queue-native.mjs BARE_PUBLIC_CACHE PRIVATE_API_CACHE");
  console.log(JSON.stringify(collectWorkQueueNative(process.argv[2], process.argv[3]), null, 2));
}
