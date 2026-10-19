import { createHash } from "node:crypto";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/weekly-editors-health-check";
const packet = readJsonArchive(`${root}/run-discovery-page-1.json`);
const bytes = Buffer.from(packet.originalBody, "base64");
if (bytes.toString("base64") !== packet.originalBody
  || createHash("sha256").update(bytes).digest("hex") !== packet.receipt.bodySha256
  || bytes.length !== packet.receipt.bodyBytes || packet.receipt.status !== 200
  || packet.receipt.refusal || packet.receipt.attempts !== 1 || packet.receipt.additionalRequests !== 0) {
  throw new Error("Original single-request provider receipt integrity mismatch");
}
const body = JSON.parse(bytes);
const investigation = readJsonArchive(`${root}/investigation.json`);
const ids = new Set();
const workflowPath = ".github/workflows/weekly-editors-health-check.lock.yml";
const candidates = new Set(investigation.outputHistory.candidates.map(row => row.workflowReference?.runId));
if (!Array.isArray(body.workflow_runs) || !Number.isSafeInteger(body.total_count)
  || body.workflow_runs.length > 100) throw new Error("Malformed bounded provider page");
const runs = body.workflow_runs.map(run => {
  if (!Number.isSafeInteger(run.id) || ids.has(run.id) || run.path !== workflowPath
    || run.repository?.id !== 1036865607 || run.repository.full_name !== "github/gh-aw"
    || run.repository.private !== false || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.workflow_id !== 237095871
    || Date.parse(run.created_at) < Date.parse("2026-02-21T22:11:11Z")
    || Date.parse(run.created_at) >= Date.parse("2026-10-18T15:00:12Z")) {
    throw new Error("Out-of-scope or malformed workflow run identity");
  }
  const prefix = `https://api.github.com/repos/github/gh-aw/actions/runs/${run.id}`;
  for (const [field, expected] of Object.entries({
    url: prefix, jobs_url: `${prefix}/jobs`, logs_url: `${prefix}/logs`, artifacts_url: `${prefix}/artifacts`,
  })) if (run[field] !== expected) throw new Error("Provider evidence URL escaped authorized run scope");
  ids.add(run.id);
  return {
    id: run.id, nodeId: run.node_id, repositoryId: run.repository.id, workflowId: run.workflow_id,
    path: run.path, headSha: run.head_sha, runAttempt: run.run_attempt,
    createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at,
    status: run.status, conclusion: run.conclusion,
    survivingSeedOutputCandidate: candidates.has(String(run.id)),
    providerEndpoints: {
      metadata: `repos/github/gh-aw/actions/runs/${run.id}`,
      artifacts: `repos/github/gh-aw/actions/runs/${run.id}/artifacts`,
      jobs: `repos/github/gh-aw/actions/runs/${run.id}/jobs`,
      logs: `repos/github/gh-aw/actions/runs/${run.id}/logs`,
    },
    exactNextEndpoints: [
      `repos/github/gh-aw/actions/runs/${run.id}/artifacts?per_page=100&page=1`,
      ...Array.from({ length: run.run_attempt }, (_, index) => index + 1).flatMap(attempt => [
        `repos/github/gh-aw/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=1`,
        `repos/github/gh-aw/actions/runs/${run.id}/attempts/${attempt}/logs`,
      ]),
    ],
  };
});
const link = packet.receipt.headers.link ?? null;
const complete = body.total_count === runs.length && link === null;
const summary = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  workflow: "weekly-editors-health-check", workflowId: 237095871,
  acquisition: packet.receipt,
  scope: { createdFrom: "2026-02-21T22:11:11Z", createdUntil: "2026-10-18T15:00:12Z", perPage: 100, page: 1 },
  discovery: {
    totalCount: body.total_count, returnedCount: runs.length, link,
    nextCursor: link, providerReturnedAllMatchingRuns: complete,
    retainedCandidateRunCount: runs.filter(run => run.survivingSeedOutputCandidate).length,
    additionalRunsWithoutRetainedSeedOutputs: runs.filter(run => !run.survivingSeedOutputCandidate).length,
    oldestCreatedAt: runs.map(run => run.createdAt).sort()[0],
    newestCreatedAt: runs.map(run => run.createdAt).sort().at(-1),
    limitation: "One current provider listing, not an immutable historical execution ledger. Deleted runs and expired artifacts remain outside it. Provider totals and absent pagination do not establish response-evidence completeness.",
  },
  runs,
  originalReceiptScope: investigation.originalReceiptScope,
  nextAcquisition: {
    authorization: "not released",
    exactEndpoints: runs.flatMap(run => run.exactNextEndpoints),
    gates: [
      "Request a new coordinated slot before any further acquisition; no automatic pagination or artifact download.",
      "Bind actual attempts and producer jobs to returned run ID, repository ID, workflow path and immutable head SHA.",
      "Artifact listing establishes exact IDs, hashes and expiration before any artifact-byte acquisition is proposed.",
      "Only original tool request/response pairs with actual URL, timestamp and captured status can establish reachability.",
      "Do not count run success/failure as editor availability or missing artifacts as editor failure.",
    ],
  },
  nativeEvidence: { originalHttpReceipts: 0, acceptedNativeObservations: 0,
    availableEditorCount: null, failedEditorCount: null, functionChanged: false },
  predecessor: {
    file: "predecessor-closure-v018.json",
    archiveSha256: "e87be8f96431165719ffba42f4007ebaa16d050981046e29cc46e9960aa0c8ff",
    verifiedMemberCount: 22,
    interpretation: "Entire previous closure preserved through the existing lossless partition codec before this request.",
  },
};
writeJsonArchive(`${root}/run-discovery-summary.json`, summary);
console.log(JSON.stringify({ ...summary.discovery, pendingExactEndpoints: summary.nextAcquisition.exactEndpoints.length,
  latestRun: runs[0]?.id, oldestRun: runs.at(-1)?.id }));
