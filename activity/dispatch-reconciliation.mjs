import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const WINDOW_MS = 30 * 60 * 1000;

export function reconcileDispatchCycles(cycles, artifacts, workerRuns, repository) {
  const observations = new Map();
  for (const cycle of cycles) {
    const evidence = artifacts.get(cycle.id);
    if (!Array.isArray(evidence?.requests) || !Array.isArray(evidence?.manifest)) {
      return { status: "incomplete", reason: `Missing dispatch evidence for orchestrator run ${cycle.id}` };
    }
    const requests = evidence.requests.filter((item) => item.type === "dispatch_workflow");
    const accepted = evidence.manifest.filter((item) => item.type === "dispatch_workflow");
    if (requests.length !== accepted.length || accepted.some((item) => !Number.isFinite(Date.parse(item.timestamp)))) {
      return { status: "incomplete", reason: `Dispatch requests and accepted outputs differ for orchestrator run ${cycle.id}` };
    }
    const expected = new Map();
    for (const [index, request] of requests.entries()) {
      const name = request.workflow_name;
      if (typeof name !== "string" || !name.startsWith("cao-evolution-")
        || request.inputs?.central_repo && request.inputs.central_repo !== repository
        || !request.inputs?.target_repo || !request.inputs?.correlation_id) {
        return { status: "incomplete", reason: `Invalid dispatch envelope in orchestrator run ${cycle.id}` };
      }
      const entries = expected.get(name) || [];
      entries.push({
        timestamp: Date.parse(accepted[index].timestamp),
        correlation: request.inputs.correlation_id,
        target: request.inputs.target_repo,
      });
      expected.set(name, entries);
    }
    for (const [name, entries] of expected) {
      const runs = workerRuns.get(name);
      if (!Array.isArray(runs)) return { status: "incomplete", reason: `Missing run list for ${name}` };
      const matched = new Set();
      for (const entry of entries) {
        const match = runs.find((run) => run.event === "workflow_dispatch" && !matched.has(run.id)
          && Date.parse(run.created_at) >= entry.timestamp - 2 * 60 * 1000
          && Date.parse(run.created_at) <= entry.timestamp + WINDOW_MS);
        if (match) matched.add(match.id);
      }
      const observation = observations.get(name) || [];
      observation.push({
        expected: entries.length,
        triggered: matched.size,
        correlations: entries.map((entry) => entry.correlation),
        targets: entries.map((entry) => entry.target),
      });
      observations.set(name, observation);
    }
  }
  const workers = [...observations].map(([name, entries]) => ({
    name,
    expected: entries.reduce((sum, entry) => sum + entry.expected, 0),
    triggered: entries.reduce((sum, entry) => sum + entry.triggered, 0),
    correlations: entries.flatMap((entry) => entry.correlations),
    targets: [...new Set(entries.flatMap((entry) => entry.targets))],
    deficientCycles: entries.filter((entry) => entry.triggered / entry.expected < 0.95).length,
  }));
  return {
    status: workers.some((worker) => worker.deficientCycles === cycles.length && cycles.length >= 2) ? "missing_data" : "healthy",
    workers,
  };
}

async function api(endpoint, token) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(new URL(endpoint, `${base}/`), {
    headers: { Authorization: ["Bearer", token].join(" "), Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub Actions read failed (${response.status})`);
  return response;
}

async function artifactContents(repository, runId, name, filename, token, optional = false) {
  const { artifacts } = await (await api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, token)).json();
  const artifact = artifacts?.find((item) => item.name === name && !item.expired);
  if (!artifact) {
    if (optional) return "";
    throw new Error(`Missing ${name} for orchestrator run ${runId}`);
  }
  const bytes = Buffer.from(await (await api(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, token)).arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error(`Oversized ${name} for orchestrator run ${runId}`);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cao-dispatch-"));
  try {
    const archive = path.join(directory, "artifact.zip");
    await writeFile(archive, bytes);
    return execFileSync("unzip", ["-p", archive, filename], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkDispatches({ repository, token, now = Date.now() }) {
  if (!repository || !token) throw new Error("Control repository or read credential unavailable");
  const policy = JSON.parse(await readFile(".github/workflows/cao.json", "utf8"));
  if (policy["control-plane"]?.campaigns?.["cao-evolution"]?.enabled === false
    || !policy["control-plane"]?.campaigns?.["cao-evolution"]) {
    return { status: "healthy", workers: [], reason: "CAO Evolution is not enabled in this control repository" };
  }
  const since = new Date(now - 4 * 60 * 60 * 1000).toISOString();
  const { workflow_runs: recent } = await (await api(
    `repos/${repository}/actions/workflows/cao-evolution.lock.yml/runs?per_page=20&created=%3E%3D${encodeURIComponent(since)}`, token,
  )).json();
  if (!Array.isArray(recent) || recent.length === 20) throw new Error("Incomplete orchestrator run list");
  const cycles = recent.filter((run) => run.status === "completed"
    && Date.parse(run.updated_at) <= now - WINDOW_MS
    && ["schedule", "workflow_dispatch"].includes(run.event)).slice(0, 2);
  if (cycles.length < 2) return { status: "incomplete", reason: "Fewer than two completed, matured orchestrator cycles in the last four hours" };

  const artifacts = new Map();
  for (const cycle of cycles) {
    const output = await artifactContents(repository, cycle.id, "agent-output-fallback", "agent_output.json", token);
    const requests = JSON.parse(output).items;
    const hasDispatch = !Array.isArray(requests) || requests.some((item) => item.type === "dispatch_workflow");
    const manifest = await artifactContents(repository, cycle.id, "safe-outputs-items", "safe-output-items.jsonl", token, !hasDispatch);
    artifacts.set(cycle.id, {
      requests,
      manifest: manifest.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)),
    });
  }
  const names = new Set([...artifacts.values()].flatMap(({ requests }) =>
    Array.isArray(requests) ? requests.filter((item) => item.type === "dispatch_workflow").map((item) => item.workflow_name) : []));
  const workerRuns = new Map();
  for (const name of names) {
    if (typeof name !== "string" || !/^cao-evolution-[a-z-]+$/.test(name)) {
      return { status: "incomplete", reason: "Invalid worker workflow name in dispatch evidence" };
    }
    const { workflow_runs: runs } = await (await api(
      `repos/${repository}/actions/workflows/${name}.lock.yml/runs?event=workflow_dispatch&per_page=100&created=%3E%3D${encodeURIComponent(since)}`, token,
    )).json();
    if (!Array.isArray(runs) || runs.length === 100) throw new Error(`Incomplete run list for ${name}`);
    workerRuns.set(name, runs);
  }
  return reconcileDispatchCycles(cycles, artifacts, workerRuns, repository);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await checkDispatches({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
    console.log(JSON.stringify(result));
    if (result.status !== "healthy") {
      console.log(`::error::CAO dispatch reconciliation ${result.status}: ${result.reason || result.workers.filter((worker) => worker.deficientCycles >= 2).map((worker) => `${worker.name} ${worker.triggered}/${worker.expected}`).join(", ")}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.log(`::error::CAO dispatch reconciliation incomplete: ${error.message}`);
    process.exitCode = 1;
  }
}
