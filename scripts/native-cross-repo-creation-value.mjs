import { createHash } from "node:crypto";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

export function verifyCrossRepoGitObjects(rows) {
  if (!Array.isArray(rows) || rows.length > 300) throw new Error("Invalid bounded target Git proof");
  const objects = new Map();
  let bytesRead = 0;
  for (const row of rows) {
    if (!sha(row?.id) || !["blob", "tree", "commit"].includes(row.type) || typeof row.content !== "string"
      || objects.has(row.id)) throw new Error("Invalid target Git object identity");
    const bytes = Buffer.from(row.content, "base64");
    bytesRead += bytes.length;
    if (bytes.toString("base64") !== row.content || bytesRead > 4 * 1024 * 1024
      || gitHash(row.type, bytes) !== row.id) throw new Error("Target Git object digest mismatch");
    objects.set(row.id, { type: row.type, bytes });
  }
  return objects;
}

function commitTree(objects, id) {
  const object = objects.get(id);
  if (object?.type !== "commit") throw new Error("Missing immutable target commit");
  const match = object.bytes.toString("utf8").match(/^tree ([a-f0-9]{40})\n/);
  if (!match) throw new Error("Malformed immutable target commit");
  return match[1];
}

function descendsFrom(objects, head, base, visited = new Set()) {
  if (head === base) return true;
  if (visited.has(head)) return false;
  visited.add(head);
  const object = objects.get(head);
  if (object?.type !== "commit") throw new Error("Missing target ancestry proof");
  const header = object.bytes.toString("utf8").split("\n\n")[0];
  const parents = [...header.matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1]);
  return parents.some(parent => descendsFrom(objects, parent, base, visited));
}

function treeEntry(objects, root, file) {
  const [name, ...rest] = file.split("/");
  const object = objects.get(root);
  if (object?.type !== "tree") throw new Error("Missing full immutable target tree");
  const entries = new Map();
  for (let offset = 0; offset < object.bytes.length;) {
    const space = object.bytes.indexOf(32, offset), nul = object.bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 21 > object.bytes.length) throw new Error("Malformed target tree");
    const mode = object.bytes.subarray(offset, space).toString("ascii");
    const path = object.bytes.subarray(space + 1, nul).toString("utf8");
    const id = object.bytes.subarray(nul + 1, nul + 21).toString("hex");
    if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode)
      || !path || /[/\0]/.test(path) || entries.has(path)) throw new Error("Malformed target tree entry");
    entries.set(path, { id, mode });
    offset = nul + 21;
  }
  const entry = entries.get(name);
  if (!entry) return null;
  if (!rest.length) return entry;
  if (entry.mode !== "40000") return null;
  return treeEntry(objects, entry.id, rest.join("/"));
}

export function verifyCrossRepoDelivery(receipt, profile) {
  if (!receipt) return { passed: null, reason: "No independent immutable target readback." };
  const { run, target, pullRequest: pr } = receipt;
  if (!positive(run?.id) || run.attempt !== 1 || run.repositoryId !== 1036865607
    || !["github/gh-aw", "githubnext/gh-aw"].includes(run.repository)
    || run.sourceGitBlob !== profile.sourceGitBlob || !positive(target?.id)
    || target.repository !== profile.target || target.visibility !== "public"
    || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.completedAt))
    || Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
    throw new Error("Unbound target delivery evidence");
  }
  if (!positive(pr?.id) || !positive(pr.number) || pr.baseRepositoryId !== target.id
    || pr.headRepositoryId !== target.id || pr.repository !== target.repository
    || typeof pr.headBranch !== "string" || !pr.headBranch || typeof pr.baseBranch !== "string"
    || !pr.baseBranch || pr.headBranch === pr.baseBranch || !sha(pr.headCommit) || !sha(pr.baseCommit)
    || pr.headCommit === pr.baseCommit || !Number.isFinite(Date.parse(pr.createdAt))
    || Date.parse(pr.createdAt) < Date.parse(run.startedAt) || Date.parse(pr.createdAt) > Date.parse(run.completedAt)) {
    throw new Error("Missing independent PR branch/target binding");
  }
  const objects = verifyCrossRepoGitObjects(receipt.objects);
  if (!descendsFrom(objects, pr.headCommit, pr.baseCommit)) {
    return { passed: false, reason: "Target head is not a descendant of the pinned base." };
  }
  const file = `smoke-tests/smoke-${run.id}.txt`;
  const before = treeEntry(objects, commitTree(objects, pr.baseCommit), file);
  const after = treeEntry(objects, commitTree(objects, pr.headCommit), file);
  if (before || !after || after.mode !== "100644") return { passed: false, reason: "The prescribed regular file was not added." };
  const blob = objects.get(after.id);
  if (blob?.type !== "blob") throw new Error("Missing exact target fixture blob");
  const content = blob.bytes.toString("utf8");
  const lines = content.replace(/\n$/, "").split("\n");
  const timestamp = lines[2]?.match(/^Timestamp: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$/)?.[1];
  const passed = lines.length === 6 && lines[0] === `Smoke test run: ${run.id}`
    && lines[1] === `Repository: ${run.repository}`
    && timestamp !== undefined && Number.isFinite(Date.parse(timestamp))
    && new Date(timestamp).toISOString().replace(".000Z", "Z") === timestamp
    && Date.parse(timestamp) >= Date.parse(run.startedAt) && Date.parse(timestamp) <= Date.parse(pr.createdAt)
    && lines[3] === "Status: cross-repo PR creation smoke test" && lines[4] === ""
    && lines[5] === "1.  Tell me, O Muse, of that ingenious hero who travelled far and wide";
  return { passed, reason: passed ? null : "Exact fixture content or native UTC timestamp did not match.",
    file, blob: after.id, contentSha256: createHash("sha256").update(blob.bytes).digest("hex"),
    safeguards: { draft: pr.draft === true, smokeLabel: pr.labels?.includes("smoke-test") === true },
    workflowContribution: "not-measured" };
}

export function scoreCrossRepoCreation(id, evidence) {
  if (!["verified-deliveries", "complete-deliveries"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => !positive(row?.id) || ![true, false, null].includes(row.passed))) return null;
  const known = evidence.assessments.filter(row => row.passed !== null);
  if (!known.length || id === "complete-deliveries"
    && (evidence.coverageStatus !== "complete" || known.length !== evidence.assessments.length)) return null;
  const count = known.filter(row => row.passed === true).length;
  return count || evidence.coverageStatus === "complete" ? count : null;
}

export function crossRepoCreationModule(contract, expectedIndexSha256) {
  const sample = count => ({ valid: true, coverageStatus: "complete",
    assessments: [1, 2].map(id => ({ id, passed: id <= count })) });
  const presentation = name => ({ name, legendLabel: name, transform: "identity" });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Smoke Create Cross-Repo PR", sourcePath: ".github/workflows/smoke-create-cross-repo-pr.md",
    intent: { goal: "Deliver the exact run-specific smoke fixture on a new pull-request branch in the source-configured side repository.",
      acceptance: "Independent source-bound PR/base/head identities and immutable complete Git tree/blob proofs establish a newly added regular smoke-tests/smoke-RUN_ID.txt with exact prescribed content and a native UTC timestamp inside the original run.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "independent-cross-repository-fixture-delivery-v1",
      repositories: [contract.repository, "github/gh-aw-side-repo", "githubnext/gh-aw-side-repo"],
      opportunity: "One run-specific cross-repository fixture delivery per original workflow run, not each rerun or report.",
      filters: ["Retain source-era target ownership; never equate github and githubnext without immutable repository-identity proof.",
        "Only independently acquired PR target/base/head binding and exact immutable file content establish attainment.",
        "Source-repository issues, successful jobs, editable footers and unconsumed patches are discovery or mechanism evidence only.",
        "Unknown retained or deleted history is null, not zero. Known native deliveries may be shown as lower bounds through gaps.",
        "Draft, smoke-test labels, expiry, reporting, costs and contribution attribution are separate safeguards or unmeasured dimensions."],
      collection: "Replay the sealed public source/discovery archive and any independently acquired target Git receipts offline. Target reads were blocked by public-only authority; no target content was acquired.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
      sourceGitBlob: contract.sourceGitBlob, sourceRevision: contract.sourceRevision,
      contractSha256: censusDigest(contract), archiveIndexSha256: expectedIndexSha256, evidenceReadiness: "open-blocked" },
    model: { architecture: "Independent exact Git-object proof, source-era target identity and protected original-run binding.",
      recommendation: "Do not rate value until authorized independent target receipts exist; preserve every visible evidence gap.",
      presentation: { label: "Verified cross-repository fixture deliveries", betterLabel: "More verified native deliveries" } },
    summary: { nativeLabel: "Verified cross-repository fixture deliveries" },
    metrics: [
      { id: "verified-deliveries", role: "primary", name: "Independently verified fixture deliveries",
        formula: "Distinct original-run fixtures passing independent target, branch, base absence, Git blob and exact content checks; partial positive count is a lower bound.",
        unit: "fixture deliveries", direction: "increase", presentation: presentation("Verified deliveries") },
      { id: "complete-deliveries", role: "diagnostic", name: "Complete verified delivery count",
        formula: "Verified fixture deliveries only when the entire eligible period and every delivery assessment are independently complete.",
        unit: "fixture deliveries", direction: "increase", presentation: presentation("Complete deliveries") },
    ],
    validationExamples: { targetAttained: sample(2), targetMissed: sample(0), missing: {},
      malformed: { valid: true, assessments: [{ id: 1, passed: "success" }] } },
  };
  return { definition, scoreMetric: scoreCrossRepoCreation, collectBatch(requests) {
    const directory = "docs/operational-value/proof/cross-repo-creation";
    const index = readCensusJson(`${directory}/index.json`);
    const discovery = readCensusJson(`${directory}/discovery.json.gz`);
    const sources = readCensusJson(`${directory}/sources.json.gz`);
    const probes = readCensusJson(`${directory}/probes.json`);
    if (censusDigest(index) !== expectedIndexSha256 || index.contractSha256 !== censusDigest(contract)
      || index.probesSha256 !== censusDigest(probes) || index.discoverySha256 !== censusDigest(discovery)
      || index.sourcesSha256 !== censusDigest(sources) || !discovery.retainedInventoryComplete
      || index.status !== "open-blocked" || index.acceptedReceipts !== null) {
      throw new Error("Cross-repository evidence integrity/readiness changed");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Unsupported source repository");
      if (!Number.isFinite(Date.parse(request.windowStart)) || !Number.isFinite(Date.parse(request.windowEnd))
        || !Number.isFinite(Date.parse(request.observedAt)) || request.windowStart >= request.windowEnd
        || request.observedAt < request.windowEnd) throw new Error("Invalid cross-repository evaluation window");
      const selected = discovery.retained.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      return { evidence: { valid: true, assessments: selected.map(row => ({ id: row.id, passed: null })),
        coverageStatus: "missing", maturityStatus: "unavailable", eligibleCount: null,
        eligibleRetainedCount: selected.length, acceptedDeliveries: null, missingReason: index.missingReason,
        populationDigest: censusDigest(selected.map(row => row.id)), evidenceReadiness: "open-blocked",
        historicalOpportunityComplete: false, targetContentAcquired: false,
        costs: "not-measured", contribution: "not-measured", windowStart: request.windowStart, windowEnd: request.windowEnd },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "cross-repository-blocker-index-sha256", ref: censusDigest(index) }],
      commit: contract.sourceRevision };
    });
  } };
}
