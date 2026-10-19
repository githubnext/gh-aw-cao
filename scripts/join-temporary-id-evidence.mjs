import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { blob, request } from "./collect-temporary-id-source.mjs";
import { assessTemporaryId, hashTemporaryId, readTemporaryId, temporaryIdDirectory as directory, temporaryIds } from "./native-temporary-id-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const index = readTemporaryId(`${directory}/index.json`);
const source = readTemporaryId(`${directory}/source-review.json.gz`);
const contract = readTemporaryId(`${directory}/contract.json`);
const rows = index.partitions.flatMap(part => readTemporaryId(`${directory}/${part.file}`));
const graphs = [];
const supplemental = existsSync(`${directory}/supplemental-readback.json.gz`)
  ? readTemporaryId(`${directory}/supplemental-readback.json.gz`) : null;
const graphFiles = Array.from({ length: Math.ceil(index.candidates / 20) }, (_, i) =>
  `github-graph-${String(i + 1).padStart(3, "0")}.json.gz`);
if (supplemental) graphFiles.push("github-graph-008.json.gz");
for (const file of graphFiles) {
  const part = readTemporaryId(`${directory}/${file}`);
  for (const issue of part.issues) if (issue) graphs.push({ ...issue, observedAt: part.observedAt, responseDigest: part.responseDigest });
}
const independentComments = (supplemental?.responses ?? []).filter(row => row.endpoint.includes("/issues/comments/"))
  .map(row => ({ ...JSON.parse(Buffer.from(row.original, "base64")), responseDigest: row.sha256, observedAt: row.acquiredAt }));
const runtimeSources = new Map();
const profiles = new Map();
const retainedReceipts = [];
const sourcePaths = [".github/workflows/smoke-temporary-id.md", ".github/workflows/smoke-temporary-id.lock.yml",
  "actions/setup/js/create_issue.cjs", "actions/setup/js/safe_output_handler_manager.cjs",
  "actions/setup/js/safe_output_manifest.cjs", "actions/setup/js/temporary_id.cjs",
  "actions/setup/js/sub_issue_helpers.cjs"];
function sourceAt(commit, file) {
  const entry = request(`repos/github/gh-aw/contents/${file}?ref=${commit}`);
  if (!runtimeSources.has(entry.sha)) runtimeSources.set(entry.sha, { path: file, ...blob(entry.sha) });
  return runtimeSources.get(entry.sha);
}
function zipEntry(file, name) {
  return execFileSync("unzip", ["-p", file, name], { maxBuffer: 8 * 1024 * 1024 });
}
for (const row of rows) {
  row.sourceBound = false;
  row.mapping = [];
  row.bodies = [];
  row.graph = [];
  row.comment = null;
  row.at = row.runCreatedAt ?? row.at;
  delete row.sourceProfile;
  delete row.receiptDigest;
  delete row.assessment;
  if (!row.initial || row.eligible === false || !row.receiptArtifacts?.some(item => item.digest)) continue;
  const safe = row.jobs.filter(job => job.name === "safe_outputs");
  if (safe.length !== 1 || safe[0].completedAt >= contract.until) {
    row.missing.push("No unique cutoff-valid protected safe_outputs job");
    continue;
  }
  const job = safe[0];
  const logKey = hash(JSON.stringify([`repos/github/gh-aw/actions/jobs/${job.id}/logs`, []]));
  const logBytes = readFileSync(`.cache/temporary-id/evidence/${logKey}.bin`);
  if (hash(logBytes) !== row.hostLog.digest) throw new Error("Protected host log changed");
  const lines = logBytes.toString("utf8").split("\n");
  const checkouts = lines.flatMap((line, i) => / \[command\]\/usr\/bin\/git log -1 --format=%H\r?$/.test(line)
    ? [lines[i + 1]?.match(/Z ([a-f0-9]{40})\r?$/)?.[1]] : []).filter(Boolean);
  if (checkouts.length !== 1 || checkouts[0] !== row.headSha || !["schedule", "workflow_dispatch"].includes(row.event)) {
    row.missing.push("Protected checkout is ambiguous or not a reviewed scheduled/manual immutable head");
    continue;
  }
  if (!profiles.has(row.headSha)) {
    const compare = request(`repos/github/gh-aw/compare/${row.headSha}...${contract.sourceRevision}`);
    if (compare.merge_base_commit?.sha !== row.headSha) throw new Error("Runtime source is not an ancestor of the frozen revision");
    const units = sourcePaths.map(file => sourceAt(row.headSha, file));
    const workflow = units[0];
    if (!source.profiles.some(profile => profile.gitBlob === workflow.gitBlob)) throw new Error("Unreviewed workflow goal profile");
    const lock = parse(units[1].content);
    const host = lock.jobs?.safe_outputs;
    if (!host || host.container || host["continue-on-error"] || !Array.isArray(host.steps)) throw new Error("Unsafe receipt producer host");
    const process = host.steps.filter(step => step.name === "Process Safe Outputs");
    const upload = host.steps.filter(step => step.name === "Upload Safe Outputs Items");
    const checkout = host.steps.filter(step => step.name === "Checkout actions folder");
    if (process.length !== 1 || upload.length !== 1 || checkout.length !== 1
      || !/^actions\/github-script@[a-f0-9]{40}$/.test(process[0].uses)
      || !process[0].with?.script?.includes("process_safe_outputs.cjs")
      || !/^actions\/upload-artifact@[a-f0-9]{40}$/.test(upload[0].uses)
      || upload[0].with?.name !== "safe-outputs-items"
      || !upload[0].with.path?.includes("/tmp/gh-aw/temporary-id-map.json")
      || checkout[0].with?.repository !== "github/gh-aw" || checkout[0].with.ref
      || process[0]["continue-on-error"] || upload[0]["continue-on-error"]) throw new Error("Unreviewed protected artifact producer profile");
    profiles.set(row.headSha, { headSha: row.headSha, workflowGitBlob: workflow.gitBlob, lockGitBlob: units[1].gitBlob,
      units: units.map(unit => ({ path: unit.path, gitBlob: unit.gitBlob, sha256: unit.sha256 })),
      processStepSha256: hashTemporaryId(process[0]), uploadStepSha256: hashTemporaryId(upload[0]),
      checkoutStepSha256: hashTemporaryId(checkout[0]), hostJobSha256: hashTemporaryId(host),
      ancestorOfFrozenRevision: true });
  }
  const archiveReceipts = row.receiptArtifacts.filter(item => item.digest);
  if (archiveReceipts.length !== 1) {
    row.missing.push("Multiple receipt artifacts have no independently verified upload order");
    continue;
  }
  const receipt = archiveReceipts[0];
  const artifact = row.artifacts.find(item => item.id === receipt.id);
  const file = `.cache/temporary-id/evidence/${receipt.cacheFile}`;
  const bytes = readFileSync(file);
  if (hash(bytes) !== receipt.digest || artifact.digest !== `sha256:${receipt.digest}`
    || !lines.some(line => line.includes(`SHA256 digest of uploaded artifact is ${receipt.digest}`))) {
    throw new Error("Protected provider/upload/archive receipt digest mismatch");
  }
  const names = execFileSync("unzip", ["-Z", "-1", file], { encoding: "utf8" }).trim().split("\n");
  if (new Set(names).size !== names.length || names.some(name => !["safe-output-items.jsonl", "temporary-id-map.json", "safe-output-errors.json"].includes(name))) {
    throw new Error("Unexpected protected receipt archive members");
  }
  if (!names.includes("safe-output-items.jsonl") || !names.includes("temporary-id-map.json")) {
    row.missing.push("Protected upload exists but its archive has no temporary-ID map; publication is not resolution evidence");
    continue;
  }
  const mapBytes = zipEntry(file, "temporary-id-map.json");
  const manifestBytes = zipEntry(file, "safe-output-items.jsonl");
  const map = JSON.parse(mapBytes);
  const manifest = manifestBytes.toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  retainedReceipts.push({ id: row.id, artifactId: receipt.id, artifactDigest: receipt.digest,
    archive: bytes.toString("base64"),
    mapSha256: hash(mapBytes), manifestSha256: hash(manifestBytes),
    map, manifest, logDigest: row.hostLog.digest, sourceProfile: profiles.get(row.headSha),
    uploadReceiptLines: lines.filter(line => line.includes(`SHA256 digest of uploaded artifact is ${receipt.digest}`)),
    checkoutReceiptLines: lines.filter(line => line.includes("/usr/bin/git log -1 --format=%H") || line.endsWith(row.headSha)),
    hostMappingLines: row.hostLog.mappingLines });
  const mapping = temporaryIds.map(temporaryId => {
    const target = map[temporaryId];
    const created = manifest.filter(item => item.type === "create_issue" && item.temporaryId === temporaryId
      && item.number === target?.number && item.repo === target?.repo);
    const issue = graphs.find(issue => issue.number === target?.number);
    if (created.length !== 1 || !issue || created[0].timestamp >= job.completedAt
      || created[0].metadata?.node_id && created[0].metadata.node_id !== issue.id
      || !row.hostLog.mappingLines.some(line => line.includes(`Stored temporary ID mapping: ${temporaryId} -> github/gh-aw#${target.number}`))) return null;
    return { temporaryId, repository: target.repo, number: target.number, nodeId: issue.id };
  });
  if (mapping.every(item => !item)) {
    row.missing.push("Protected mapping has no complete independently joined three-issue identity set");
    continue;
  }
  row.sourceBound = true;
  row.sourceProfile = profiles.get(row.headSha);
  row.receiptDigest = receipt.digest;
  row.mapping = mapping;
  row.at = job.completedAt;
  row.bodies = mapping.map(item => {
    if (!item) return null;
    const issue = graphs.find(issue => issue.id === item.nodeId);
    return { number: issue.number, nodeId: issue.id, body: issue.body, responseDigest: issue.responseDigest,
      lastEditedAt: issue.lastEditedAt ?? issue.createdAt, observedAt: issue.observedAt };
  }).filter(Boolean);
  row.graph = mapping.slice(1).map(child => {
    if (!child || !mapping[0]) return null;
    const issue = graphs.find(issue => issue.id === child.nodeId);
    const timeline = issue.timelineItems;
    const events = timeline.nodes.filter(event => event.__typename.startsWith("ParentIssue") && event.parent?.id === mapping[0].nodeId)
      .map(event => ({ action: event.__typename === "ParentIssueAddedEvent" ? "added" : "removed", at: event.createdAt }));
    return { childId: child.nodeId, parentId: mapping[0].nodeId, responseDigest: issue.responseDigest,
      currentLinked: issue.parent?.id === mapping[0].nodeId, historyComplete: !timeline.pageInfo.hasNextPage && timeline.nodes.length === timeline.totalCount,
      events, observedAt: issue.observedAt };
  }).filter(Boolean);
  const comments = manifest.filter(item => item.type === "add_comment" && item.repo === "github/gh-aw");
  row.comment = null;
  row.missing = ["Summary comments require independent parent-target readback; manifest publication alone does not establish summary acceptance."];
  row.commentCandidates = comments.map(item => ({ id: item.id ?? null, url: item.url ?? null, timestamp: item.timestamp }));
  for (const item of comments) {
    const comment = independentComments.find(comment => comment.html_url === item.url);
    const parent = mapping[0];
    if (!parent || !comment || comment.issue_url !== `https://api.github.com/repos/github/gh-aw/issues/${parent.number}`
      || item.number !== parent.number || item.timestamp >= job.completedAt
      || comment.created_at >= job.completedAt || comment.updated_at >= job.completedAt
      || !comment.body.trim()) continue;
    row.comment = { id: comment.id, targetNodeId: parent.nodeId, createdAt: comment.created_at,
      lastEditedAt: comment.updated_at, observedAt: comment.observedAt,
      receiptDigest: receipt.digest, responseDigest: comment.responseDigest };
    row.missing = [];
  }
  row.assessment = assessTemporaryId(row);
}
writeFileSync(`${directory}/protected-receipts.json.gz`, gzipSync(JSON.stringify(retainedReceipts)));
writeJsonArchive(`${directory}/runtime-source-review.json.gz`, { profiles: [...profiles.values()], sources: [...runtimeSources.values()] }, { spacing: 0 });
for (const part of index.partitions) {
  const original = readTemporaryId(`${directory}/${part.file}`);
  const ids = new Set(original.map(row => row.id));
  const updated = rows.filter(row => ids.has(row.id));
  for (const row of updated) row.missing = [...new Set(row.missing)];
  writeFileSync(`${directory}/${part.file}`, gzipSync(JSON.stringify(updated)));
  part.sha256 = hashTemporaryId(updated);
}
const assessed = rows.filter(row => row.initial && row.sourceBound).map(row => ({ id: row.id, ...assessTemporaryId(row) }));
index.protectedReceipts = retainedReceipts.length;
index.sourceBoundTriplets = assessed.length;
index.nativeResolvedReferences = assessed.flatMap(row => row.references).filter(value => value === true).length;
index.nativeParentChildLinks = assessed.flatMap(row => row.hierarchy).filter(value => value === true).length;
index.nativeAcceptedTriplets = assessed.some(row => row.complete !== null) ? assessed.filter(row => row.complete === true).length : null;
index.fullyMappedTriplets = rows.filter(row => row.sourceBound && row.mapping.every(Boolean)).length;
index.receiptSha256 = hashTemporaryId(retainedReceipts);
index.runtimeSourceSha256 = hashTemporaryId({ profiles: [...profiles.values()], sources: [...runtimeSources.values()] });
index.graphPartitions = graphFiles.map(file => ({ file, sha256: hashTemporaryId(readTemporaryId(`${directory}/${file}`)) }));
if (supplemental) index.supplementalReadbackSha256 = hashTemporaryId(supplemental);
index.independentIssueNodes = new Set(graphs.map(issue => issue.id)).size;
index.eligibleProtectedHostScopes = rows.filter(row => row.initial && row.eligible !== false
  && row.jobs.some(job => job.name === "safe_outputs" && job.startedAt && job.conclusion !== "skipped")).length;
index.limitations = [
  "Actions inventories cannot recover deleted runs; shared complete output discovery is cross-checked.",
  "The eligible denominator includes separately labelled unknown job-history eligibility, not an inferred absence of work.",
  "Editable output discovery omits some map targets; all eighteen canonical mapped identities now have independent public graph/body reads.",
  "Missing protected mapping, historical body state, graph history or summary receipt remains null, not zero.",
  "Known native counts are partial demonstrated outcomes, not complete historical totals, a workflow-caused effect or a cost-adjusted trend.",
  "The standard evaluator retains cadence windows plus cutoff-aligned comparison windows; overlapping snapshot windows must not be summed as unique outcomes.",
];
const openScopes = {
  schemaVersion: 1, repository: contract.repository, cutoff: contract.until,
  acquisitionStatus: "All declared run/attempt and eligible protected-host scopes were visited; unavailable historical receipts and unknown job eligibility remain open, not inferred absent.",
  apiStatus: "Paused. No automatic retry, credential change or new API request is performed by this projection.",
  scopes: rows.filter(row => row.initial && row.eligible !== false && assessTemporaryId(row).complete !== true).map(row => ({
    id: row.id, runCreatedAt: row.runCreatedAt, eligible: row.eligible,
    jobsResponseDigest: row.jobsResponseDigest,
    eligibilityRequest: row.eligible === null ? `repos/github/gh-aw/actions/runs/${row.runId}/attempts/${row.attempt}/jobs?per_page=100` : null,
    protectedHostRequests: row.jobs.filter(job => job.name === "safe_outputs" && job.startedAt && job.conclusion !== "skipped")
      .map(job => ({ endpoint: `repos/github/gh-aw/actions/jobs/${job.id}/logs`,
        acquired: Boolean(row.hostLog?.digest), unavailableStatus: row.hostLog?.status ?? null })),
    artifactInventory: row.artifactsResponseDigest ? {
      endpoint: `repos/github/gh-aw/actions/runs/${row.runId}/artifacts?per_page=100`,
      responseDigest: row.artifactsResponseDigest,
    } : null,
    receiptArtifacts: row.receiptArtifacts ?? [],
    sourceBound: row.sourceBound, mapping: row.mapping,
    nativeAssessment: assessTemporaryId(row), missing: row.missing,
    protectedCommentCandidates: row.commentCandidates ?? [],
  })),
};
writeFileSync(`${directory}/open-evidence-scopes.json.gz`, gzipSync(JSON.stringify(openScopes)));
index.openEvidenceScopesSha256 = hashTemporaryId(openScopes);
index.evidenceReadiness = index.nativeResolvedReferences ? "native partial outcomes; full acceptance and incomplete historical intervals remain explicit" : "blocked";
writeFileSync(`${directory}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ protectedReceipts: retainedReceipts.length, sourceBoundTriplets: assessed.length,
  resolvedReferences: index.nativeResolvedReferences, parentChildLinks: index.nativeParentChildLinks,
  acceptedTriplets: index.nativeAcceptedTriplets, runtimeProfiles: profiles.size, runtimeBlobs: runtimeSources.size }));
