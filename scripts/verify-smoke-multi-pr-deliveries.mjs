import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { multiPrAcquisition, multiPrScope } from "./collect-smoke-multi-pr-value.mjs";
import { assertMultiPrQuotaReady, multiPrAcquisitionStop, multiPrMap, multiPrRequest, multiPrZipEntries, retainMultiPrHttp } from "./collect-smoke-multi-pr-receipts.mjs";
import { multiPrFilename, multiPrHostProjection, multiPrOperations, multiPrPatchPayload } from "./native-smoke-multi-pr-value.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
class MultiPrEvidenceGap extends Error {}
let quotaBlocked = false;
const successful = step => step?.status === "completed" && step.conclusion === "success";
const quotaFailure = error => /HTTP (?:403|429)/.test(String(error.stderr));
async function nativeRequest(cache, endpoint) {
  if ((quotaBlocked || process.env.CAO_MULTI_PR_OFFLINE === "1")
    && !existsSync(path.join(cache, `${hash(endpoint)}.json`))) {
    quotaBlocked = true;
    throw new MultiPrEvidenceGap("Acquisition open: shared API quota pause; JSON request remains queued.");
  }
  try { return await multiPrRequest(cache, endpoint); }
  catch (error) {
    if (!quotaFailure(error) && !error.acquisitionPause) throw error;
    quotaBlocked = true;
    throw new MultiPrEvidenceGap("Acquisition open: GitHub quota/Retry-After pause; JSON request remains queued.");
  }
}
export async function multiPrBinary(cache, endpoint, extension) {
  if (!endpoint.startsWith("repos/github/gh-aw/")) throw new Error("Unapproved evidence repository");
  const file = path.join(cache, `${hash(endpoint)}.${extension}`);
  if (existsSync(file)) return readFileSync(file);
  const gone = `${file}.unavailable.json`;
  if (existsSync(gone)) throw new MultiPrEvidenceGap("Protected native receipt returned HTTP 404/410.");
  if (quotaBlocked || process.env.CAO_MULTI_PR_OFFLINE === "1") {
    quotaBlocked = true;
    throw new MultiPrEvidenceGap("Acquisition open: shared API quota exhausted; no uncached requests retried.");
  }
  try {
    assertMultiPrQuotaReady(cache);
    await setTimeout(1500);
    const { stdout } = await execute("gh", ["api", "--include", "--allow-escape-sequences", endpoint], {
      encoding: "buffer", timeout: 60000, maxBuffer: 48 * 1024 * 1024,
    });
    const body = retainMultiPrHttp(cache, endpoint, stdout);
    writeFileSync(file, body);
    const receipt = JSON.parse(readFileSync(path.join(cache, `${hash(endpoint)}.http.json`), "utf8"));
    if (receipt.responses.some(multiPrAcquisitionStop)) quotaBlocked = true;
    return body;
  } catch (error) {
    if (/^HTTP\/[\d.]+ \d{3}\b/.test(error.stdout?.subarray(0, 32).toString() ?? "")) retainMultiPrHttp(cache, endpoint, error.stdout);
    if (quotaFailure(error) || error.acquisitionPause) {
      quotaBlocked = true;
      throw new MultiPrEvidenceGap("Acquisition open: shared API quota exhausted; no uncached requests retried.");
    }
    if (/HTTP (404|410)/.test(String(error.stderr))) {
      writeFileSync(gone, JSON.stringify({ endpoint, observedAt: new Date().toISOString(), status: "unavailable" }));
      throw new MultiPrEvidenceGap("Protected native receipt returned HTTP 404/410.");
    }
    throw error;
  }
}

export function multiPrCheckout(text, step) {
  if (!successful(step)) throw new MultiPrEvidenceGap("No successful protected runtime checkout");
  const lines = text.split("\n").map(line => line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)\r?$/))
    .filter(match => match && Date.parse(match[1]) >= Date.parse(step.started_at)
      && Date.parse(match[1]) < Date.parse(step.completed_at) + 1000);
  const ids = lines.flatMap((line, index) => line[2].match(/^\[command\].*\/git log -1 --format=%H$/)
    && /^[a-f0-9]{40}$/.test(lines[index + 1]?.[2] ?? "") ? [lines[index + 1][2]] : []);
  if (ids.length !== 1) throw new MultiPrEvidenceGap("No unique protected runtime checkout SHA");
  return ids[0];
}

export function multiPrSummaryProjection(text, step) {
  if (!successful(step)) return { completeMessageEnumeration: false, reason: "Protected processing step did not complete successfully." };
  if (!Number.isFinite(Date.parse(step.started_at)) || !Number.isFinite(Date.parse(step.completed_at))) {
    throw new Error("Invalid protected processing timestamps");
  }
  const patterns = [
    /^Found \d+ message\(s\) in agent output$/,
    /^Processing \d+ message\(s\) in order of appearance\.\.\.$/,
    /^Processing message \d+\/\d+: [a-z_]+$/,
    /^No safe-output messages available - nothing to process$/,
    /^Safe Output Handler Manager completed$/,
    /^##\[warning\]Unable to determine issue\/PR number for append-only comment; skipping$/,
    /^Created comment: https:\/\/github\.com\/github\/gh-aw\/(?:issues|pull)\/\d+#issuecomment-\d+$/,
  ];
  const lines = text.split("\n").flatMap(line => {
    const match = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)\r?$/);
    return match && Date.parse(match[1]) >= Date.parse(step.started_at)
      && Date.parse(match[1]) < Date.parse(step.completed_at) + 1000 && patterns.some(pattern => pattern.test(match[2]))
      ? [{ at: match[1], message: match[2] }] : [];
  });
  const found = lines.flatMap(line => line.message.match(/^Found (\d+) message\(s\) in agent output$/)?.slice(1).map(Number) ?? []);
  const started = lines.flatMap(line => line.message.match(/^Processing (\d+) message\(s\) in order of appearance\.\.\.$/)?.slice(1).map(Number) ?? []);
  const handled = lines.flatMap(line => {
    const match = line.message.match(/^Processing message (\d+)\/(\d+): ([a-z_]+)$/);
    return match ? [{ ordinal: Number(match[1]), total: Number(match[2]), type: match[3] }] : [];
  });
  const empty = found.length === 1 && found[0] === 0 && started.length === 0 && handled.length === 0
    && lines.filter(line => line.message === "No safe-output messages available - nothing to process").length === 1;
  const complete = found.length === 1 && started.length === 1 && found[0] === started[0]
    && handled.length === started[0] && handled.every((item, index) => item.ordinal === index + 1 && item.total === started[0])
    && lines.filter(line => line.message === "Safe Output Handler Manager completed").length === 1;
  return { completeMessageEnumeration: empty || complete,
    processedTypes: empty ? [] : complete ? handled.map(item => item.type) : null,
    commentRequests: empty ? 0 : complete ? handled.filter(item => item.type === "add_comment").length : null,
    missingTriggerCommentWarnings: lines.filter(line => line.message.includes("Unable to determine issue/PR number")).length,
    candidateCommentUrls: lines.filter(line => line.message.startsWith("Created comment: ")).map(line => line.message.slice(17)),
    limitation: "Native handler enumeration only; not proof of comment contents, correct PR links or full goal acceptance.", lines };
}

export function nativeMultiPrPatch(cache, bytes, filename) {
  const payload = multiPrPatchPayload(bytes, filename);
  if (!payload) throw new MultiPrEvidenceGap("No exact single added-file native patch");
  const temporary = mkdtempSync(path.join(path.resolve(cache), "patch-"));
  try {
    const file = path.join(temporary, "input.patch");
    writeFileSync(file, bytes);
    const git = args => execFileSync("git", ["-C", temporary, ...args], {
      timeout: 30000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    git(["init", "--quiet"]);
    const stats = git(["apply", "--numstat", "-z", file]).toString("utf8").split("\0").filter(Boolean);
    if (stats.length !== 1 || stats[0].split("\t")[2] !== filename || stats[0].split("\t")[1] !== "0") {
      throw new MultiPrEvidenceGap("Native Git patch scope is not the intended addition");
    }
    git(["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", file]);
    const applied = readFileSync(path.join(temporary, filename));
    if (!payload.equals(applied)) throw new Error("Independent native Git application disagrees with patch interpreter");
    return { appliedPayloadSha256: hash(applied), nativeGitVersion: git(["--version"]).toString().trim() };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function additionalMultiPrLogs(cache, acquire = false) {
  const directory = multiPrScope.directory;
  const repository = JSON.parse(readFileSync(path.join(cache, `${hash(`repos/${multiPrScope.repository}`)}.json`), "utf8"));
  if (repository.id !== multiPrScope.repositoryId || repository.full_name !== multiPrScope.repository
    || repository.private !== false || repository.visibility !== "public") {
    throw new Error("Public repository authority is not established for the reserved log batch");
  }
  const receipts = readCensusJson(`${directory}/receipts.json.gz`);
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  const candidates = receipts.rows.flatMap(receipt => receipt.allJobNames
    .filter(job => /^safe[_ ]outputs$/i.test(job.name) && job.conclusion !== "skipped"
      && !receipt.safeJobs.some(item => item.id === job.id))
    .map(job => ({ ...job, runId: receipt.runId, endpoint: `repos/github/gh-aw/actions/jobs/${job.id}/logs` })));
  if (acquire) {
    const reserved = readCensusJson(`${directory}/additional-protected-jobs.json.gz`);
    const identity = rows => rows.map(row => [row.endpoint, row.id, row.runId]).sort((left, right) => left[0].localeCompare(right[0]));
    if (reserved.receiptInventorySha256 !== censusDigest(receipts) || censusDigest(reserved.scope) !== censusDigest(multiPrScope)
      || censusDigest(identity(reserved.rows)) !== censusDigest(identity(candidates))) {
      throw new Error("Reserved public log endpoints changed; acquire no requests outside the approved manifest");
    }
  }
  const rows = [];
  for (const candidate of candidates) {
    const endpoint = `repos/github/gh-aw/actions/runs/${candidate.runId}/attempts/1/jobs?per_page=100&page=1`;
    const native = JSON.parse(readFileSync(path.join(cache, `${hash(endpoint)}.json`), "utf8"));
    const receipt = receipts.rows.find(row => row.runId === candidate.runId);
    if (native.total_count !== native.jobs.length || censusDigest(native.jobs) !== receipt.jobsResponseSha256) {
      throw new Error("Additional protected job has no complete original initial-job inventory");
    }
    const job = native.jobs.find(job => job.id === candidate.id);
    if (!job || job.run_id !== candidate.runId || job.run_attempt !== 1) throw new Error("Unbound additional protected job");
    if (acquire) {
      try { await multiPrBinary(cache, candidate.endpoint, "log"); }
      catch (error) { if (!(error instanceof MultiPrEvidenceGap)) throw error; }
    }
    const file = path.join(cache, `${hash(candidate.endpoint)}.log`);
    const gone = existsSync(`${file}.unavailable.json`);
    const headerFile = path.join(cache, `${hash(candidate.endpoint)}.http.json`);
    const responseReceipt = existsSync(headerFile) ? JSON.parse(readFileSync(headerFile, "utf8")) : null;
    if (responseReceipt && responseReceipt.endpoint !== candidate.endpoint) throw new Error("Unbound protected-log response receipt");
    rows.push({ ...candidate, nativeJobSha256: censusDigest(job),
      run: inventory.runs.find(run => run.id === candidate.runId),
      availability: existsSync(file) ? "acquired-awaiting-source-and-step-binding" : gone ? "http-404-or-410" : "pending",
      httpStatus: responseReceipt?.responses.at(-1)?.status ?? null, responseReceipt,
      logSha256: existsSync(file) ? hash(readFileSync(file)) : null,
      job: { startedAt: job.started_at, completedAt: job.completed_at, headSha: job.head_sha,
        status: job.status, conclusion: job.conclusion, steps: job.steps ?? null } });
  }
  const result = { schemaVersion: 1, scope: multiPrScope, receiptInventorySha256: censusDigest(receipts),
    purpose: "Every non-skipped protected job lacking step metadata is explicitly inventoried; absence of step metadata is not an acquisition skip.",
    acquisitionOpen: rows.some(row => row.availability === "pending"),
    httpStatusCounts: Object.fromEntries(Object.entries(Object.groupBy(rows.filter(row => row.httpStatus !== null), row => row.httpStatus))
      .map(([key, rows]) => [key, rows.length])), rows };
  writeCensusJson(`${directory}/additional-protected-jobs.json.gz`, result);
  console.log(JSON.stringify({ additionalProtectedJobs: rows.length,
    availability: Object.fromEntries(Object.entries(Object.groupBy(rows, row => row.availability)).map(([key, rows]) => [key, rows.length])) }));
  return result;
}

export async function acquireMultiPrDeliveries(cache) {
  const scope = multiPrScope, directory = scope.directory;
  const inventory = readCensusJson(`${directory}/inventory.json.gz`);
  const receipts = readCensusJson(`${directory}/receipts.json.gz`);
  const contract = readCensusJson(`${directory}/contract.json`);
  if (!receipts.complete || receipts.inventorySha256 !== censusDigest(inventory)) throw new Error("Unreconciled native receipts");
  const { git, metadata, source, request } = multiPrAcquisition(cache);
  const repository = request("repos/github/gh-aw");
  if (repository.id !== scope.repositoryId || repository.full_name !== scope.repository
    || repository.private !== false || repository.visibility !== "public") throw new Error("Public repository authority is not established");
  const acquisitions = receipts.rows.filter(receipt => receipt.safeJobs.length).flatMap(receipt => [
    ...receipt.safeJobs.map(job => ({ endpoint: `repos/github/gh-aw/actions/jobs/${job.id}/logs`, extension: "log" })),
    ...(receipt.artifactInventory?.artifacts ?? []).filter(artifact => artifact.name === "agent" && !artifact.expired)
      .map(artifact => ({ endpoint: `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, extension: "zip" })),
  ]);
  await multiPrMap(acquisitions, async item => {
    try { await multiPrBinary(cache, item.endpoint, item.extension); }
    catch (error) { if (!(error instanceof MultiPrEvidenceGap)) throw error; }
  }, 1);
  const sources = new Map(), profiles = new Map(), pendingGitObjects = new Set();
  const ensureCommit = revision => {
    try { git(["cat-file", "-e", `${revision}^{commit}`]); }
    catch (error) {
      if (error.status !== 128) throw error;
      if (process.env.CAO_MULTI_PR_OFFLINE === "1") {
        pendingGitObjects.add(revision);
        throw new MultiPrEvidenceGap("Acquisition open: immutable native Git object is queued, not cached.");
      }
      git(["fetch", "--quiet", "origin", revision]);
    }
  };
  const nativeObject = (type, id) => ({ id, content: git(["cat-file", type, id], true).toString("base64") });
  const rows = [];
  for (const receipt of receipts.rows) {
    const run = inventory.runs.find(run => run.id === receipt.runId);
    const defaultProfile = contract.profiles.filter(profile => profile.at <= run.at)
      .toSorted((a, b) => a.at.localeCompare(b.at)).at(-1);
    const row = { run: { ...run, attempt: 1 }, era: defaultProfile?.era ?? "crlf",
      cases: [], gaps: [], receiptSha256: censusDigest(receipt) };
    if (!receipt.safeJobs.length) {
      row.gaps.push("No retained protected safe-output step metadata; initial job inventory retained, not an inferred zero.");
      rows.push(row);
      continue;
    }
    for (const job of receipt.safeJobs) {
      try {
        const steps = job.steps.filter(step => /^(?:Process Safe Outputs|Create Pull Request|Create pull request)$/.test(step.name));
        if (steps.length !== 1 || !steps[0].started_at || Date.parse(steps[0].completed_at) >= Date.parse(scope.until)) {
          throw new MultiPrEvidenceGap("No unique cutoff-bounded protected processing step");
        }
        const step = steps[0], bytes = await multiPrBinary(cache, `repos/github/gh-aw/actions/jobs/${job.id}/logs`, "log");
        const text = bytes.toString("utf8"), lines = multiPrHostProjection(text, step);
        const checkouts = job.steps.filter(item => item.name === "Checkout actions folder");
        if (checkouts.length !== 1) throw new MultiPrEvidenceGap("No unique source-bound runtime checkout");
        const checkout = multiPrCheckout(text, checkouts[0]);
        ensureCommit(checkout);
        const codePaths = ["create_pull_request.cjs", "push_signed_commits.cjs", "generate_git_patch.cjs", "process_safe_outputs.cjs"];
        const runtime = codePaths.map(name => source(checkout, `actions/setup/js/${name}`));
        for (const item of runtime) sources.set(item.gitBlob, item);
        const actionsEntry = source(checkout, "actions/setup/action.yml");
        sources.set(actionsEntry.gitBlob, actionsEntry);
        if (!["schedule", "workflow_dispatch"].includes(run.event) || run.headRepositoryId !== scope.repositoryId) {
          throw new MultiPrEvidenceGap("PR/dispatch context lacks an independently established compiled workflow revision");
        }
        ensureCommit(run.headSha);
        const workflow = source(run.headSha, ".github/workflows/smoke-multi-pr.md");
        const compiled = source(run.headSha, ".github/workflows/smoke-multi-pr.lock.yml");
        sources.set(workflow.gitBlob, workflow); sources.set(compiled.gitBlob, compiled);
        const reviewed = contract.profiles.find(profile => profile.workflowGitBlob === workflow.gitBlob);
        if (!reviewed) throw new MultiPrEvidenceGap("Execution intent is outside the reviewed frozen source variants");
        row.era = reviewed.era;
        const locked = parse(Buffer.from(compiled.content, "base64").toString("utf8"));
        const host = locked.jobs?.safe_outputs;
        if (!host || host["continue-on-error"] || host.container || !["ubuntu-slim", "ubuntu-latest"].includes(host["runs-on"])) {
          throw new MultiPrEvidenceGap("Unreviewed protected processing environment");
        }
        const processStep = host.steps.filter(item => item.name === step.name);
        const checkoutStep = host.steps.filter(item => item.name === "Checkout actions folder");
        if (processStep.length !== 1 || processStep[0]["continue-on-error"]
          || !/^actions\/github-script@[a-f0-9]{40}$/.test(processStep[0].uses ?? "")
          || checkoutStep.length !== 1 || checkoutStep[0].with?.repository !== scope.repository
          || checkoutStep[0].with?.ref || checkoutStep[0].with?.["sparse-checkout"]?.trim() !== "actions") {
          throw new MultiPrEvidenceGap("Protected runner/runtime checkout topology changed");
        }
        const profile = { checkout, workflowGitBlob: workflow.gitBlob, taskSha256: reviewed.taskSha256,
          compiledGitBlob: compiled.gitBlob, jobSha256: censusDigest(host),
          runtime: runtime.map(item => ({ path: item.path, gitBlob: item.gitBlob, sha256: item.sha256 })),
          actionGitBlob: actionsEntry.gitBlob };
        const profileId = censusDigest(profile);
        profiles.set(profileId, profile);
        const operations = multiPrOperations(lines);
        row.host = { profileId, logSha256: hash(bytes), jobId: job.id, step, lines, operations: operations.length,
          summaryEvidence: multiPrSummaryProjection(text, step) };
        const artifacts = receipt.artifactInventory?.artifacts;
        if (!Array.isArray(artifacts)) throw new MultiPrEvidenceGap("No complete artifact inventory");
        const candidates = artifacts.filter(item => item.name === "agent" && !item.expired
          && item.runId === run.id && item.headSha === run.headSha && item.size <= 8 * 1024 * 1024);
        if (candidates.length !== 1 || run.attemptCount !== 1) {
          throw new MultiPrEvidenceGap("No unmixed initial-attempt original agent artifact");
        }
        const artifact = candidates[0];
        const agent = locked.jobs?.agent;
        const upload = agent?.steps?.filter(item => item.with?.name === "agent" && /^actions\/upload-artifact@[a-f0-9]{40}$/.test(item.uses ?? ""));
        if (upload?.length !== 1 || !upload[0].with.path?.split("\n").includes("/tmp/gh-aw/aw-*.patch")) {
          throw new MultiPrEvidenceGap("No exact source-bound original patch upload contract");
        }
        const jobs = await nativeRequest(cache, `repos/github/gh-aw/actions/runs/${run.id}/attempts/1/jobs?per_page=100&page=1`);
        const agentName = agent.name ?? "agent";
        if (typeof agentName !== "string" || agentName.includes("${{")) throw new MultiPrEvidenceGap("Dynamic agent job name requires independent source binding");
        const agentJobs = jobs.jobs?.filter(item => item.name === agentName && item.run_id === run.id
          && item.run_attempt === 1 && item.head_sha === run.headSha);
        if (jobs.total_count !== jobs.jobs?.length || agentJobs?.length !== 1) {
          throw new MultiPrEvidenceGap("No complete unique initial agent-job upload receipt");
        }
        const uploadReceipts = agentJobs[0].steps?.filter(item => item.name === upload[0].name && successful(item));
        if (uploadReceipts?.length !== 1) throw new MultiPrEvidenceGap("No successful exact original-artifact upload receipt");
        const producer = { job: Object.fromEntries(["id", "name", "run_id", "run_attempt", "head_sha", "status", "conclusion"]
          .map(key => [key, agentJobs[0][key]])), step: uploadReceipts[0],
          jobSha256: censusDigest(agent), uploadStepSha256: censusDigest(upload[0]), artifactCreatedAt: artifact.createdAt };
        const archive = await multiPrBinary(cache, `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, "zip");
        if (artifact.digest !== `sha256:${hash(archive)}`) throw new MultiPrEvidenceGap("Original artifact provider digest absent or mismatched");
        const patches = multiPrZipEntries(cache, archive, name => /^aw-[a-z0-9-]+\.patch$/.test(name));
        for (const kind of ["doc", reviewed.era === "crlf" ? "crlf" : "config"]) {
          const fact = { kind, source: { ...profile, hostProfileSha256: profileId } };
          row.cases.push(fact);
          try {
            const branch = `smoke-multi-pr-${kind}-${run.id}-${kind === "doc" ? 1 : 2}`;
            const selected = patches.filter(item => item.entry === `aw-github-gh-aw-${branch}.patch` || item.entry === `aw-${branch}.patch`);
            if (selected.length !== 1) throw new MultiPrEvidenceGap("No unique original branch patch");
            const patch = selected[0];
            fact.payload = { branch, runId: run.id, artifactId: artifact.id, archiveSha256: hash(archive),
              producer,
              providerDigest: artifact.digest, patchEntry: patch.entry, patchBase64: patch.bytes.toString("base64"),
              patchSha256: hash(patch.bytes), ...nativeMultiPrPatch(cache, patch.bytes, multiPrFilename(run.id, kind)) };
            const matching = operations.filter(item => item.branch === branch || new RegExp(`^${branch}-[a-f0-9]+$`).test(item.branch));
            if (matching.length !== 1) throw new MultiPrEvidenceGap("No unique protected branch creation, signed-commit response and PR operation");
            const proof = matching[0];
            fact.operation = { jobId: job.id, step, logSha256: hash(bytes), lines, number: proof.number, proof };
            ensureCommit(proof.head); ensureCommit(proof.base);
            const headTree = metadata(["rev-parse", `${proof.head}^{tree}`]);
            const baseTree = metadata(["rev-parse", `${proof.base}^{tree}`]);
            const filename = multiPrFilename(run.id, kind);
            const blob = metadata(["rev-parse", `${proof.head}:${filename}`]);
            fact.target = { head: nativeObject("commit", proof.head), base: nativeObject("commit", proof.base),
              headTree: nativeObject("tree", headTree), baseTree: nativeObject("tree", baseTree), blob: nativeObject("blob", blob) };
          } catch (error) {
            if (!(error instanceof MultiPrEvidenceGap)) throw error;
            fact.missingReason = error.message;
          }
        }
      } catch (error) {
        if (!(error instanceof MultiPrEvidenceGap)) throw error;
        row.gaps.push(error.message);
      }
    }
    rows.push(row);
  }
  const candidates = await multiPrMap(inventory.candidates.filter(item => item.kind === "PullRequest"), async item => {
    const endpoint = `repos/github/gh-aw/pulls/${item.number}`;
    if ((quotaBlocked || process.env.CAO_MULTI_PR_OFFLINE === "1") && !existsSync(path.join(cache, `${hash(endpoint)}.json`))) {
      return { id: item.id, number: item.number, sourceRunCandidate: item.workflowReference,
        unavailable: { reason: "Acquisition open: shared API quota exhausted; candidate metadata not read." } };
    }
    let pr;
    try { pr = await nativeRequest(cache, endpoint); }
    catch (error) {
      if (!(error instanceof MultiPrEvidenceGap)) throw error;
      return { id: item.id, number: item.number, sourceRunCandidate: item.workflowReference,
        unavailable: { reason: error.message } };
    }
    if (pr.unavailable) return { id: item.id, number: item.number, unavailable: pr };
    if (pr.base?.repo?.id !== scope.repositoryId || pr.head?.repo?.id !== scope.repositoryId) {
      return { id: item.id, number: item.number, reason: "External/missing target repository is not authorized for content acquisition" };
    }
    const headerFile = path.join(cache, `${hash(endpoint)}.http.json`);
    const receipt = existsSync(headerFile) ? JSON.parse(readFileSync(headerFile, "utf8")) : null;
    const observedAt = receipt?.endpoint === endpoint && receipt.responses?.at(-1)?.status === 200
      && Number.isFinite(Date.parse(receipt.observedAt)) ? receipt.observedAt : null;
    return { id: item.id, number: item.number, createdAt: pr.created_at, head: pr.head.sha, base: pr.base.sha,
      branch: pr.head.ref, baseBranch: pr.base.ref, observedAt,
      responseSha256: censusDigest(pr), sourceRunCandidate: item.workflowReference,
      limitation: "Current editable PR metadata and head are discovery only; not backdated or accepted as original delivery." };
  }, 1);
  const pendingRequests = [];
  const queue = (endpoint, extension, kind, runId = null) => {
    const file = path.join(cache, `${hash(endpoint)}.${extension}`);
    if (!existsSync(file) && !existsSync(`${file}.unavailable.json`)) pendingRequests.push({ endpoint, kind, runId });
  };
  for (const receipt of receipts.rows) {
    for (const job of receipt.safeJobs) queue(`repos/github/gh-aw/actions/jobs/${job.id}/logs`, "log", "protected-job-log", receipt.runId);
    if (receipt.safeJobs.length) {
      for (const artifact of receipt.artifactInventory?.artifacts ?? []) {
        if (artifact.name === "agent" && !artifact.expired) queue(`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`, "zip", "original-agent-artifact", receipt.runId);
      }
    }
  }
  for (const candidate of inventory.candidates.filter(item => item.kind === "PullRequest")) {
    queue(`repos/github/gh-aw/pulls/${candidate.number}`, "json", "public-candidate-metadata");
  }
  const result = { complete: !quotaBlocked && !pendingRequests.length && !pendingGitObjects.size, opportunityInventoryComplete: true,
    acquisitionOpen: quotaBlocked || pendingRequests.length > 0 || pendingGitObjects.size > 0,
    scope, contractSha256: censusDigest(contract), inventorySha256: censusDigest(inventory),
    receiptInventorySha256: censusDigest(receipts), profiles: [...profiles].map(([id, profile]) => ({ id, ...profile })),
    rows, candidates, pendingRequests, pendingGitObjects: [...pendingGitObjects], sourceObjectsSha256: censusDigest([...sources.values()]) };
  writeCensusJson(`${directory}/host-sources.json.gz`, [...sources.values()]);
  writeCensusJson(`${directory}/deliveries.json.gz`, result);
  console.log(JSON.stringify({ observations: rows.length, hostProfiles: profiles.size,
    completeCaseReceipts: rows.flatMap(row => row.cases).filter(item => item.target).length,
    gaps: Object.fromEntries(Object.entries(Object.groupBy(rows.flatMap(row => row.gaps), item => item)).map(([key, rows]) => [key, rows.length])),
    publicPrCandidates: candidates.length, pendingRequests: pendingRequests.length }));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--prepare-additional") || process.argv.includes("--acquire-additional")) {
    await additionalMultiPrLogs(process.argv[2] ?? ".cache/smoke-multi-pr", process.argv.includes("--acquire-additional"));
  } else await acquireMultiPrDeliveries(process.argv[2] ?? ".cache/smoke-multi-pr");
}
