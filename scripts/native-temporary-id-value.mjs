import { createHash } from "node:crypto";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const temporaryIdDirectory = "docs/operational-value/proof/temporary-id";
export const hashTemporaryId = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const temporaryIds = ["aw_test01", "aw_test02", "aw_test03"];
export const referenceEdges = [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]];
export const hierarchyEdges = [[1, 0], [2, 0]];
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function readTemporaryId(file) {
  return readJsonArchive(file);
}

export function assessTemporaryId(row) {
  const unknown = { references: referenceEdges.map(() => null), hierarchy: hierarchyEdges.map(() => null), complete: null };
  if (!row || row.sourceBound !== true || !sha256(row.receiptDigest) || !Array.isArray(row.mapping)
    || row.mapping.length !== 3 || new Set(row.mapping.filter(Boolean).map(item => item.number)).size !== row.mapping.filter(Boolean).length
    || row.mapping.some((item, i) => item !== null && (item?.temporaryId !== temporaryIds[i] || !positive(item.number)
      || typeof item.nodeId !== "string" || !item.nodeId || item.repository !== "github/gh-aw"))) return unknown;
  const at = Date.parse(row.at);
  if (!Number.isFinite(at)) return unknown;
  const bodies = row.mapping.map(item => {
    if (item === null) return null;
    const body = row.bodies?.find(body => body.nodeId === item.nodeId && body.number === item.number);
    if (!body || typeof body.body !== "string" || !sha256(body.responseDigest)
      || !Number.isFinite(Date.parse(body.lastEditedAt)) || Date.parse(body.lastEditedAt) > at
      || !Number.isFinite(Date.parse(body.observedAt)) || Date.parse(body.observedAt) < at) return null;
    return body.body;
  });
  const references = referenceEdges.map(([from, to]) => {
    if (bodies[from] === null || row.mapping[to] === null) return null;
    const target = row.mapping[to].number;
    const expected = from === 0
      ? new RegExp(`^\\s*-\\s+(?:github/gh-aw)?#${target}(?![0-9])\\s*$`, "m")
      : new RegExp(`^\\s*${to === 0 ? "Parent" : "Related"}:\\s*(?:github/gh-aw)?#${target}(?![0-9])\\s*$`, "m");
    return expected.test(bodies[from]);
  });
  const hierarchy = hierarchyEdges.map(([child, parent]) => {
    if (!row.mapping[child] || !row.mapping[parent]) return null;
    const edge = row.graph?.find(item => item.childId === row.mapping[child].nodeId
      && item.parentId === row.mapping[parent].nodeId);
    if (!edge || !sha256(edge.responseDigest) || !Array.isArray(edge.events)
      || edge.historyComplete !== true || !Number.isFinite(Date.parse(edge.observedAt))
      || Date.parse(edge.observedAt) < at || ![true, false].includes(edge.currentLinked)) return null;
    if (edge.events.some(event => !["added", "removed"].includes(event.action)
      || !Number.isFinite(Date.parse(event.at)))) return null;
    let linked = edge.currentLinked;
    for (const event of [...edge.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
      if (Date.parse(event.at) > at) linked = event.action === "removed";
    }
    return linked;
  });
  const comment = row.mapping[0] && row.comment?.targetNodeId === row.mapping[0].nodeId
    && sha256(row.comment?.receiptDigest) && sha256(row.comment?.responseDigest)
    && Date.parse(row.comment.createdAt) <= at && Date.parse(row.comment.lastEditedAt) <= at
    && Date.parse(row.comment.observedAt) >= at;
  const all = [...references, ...hierarchy];
  const unresolved = bodies.some(body => body !== null && /#aw_[A-Za-z0-9_]+/.test(body));
  const complete = all.includes(false) || unresolved ? false : all.every(value => value === true) && comment ? true : null;
  return { references, hierarchy, complete };
}

export function scoreTemporaryId(id, evidence) {
  const field = { "resolved-references": "references", "linked-children": "hierarchy", "accepted-triplets": "complete" }[id];
  if (!field || evidence?.valid !== true || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length) return null;
  const values = evidence.assessments.flatMap(row => {
    if (!row || typeof row.id !== "string" || !row.id || row[field] === undefined) return [undefined];
    const value = row[field];
    if (field === "complete") return [value];
    return Array.isArray(value) && value.length === (field === "references" ? 6 : 2) ? value : [undefined];
  });
  if (values.some(value => ![true, false, null].includes(value)) || values.every(value => value === null)) return null;
  return values.filter(value => value === true).length;
}

export function collectTemporaryId(requests, contract) {
  const index = readTemporaryId(`${temporaryIdDirectory}/index.json`);
  if (index.contractSha256 !== hashTemporaryId(contract) || index.inventoryComplete !== true) {
    throw new Error("Temporary-ID inventory or contract mismatch");
  }
  const sourceReview = readTemporaryId(`${temporaryIdDirectory}/source-review.json.gz`);
  const receipts = readTemporaryId(`${temporaryIdDirectory}/protected-receipts.json.gz`);
  const runtime = readTemporaryId(`${temporaryIdDirectory}/runtime-source-review.json.gz`);
  if (hashTemporaryId(sourceReview) !== index.sourceReviewSha256 || hashTemporaryId(receipts) !== index.receiptSha256
    || hashTemporaryId(runtime) !== index.runtimeSourceSha256) throw new Error("Temporary-ID acquisition evidence changed");
  const supplemental = index.supplementalReadbackSha256
    ? readTemporaryId(`${temporaryIdDirectory}/supplemental-readback.json.gz`) : null;
  if (supplemental && hashTemporaryId(supplemental) !== index.supplementalReadbackSha256) {
    throw new Error("Temporary-ID coordinated acquisition changed");
  }
  const independentComments = [];
  for (const response of supplemental?.responses ?? []) {
    const bytes = Buffer.from(response.original, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== response.sha256 || bytes.length !== response.bytes
      || response.status !== 200) throw new Error("Temporary-ID coordinated original response changed");
    if (response.endpoint.includes("/issues/comments/")) {
      independentComments.push({ data: JSON.parse(bytes), digest: response.sha256, observedAt: response.acquiredAt });
    }
  }
  for (const unit of [...sourceReview.sources, ...sourceReview.profiles, ...sourceReview.historicalImports, ...runtime.sources]) {
    const bytes = Buffer.from(unit.content);
    if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== unit.gitBlob
      || createHash("sha256").update(bytes).digest("hex") !== unit.sha256) throw new Error("Temporary-ID retained Git source changed");
  }
  const graphs = index.graphPartitions.flatMap(part => {
    if (!/^github-graph-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe temporary-ID graph partition");
    const data = readTemporaryId(`${temporaryIdDirectory}/${part.file}`);
    if (hashTemporaryId(data) !== part.sha256) throw new Error("Temporary-ID independent graph evidence changed");
    const original = supplemental?.responses.find(response => response.endpoint === "graphql" && response.sha256 === data.responseDigest);
    if (original) {
      const repository = JSON.parse(Buffer.from(original.original, "base64")).data.repository;
      const originalIssues = Object.entries(repository).filter(([key]) => key !== "databaseId").map(([, issue]) => issue);
      if (hashTemporaryId(originalIssues) !== hashTemporaryId(data.issues) || data.observedAt !== original.acquiredAt) {
        throw new Error("Temporary-ID coordinated graph projection differs from original response");
      }
    }
    return data.issues.filter(Boolean).map(issue => ({ ...issue, observedAt: data.observedAt, responseDigest: data.responseDigest }));
  });
  const rows = index.partitions.flatMap(part => {
    if (!/^observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe temporary-ID partition");
    const rows = readTemporaryId(`${temporaryIdDirectory}/${part.file}`);
    if (hashTemporaryId(rows) !== part.sha256 || rows.length !== part.count) throw new Error("Temporary-ID evidence integrity mismatch");
    return rows;
  });
  if (rows.length !== index.attempts || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error("Incomplete temporary-ID attempt inventory");
  }
  for (const row of rows.filter(row => row.sourceBound)) {
    const receipt = receipts.find(item => item.id === row.id && item.artifactDigest === row.receiptDigest);
    if (!receipt || !receipt.archive || createHash("sha256").update(Buffer.from(receipt.archive, "base64")).digest("hex") !== row.receiptDigest
      || !runtime.profiles.some(profile => hashTemporaryId(profile) === hashTemporaryId(row.sourceProfile))) {
      throw new Error("Temporary-ID proof has no matching retained protected source/receipt");
    }
    for (const item of row.mapping.filter(Boolean)) {
      const mapped = receipt.map[item.temporaryId];
      const manifest = receipt.manifest.filter(entry => entry.type === "create_issue" && entry.temporaryId === item.temporaryId
        && entry.number === item.number && entry.repo === item.repository);
      if (mapped?.number !== item.number || mapped?.repo !== item.repository || manifest.length !== 1
        || manifest[0].metadata?.node_id && manifest[0].metadata.node_id !== item.nodeId) {
        throw new Error("Temporary-ID identity differs from its protected map/manifest");
      }
    }
    for (const body of row.bodies) {
      const graph = graphs.find(issue => issue.id === body.nodeId && issue.number === body.number);
      if (!graph || graph.body !== body.body || (graph.lastEditedAt ?? graph.createdAt) !== body.lastEditedAt
        || graph.observedAt !== body.observedAt || graph.responseDigest !== body.responseDigest) {
        throw new Error("Temporary-ID body proof has no matching independent GitHub readback");
      }
    }
    for (const edge of row.graph) {
      const graph = graphs.find(issue => issue.id === edge.childId);
      if (!graph) throw new Error("Temporary-ID graph proof has no matching independent GitHub readback");
      const timeline = graph.timelineItems;
      const expected = { childId: edge.childId, parentId: edge.parentId, responseDigest: graph.responseDigest,
        currentLinked: graph.parent?.id === edge.parentId,
        historyComplete: !timeline.pageInfo.hasNextPage && timeline.nodes.length === timeline.totalCount,
        events: timeline.nodes.filter(event => event.__typename.startsWith("ParentIssue") && event.parent?.id === edge.parentId)
          .map(event => ({ action: event.__typename === "ParentIssueAddedEvent" ? "added" : "removed", at: event.createdAt })),
        observedAt: graph.observedAt };
      if (hashTemporaryId(edge) !== hashTemporaryId(expected)) throw new Error("Temporary-ID graph projection differs from acquired timeline");
    }
    if (row.comment) {
      const parent = row.mapping[0];
      const original = independentComments.find(item => item.data.id === row.comment.id);
      const data = original?.data;
      const manifest = receipt.manifest.filter(item => item.type === "add_comment" && item.url === data?.html_url
        && item.repo === contract.repository && item.number === parent?.number);
      if (!parent || !data || manifest.length !== 1 || data.issue_url !== `https://api.github.com/repos/github/gh-aw/issues/${parent.number}`
        || parent.nodeId !== row.comment.targetNodeId || row.comment.receiptDigest !== row.receiptDigest
        || row.comment.createdAt !== data.created_at || row.comment.lastEditedAt !== data.updated_at
        || row.comment.responseDigest !== original.digest || row.comment.observedAt !== original.observedAt
        || !data.body?.trim()) throw new Error("Temporary-ID comment has no matching protected receipt and independent parent-target readback");
    }
  }
  return requests.map(request => {
    if (request.repository && request.repository !== contract.repository) throw new Error("Temporary-ID repository mismatch");
    if (!Number.isFinite(Date.parse(request.windowStart)) || !Number.isFinite(Date.parse(request.windowEnd))
      || request.windowStart >= request.windowEnd) throw new Error("Invalid temporary-ID evidence window");
    const selected = rows.filter(row => row.initial && row.eligible !== false
      && row.at >= request.windowStart && row.at < request.windowEnd);
    const assessments = selected.map(row => ({ id: row.id, ...assessTemporaryId(row) }));
    const known = assessments.flatMap(row => [...row.references, ...row.hierarchy]).filter(value => value !== null).length;
    const confirmedEligibleCount = selected.filter(row => row.eligible === true).length * 6;
    const unknownEligibilityCount = selected.filter(row => row.eligible === null).length;
    return { evidence: { valid: request.windowEnd <= contract.until, assessments,
      eligibleCount: unknownEligibilityCount ? null : confirmedEligibleCount,
      confirmedEligibleCount, unknownEligibilityCount, candidateSlotCount: selected.length * 6,
      populationDigest: hashTemporaryId(selected.map(row => row.id)), inventoryAttempts: selected.length,
      coverageStatus: known === selected.length * 8 && selected.length ? "complete" : known ? "partial" : "missing",
      missingReason: known ? null : "No source-bound protected temporary-ID receipt joined to cutoff-valid issue bodies and graph history.",
      unresolvedCount: selected.length * 8 - known, costs: "not-measured", workflowCausation: "not-measured" },
    provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
      { repository: contract.repository, kind: "protected-receipt-body-graph-join", ref: hashTemporaryId(index) }],
    commit: contract.sourceRevision };
  });
}
