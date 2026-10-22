import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
const hex = /^[0-9a-f]{64}$/;
const imagePattern = /^ghcr\.io\/([a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*)\/cao-server@sha256:([0-9a-f]{64})$/;
const conclusions = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const collectorSHA256 = hash(readFileSync(new URL(import.meta.url)));
const github = new URL("https://github.com");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const id = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const unknown = (reason) => ({ status: "unknown", reason });

export async function runGh(args) {
  try {
    const { stdout } = await exec("gh", args, {
      encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    });
    return stdout;
  } catch {
    // CLI diagnostics can contain registry responses or credential-bearing URLs.
    throw new Error("GitHub evidence command failed; raw diagnostics withheld");
  }
}

async function document(command, args) {
  const raw = await command(args);
  requireValue(typeof raw === "string" && Buffer.byteLength(raw) <= 2 * 1024 * 1024, "Evidence response exceeds its bound");
  try { return { value: JSON.parse(raw), sha256: hash(raw) }; }
  catch { throw new Error("Evidence response is not valid JSON"); }
}

async function optional(read) {
  try { return await read(); }
  catch { return unknown("unavailable-or-invalid"); }
}

async function inventory(get, path, key) {
  const records = [];
  for (let page = 1; page <= 5; page++) {
    const data = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireValue(Array.isArray(data[key]) && data[key].length <= 100, "Invalid evidence inventory");
    records.push(...data[key]);
    if (data[key].length < 100) return { status: "observed", records };
  }
  return { status: "incomplete", reason: "pagination-bound", records };
}

async function runEvidence(get, repository, runId, role, revision) {
  const run = await get(`actions/runs/${runId}`);
  const workflow = role === "package" ? "cao-package.yml" : "release-promote.yml";
  requireValue(run.id === runId && id(run.run_attempt) && sha.test(run.head_sha)
    && run.repository?.full_name?.toLowerCase() === repository.toLowerCase()
    && run.path === `.github/workflows/${workflow}`, "Run identity does not match the selected repository and workflow");
  const attempt = `actions/runs/${runId}/attempts/${run.run_attempt}`;
  const jobs = await optional(async () => {
    const result = await inventory(get, `${attempt}/jobs`, "jobs");
    return { ...result, records: result.records.map((job) => {
      requireValue(id(job.id) && job.run_id === runId && job.run_attempt === run.run_attempt
        && sha.test(job.head_sha) && job.head_sha === run.head_sha, "Job identity mismatch");
      return {
        id: job.id, conclusion: conclusions.has(job.conclusion) ? job.conclusion : "unknown",
        reference: `${github.origin}/${repository}/actions/runs/${runId}/job/${job.id}`,
        steps: (job.steps ?? []).slice(0, 100).map((step) => ({
          number: id(step.number) ? step.number : null,
          conclusion: conclusions.has(step.conclusion) ? step.conclusion : "unknown",
        })),
        stepsComplete: Array.isArray(job.steps) && job.steps.length <= 100,
      };
    }) };
  });
  const artifacts = await optional(async () => {
    const result = await inventory(get, `actions/runs/${runId}/artifacts`, "artifacts");
    return { ...result, attemptBinding: "unknown", records: result.records.map((artifact) => {
      requireValue(id(artifact.id), "Invalid artifact identity");
      return {
        id: artifact.id,
        role: artifact.name === `cao-server-${runId}-${run.run_attempt}` ? "sealed-candidate"
          : artifact.name === `release-promotion-evidence-${runId}` ? "promotion-evidence" : "unknown",
        digest: /^sha256:[0-9a-f]{64}$/.test(artifact.digest) ? artifact.digest : null,
        expired: typeof artifact.expired === "boolean" ? artifact.expired : null,
        expiresAt: timestamp(artifact.expires_at) ? artifact.expires_at : null,
      };
    }) };
  });
  const approvals = await optional(async () => {
    const reviews = await get(`actions/runs/${runId}/approvals`);
    requireValue(Array.isArray(reviews) && reviews.length <= 100, "Invalid approval inventory");
    return {
      status: reviews.length ? "observed" : "unknown", reason: reviews.length ? null : "no-approval-records",
      attemptBinding: "unknown", independentApproval: "unknown",
      records: reviews.map((review) => ({
        state: ["approved", "rejected", "pending"].includes(review.state) ? review.state : "unknown",
        actorId: id(review.user?.id) ? review.user.id : null,
        environmentIds: (review.environments ?? []).slice(0, 100).map((env) => id(env.id) ? env.id : null),
        environmentsComplete: Array.isArray(review.environments) && review.environments.length <= 100,
      })),
    };
  });
  return {
    id: runId, attempt: run.run_attempt, workflow: `.github/workflows/${workflow}`, workflowRevision: run.head_sha,
    sourceBinding: role === "package" && run.event === "push" && run.head_sha === revision ? "push-revision-matches" : "unknown",
    conclusion: conclusions.has(run.conclusion) ? run.conclusion : "unknown",
    reference: `${github.origin}/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}`,
    jobs, artifacts, approvals,
  };
}

async function verifyProvenance(command, repository, revision, image, run) {
  const args = [
    "attestation", "verify", `oci://${image}`, "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/cao-package-publish.yml`,
    "--source-digest", revision, "--predicate-type", "https://slsa.dev/provenance/v1",
    "--limit", "10", "--format", "json", "--hostname", github.hostname,
  ];
  const receipt = await document(command, args);
  requireValue(Array.isArray(receipt.value) && receipt.value.length > 0 && receipt.value.length <= 10, "Invalid verification receipt");
  const digest = image.split("@sha256:")[1];
  const expectedInvocation = run.reference;
  const matched = receipt.value.some((entry) => {
    const statement = entry.verificationResult?.statement;
    return statement?.predicateType === "https://slsa.dev/provenance/v1"
      && statement.subject?.some((subject) => subject.name === image.split("@")[0] && subject.digest?.sha256 === digest)
      && statement.predicate?.runDetails?.metadata?.invocationId === expectedInvocation;
  });
  requireValue(matched, "Verified provenance does not bind the exact image and package run attempt");
  return {
    status: "verified-by-gh", receiptSHA256: receipt.sha256, invocation: expectedInvocation,
    subject: image, sourceDigestConstraint: revision, predicateType: "https://slsa.dev/provenance/v1", command: args,
    rawReceiptRetained: false,
  };
}

function summarizeAzureReceipt(receipt, revision, bytes) {
  requireValue(receipt.kind === "cao.deploy.azure.receipt" && receipt.schemaVersion === 1
    && receipt.sourceRevision === revision && sha.test(receipt.sourceRevision)
    && receipt.environment === "development" && receipt.imageAssurance === "not-evaluated-development-only"
    && ["clean", "dirty"].includes(receipt.sourceWorktree)
    && hex.test(receipt.contextSha256) && hex.test(receipt.planSha256)
    && timestamp(receipt.startedAt) && timestamp(receipt.completedAt)
    && Date.parse(receipt.startedAt) <= Date.parse(receipt.completedAt), "Invalid or mismatched Azure development receipt");
  requireValue(Array.isArray(receipt.images) && receipt.images.length >= 2 && receipt.images.length <= 3, "Invalid Azure image inventory");
  const targets = new Set();
  const images = receipt.images.map((image) => {
    requireValue(["azure-functions-runtime", "azure-ingest-runtime", "azure-empty-ingest-runtime", "azure-db-provision"].includes(image.target)
      && !targets.has(image.target) && /^sha256:[0-9a-f]{64}$/.test(image.digest)
      && /^[a-z0-9]+\.azurecr\.io\/[a-z0-9][a-z0-9_.-]*@sha256:[0-9a-f]{64}$/.test(image.reference)
      && image.reference.endsWith(`@${image.digest}`) && image.configuredReference === image.reference
      && image.scan === "not-performed" && image.sbom === "not-generated"
      && image.provenance === "local-context-not-attested", "Invalid Azure image identity or assurance");
    targets.add(image.target);
    return {
      target: image.target, digest: image.digest,
      referenceSHA256: hash(image.reference), configuredReferenceMatches: true,
      scan: image.scan, sbom: image.sbom, provenance: image.provenance,
    };
  });
  requireValue(targets.has("azure-functions-runtime")
    && Number(targets.has("azure-ingest-runtime")) + Number(targets.has("azure-empty-ingest-runtime")) === 1, "Missing Azure image target");
  const checks = ["health", "readiness", "signed-out-campaigns", "root-login", "github-oauth", "scm-denied"];
  requireValue(Array.isArray(receipt.verification) && receipt.verification.length <= checks.length, "Invalid Azure verification inventory");
  const verification = receipt.verification.map((check) => {
    requireValue(checks.includes(check.check) && typeof check.passed === "boolean"
      && Number.isInteger(check.status) && check.status >= 100 && check.status <= 599
      && timestamp(check.checkedAt), "Invalid Azure verification check");
    return { check: check.check, passed: check.passed, status: check.status, checkedAt: check.checkedAt };
  });
  return {
    status: "reported", attribution: "owner-supplied-local-receipt", receiptSHA256: hash(bytes),
    sourceRevision: revision, sourceWorktree: receipt.sourceWorktree, contextSHA256: receipt.contextSha256,
    planSHA256: receipt.planSha256, environment: "development", imageAssurance: receipt.imageAssurance,
    startedAt: receipt.startedAt, completedAt: receipt.completedAt, images, verification,
    runningImageMeasurement: "unknown", independentVerification: "unknown",
  };
}

async function readBoundedReceipt(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValue((await file.stat()).isFile(), "Receipt must be a regular file");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    requireValue(length < buffer.length, "Azure receipt exceeds its bound");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await file.close(); }
}

export async function collectReleaseEvidence(options, { command = runGh, now = () => new Date(), loadReceipt = readBoundedReceipt } = {}) {
  const { repository, revision, image, packageRun, promotionRun, azureReceipt, verify = false } = options;
  requireValue(typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && sha.test(revision) && id(packageRun) && (promotionRun === undefined || id(promotionRun)), "Explicit repository, source SHA and positive run IDs are required");
  const match = imagePattern.exec(image);
  requireValue(match && match[1] === repository.toLowerCase(), "Select this repository's exact ghcr.io cao-server image digest");
  const get = async (path) => (await document(command, ["api", "--hostname", github.hostname, "--method", "GET", `repos/${repository}/${path}`])).value;
  const githubCli = await optional(async () => {
    const version = await command(["--version"]);
    requireValue(typeof version === "string" && version.length <= 4096, "Invalid GitHub CLI version");
    const match = /^gh version (\d+\.\d+\.\d+)(?:[ +(-]|$)/.exec(version);
    requireValue(match, "Invalid GitHub CLI version");
    return { status: "observed", version: match[1] };
  });
  const packageEvidence = await runEvidence(get, repository, packageRun, "package", revision);
  const promotion = promotionRun === undefined ? unknown("not-selected")
    : await runEvidence(get, repository, promotionRun, "promotion", revision);
  const provenance = verify ? await optional(() => verifyProvenance(command, repository, revision, image, packageEvidence))
    : unknown("verification-not-selected");
  let deployment = unknown("receipt-not-selected");
  if (azureReceipt) {
    let bytes;
    try { bytes = await loadReceipt(azureReceipt); }
    catch { throw new Error("Cannot read selected Azure receipt"); }
    requireValue(Buffer.byteLength(bytes) <= 1024 * 1024, "Azure receipt exceeds its bound");
    let value;
    try { value = JSON.parse(bytes); } catch { throw new Error("Azure receipt is not valid JSON"); }
    deployment = summarizeAzureReceipt(value, revision, bytes);
  }
  return {
    kind: "cao.release.evidence", schemaVersion: 1, collectedAt: now().toISOString(),
    status: "incomplete", repository, sourceRevision: revision, image,
    collector: { scriptSHA256: collectorSHA256, nodeVersion: process.version, githubCli },
    attribution: "owner-invoked-read-only-github-collection",
    package: packageEvidence, promotion, provenance, deployment,
    imageSourceBinding: provenance.status === "verified-by-gh" ? "verified-by-gh" : "unknown",
    deployedImageDigest: unknown("configured-read-back-is-not-running-image-measurement"),
    independentRetention: unknown("owner-must-export-and-verify"),
    governance: "not-assessed", operatingEffectiveness: "not-assessed",
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    repository: { type: "string" }, revision: { type: "string" }, image: { type: "string" },
    "package-run": { type: "string" }, "promotion-run": { type: "string" },
    "azure-receipt": { type: "string" }, "verify-provenance": { type: "boolean" },
    output: { type: "string" },
  } });
  requireValue(values.output, "An explicit new --output file is required");
  const report = await collectReleaseEvidence({
    repository: values.repository, revision: values.revision, image: values.image,
    packageRun: Number(values["package-run"]),
    promotionRun: values["promotion-run"] === undefined ? undefined : Number(values["promotion-run"]),
    azureReceipt: values["azure-receipt"], verify: values["verify-provenance"],
  });
  const file = await open(values.output, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Release evidence collection failed; check inputs, GitHub access and output availability. Raw diagnostics withheld.");
    process.exitCode = 1;
  });
}
