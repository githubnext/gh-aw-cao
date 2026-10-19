import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { readProtectedHostLog } from "./protected-host-log.mjs";
import { conformanceAcquisitionDigest, coreBehaviorProbes, normalizeConformanceReport, parseConformanceHostLog } from "./native-engine-conformance.mjs";

const execute = promisify(execFile);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const isSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function conformanceAttemptUrl(run, repository, attempt) {
  const url = new URL(run.html_url);
  if (!positive(run.id) || !positive(attempt) || attempt > 20 || url.protocol !== "https:"
    || url.pathname !== `/${repository}/actions/runs/${run.id}` || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid conformance execution URL or attempt identity");
  }
  return `${url.href}/attempts/${attempt}`;
}

export function conformanceHostStepProof(checker, step, contract) {
  if (!checker?.run || !contract.acceptedCheckerScripts.includes(sha256(checker.run))
    || ![undefined, false].includes(checker["continue-on-error"])
    || checker.env?.CONFORMANCE_ENGINE !== contract.engine
    || checker.env?.CONFORMANCE_STATE !== "${{ runner.temp }}/engine-conformance"
    || checker.env?.CONFORMANCE_ROOT !== "/tmp/gh-aw/agent/engine-conformance"
    || step?.name !== "Assert engine conformance" || step.status !== "completed" || step.conclusion !== "success"
    || !Number.isFinite(Date.parse(step.started_at)) || !Number.isFinite(Date.parse(step.completed_at))
    || Date.parse(step.completed_at) < Date.parse(step.started_at)) throw new Error("No source-verified independent host assertion success");
  const names = [...coreBehaviorProbes, "fixtures", "agent-execution",
    ...(checker.run.includes('check("staged-safe-output"') ? ["staged-safe-output"] : [])];
  return normalizeConformanceReport({ engine: contract.engine, status: "passed",
    checks: names.map(name => ({ name, status: "passed" })) }, contract.engine);
}

export async function readConformanceLogArchive(archive, engine) {
  const { text, ...receipt } = readProtectedHostLog(archive, "Assert engine conformance");
  return { report: parseConformanceHostLog(text, engine), ...receipt };
}

async function readConformanceArtifact(archive, engine) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "host-conformance-report-"));
  try {
    const file = path.join(temporary, "report.zip");
    writeFileSync(file, archive);
    const { stdout } = await execute("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 65536 });
    if (stdout.trim() !== "report.json") throw new Error("Unexpected protected host artifact entries");
    const { stdout: text } = await execute("unzip", ["-p", file, "report.json"],
      { encoding: "utf8", maxBuffer: 16384, timeout: 60000 });
    return { report: normalizeConformanceReport(JSON.parse(text), engine),
      archiveSha256: sha256(archive), reportSha256: sha256(text), evidenceSource: "protected-host-report-artifact" };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export async function collectEngineConformanceEvidence(contractsFile, cache) {
  const contracts = readCensusJson(contractsFile);
  if (!Array.isArray(contracts) || !contracts.length) throw new Error("Missing frozen native conformance contracts");
  const directory = path.dirname(contractsFile);
  const git = gitEvidence(contracts[0].repository, cache).git;
  let requests = 0, downloadedBytes = 0;
  const request = async (endpoint, binary = false) => {
    if (++requests > 2000) throw new Error("Conformance API request budget exhausted");
    const { stdout } = await execute("gh", ["api", endpoint], { encoding: binary ? "buffer" : "utf8",
      maxBuffer: binary ? 64 * 1024 * 1024 : 8 * 1024 * 1024, timeout: 60000, env: { ...process.env, GH_PAGER: "cat" } });
    if (binary) {
      downloadedBytes += stdout.length;
      if (downloadedBytes > 512 * 1024 * 1024) throw new Error("Conformance compressed log byte budget exhausted");
      return stdout;
    }
    return JSON.parse(stdout);
  };
  const summary = [];
  for (const contract of contracts) {
    const file = path.join(directory, `${contract.workflowId}-v2.json.gz`);
    if (existsSync(file)) {
      const retained = readCensusJson(file);
      if (retained.contractSha256 !== conformanceAcquisitionDigest(contract) || retained.complete !== true
        || censusDigest(retained.observations) !== retained.observationsSha256) throw new Error("Retained conformance evidence is incomplete or conflicts with the frozen function");
      summary.push({ workflowId: contract.workflowId, retained: true, available: retained.observations.filter(row => row.status === "available").length });
      continue;
    }
    const { repository, workflowId, engine, until } = contract;
    const snapshot = { schemaVersion: 1, protocolVersion: 2, kind: "independent-engine-conformance", repository, workflowId,
      sourceRevision: contract.sourceRevision, since: contract.adoption.adoptedAt, until,
      contractSha256: conformanceAcquisitionDigest(contract), startedAt: new Date().toISOString(), complete: false,
      observations: [], errors: [], runInventory: [],
      executionScope: "All branch names with immutable execution heads in the frozen mainline ancestry, including gh-aw/work-queue/*.",
      previousArchive: `${workflowId}.json.gz`,
      previousArchiveLimitation: "The earlier main-branch-only acquisition excluded legitimate work-queue dispatches; it is not workflow-wide coverage." };
    const execution = `.github/workflows/${workflowId}.lock.yml`;
    try {
      const runs = new Map();
      let total;
      for (let page = 1; page <= 10; page++) {
        const endpoint = `repos/${repository}/actions/workflows/${workflowId}.lock.yml/runs?created=${encodeURIComponent(`${snapshot.since}..${until}`)}&per_page=100&page=${page}`;
        const response = await request(endpoint);
        if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count) || response.total_count > 1000) {
          throw new Error("Invalid or over-budget conformance run inventory");
        }
        total = response.total_count;
        for (const run of response.workflow_runs) {
          if (!positive(run.id) || !positive(run.run_attempt) || run.run_attempt > 20 || !isSha(run.head_sha)
            || run.path?.split("@")[0] !== execution || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()
            || runs.has(run.id)) throw new Error("Invalid or duplicate conformance run identity");
          runs.set(run.id, run);
        }
        if (runs.size >= total) break;
        if (!response.workflow_runs.length) throw new Error("Incomplete conformance run pagination");
      }
      if (runs.size !== total) throw new Error("Incomplete conformance run traversal");
      snapshot.runInventory = [...runs.values()].map(run => ({ id: run.id, attempts: run.run_attempt,
        headSha: run.head_sha, createdAt: run.created_at }));
      for (const run of runs.values()) {
        if (run.created_at >= until) continue;
        for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
          const observation = { id: `${run.id}:${attempt}`, runId: run.id, attempt, headSha: run.head_sha,
            at: run.run_started_at, status: "unavailable", observedAt: new Date().toISOString(),
            runUrl: conformanceAttemptUrl(run, repository, attempt) };
          try {
            git(["merge-base", "--is-ancestor", run.head_sha, contract.sourceRevision]);
            const locked = parse(git(["show", `${run.head_sha}:${execution}`]));
            const checker = locked.jobs?.agent?.steps?.find(step => step.name === "Assert engine conformance");
            if (!checker?.run || !contract.acceptedCheckerScripts.includes(sha256(checker.run))
              || ![undefined, false].includes(checker["continue-on-error"])
              || checker.env?.CONFORMANCE_ENGINE !== engine
              || checker.env?.CONFORMANCE_STATE !== "${{ runner.temp }}/engine-conformance"
              || checker.env?.CONFORMANCE_ROOT !== "/tmp/gh-aw/agent/engine-conformance") {
              throw new Error("Execution does not use the approved independent host checker and protected environment");
            }
            observation.checkerScriptSha256 = sha256(checker.run);
            const endpoint = `repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`;
            const jobs = await request(endpoint);
            if (!Array.isArray(jobs.jobs) || jobs.total_count > jobs.jobs.length) throw new Error("Incomplete conformance job inventory");
            const hosts = jobs.jobs.flatMap(job => (job.steps ?? []).filter(step => step.name === "Assert engine conformance")
              .map(step => ({ job, step })));
            if (hosts.length !== 1 || !hosts[0].step.completed_at) throw new Error("Independent host step did not complete");
            observation.at = hosts[0].step.completed_at;
            observation.hostStep = { jobId: hosts[0].job.id, number: hosts[0].step.number,
              name: hosts[0].step.name, status: hosts[0].step.status, conclusion: hosts[0].step.conclusion,
              startedAt: hosts[0].step.started_at, completedAt: hosts[0].step.completed_at };
            if (observation.at >= until) {
              observation.missingReason = "Host evidence matured after the frozen cutoff";
              snapshot.observations.push(observation);
              continue;
            }
            if (hosts[0].step.status === "completed" && hosts[0].step.conclusion === "success") {
              // These reviewed scripts exit unsuccessfully if any independent assertion fails.
              observation.report = conformanceHostStepProof(checker, hosts[0].step, contract);
              observation.evidenceSource = "source-verified-host-assertion-conjunction";
              observation.status = "available";
            } else {
              const artifacts = await request(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
              if (!Array.isArray(artifacts.artifacts) || artifacts.total_count > artifacts.artifacts.length) throw new Error("Incomplete host artifact inventory");
              const upload = hosts[0].job.steps.find(step => step.name === "Upload engine conformance evidence");
              const candidates = artifacts.artifacts.filter(artifact => artifact.name === `engine-conformance-${engine}`
                && !artifact.expired && artifact.created_at >= observation.at
                && upload?.completed_at && artifact.created_at <= upload.completed_at);
              if (candidates.length !== 1 || candidates[0].size_in_bytes > 1024 * 1024) throw new Error("No retained unambiguous host report for this failed assertion attempt");
              const archive = await request(`repos/${repository}/actions/artifacts/${candidates[0].id}/zip`, true);
              if (candidates[0].digest && candidates[0].digest !== `sha256:${sha256(archive)}`) throw new Error("Host artifact archive digest mismatch");
              Object.assign(observation, await readConformanceArtifact(archive, engine),
                { status: "available", artifactId: candidates[0].id });
            }
          } catch (error) {
            observation.missingReason = String(error.stderr || error.message).slice(0, 500);
            console.error(`${workflowId} ${observation.id}: native evidence unavailable`);
          }
          snapshot.observations.push(observation);
        }
      }
      snapshot.complete = true;
    } catch (error) {
      snapshot.errors.push(String(error.stderr || error.message).slice(0, 500));
      console.error(`${workflowId}: incomplete evidence acquisition`);
    }
    snapshot.completedAt = new Date().toISOString();
    snapshot.observationsSha256 = censusDigest(snapshot.observations);
    writeCensusJson(file, snapshot);
    summary.push({ workflowId, runs: snapshot.runInventory.length, observations: snapshot.observations.length,
      available: snapshot.observations.filter(row => row.status === "available").length, complete: snapshot.complete });
    console.error(JSON.stringify(summary.at(-1)));
  }
  return { summary, requests, downloadedBytes };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("usage: collect-engine-conformance-evidence.mjs CONTRACTS.json BARE_CACHE");
  console.log(JSON.stringify(await collectEngineConformanceEvidence(...args)));
}
