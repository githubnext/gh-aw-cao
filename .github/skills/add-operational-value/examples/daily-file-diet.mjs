#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonArchive } from "../scripts/json-archive.mjs";
import { writePulse } from "../scripts/render-pulse.mjs";
import { requireArgs, writeJson } from "../scripts/common.mjs";

const repository = "github/gh-aw";
const sourcePath = ".github/workflows/daily-file-diet.md";
const sourceRevision = "0782148c0af21f4f1d10b7cb5e81b571ed58c463";
const aliases = [repository, "githubnext/gh-aw"];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const eligible = value => typeof value === "string" && value.startsWith("pkg/")
  && value.endsWith(".go") && !value.endsWith("_test.go");

export function readFileDietProof(directory) {
  const proof = readJsonArchive(path.join(directory, "proof.json.gz"));
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.repository, repository);
  assert.equal(proof.sourcePath, sourcePath);
  assert.deepEqual(proof.aliases, aliases);
  assert.ok(sha(proof.adoption.commit) && sha(proof.adoption.baselineCommit));
  assert.ok(Date.parse(proof.adoption.at) < Date.parse(proof.until));
  assert.ok(Date.parse(proof.observedAt) >= Date.parse(proof.until));
  for (const rows of [proof.issues, proof.pulls]) {
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate output identity");
    assert.equal(new Set(rows.map(row => row.number)).size, rows.length, "Duplicate output number");
  }
  const inventories = new Map();
  const blobs = new Map();
  for (const part of proof.inventoryPartitions) {
    assert.match(part.file, /^inventory-[a-f0-9]{40}\.json\.gz$/);
    assert.equal(part.file, `inventory-${part.commit}.json.gz`);
    const inventory = readJsonArchive(path.join(directory, part.file));
    assert.equal(digest(inventory), part.sha256, "Inventory partition digest mismatch");
    assert.equal(inventory.commit, part.commit);
    assert.equal(inventory.inventoryDigest, digest(inventory.files), "Inventory digest mismatch");
    assert.equal(new Set(inventory.files.map(file => file.path)).size, inventory.files.length);
    for (const file of inventory.files) {
      assert.ok(eligible(file.path) && sha(file.blob)
        && Number.isSafeInteger(file.lines) && file.lines >= 0
        && Number.isSafeInteger(file.bytes) && file.bytes >= file.lines, "Invalid native file inventory");
      const counts = [file.lines, file.bytes];
      if (blobs.has(file.blob)) assert.deepEqual(blobs.get(file.blob), counts, "Conflicting blob measurements");
      else blobs.set(file.blob, counts);
    }
    assert.ok(!inventories.has(part.commit), "Duplicate inventory revision");
    inventories.set(part.commit, inventory.files);
  }
  assert.equal(blobs.size, proof.uniqueBlobs);
  return { proof, inventories };
}

function receiptVerified(issue) {
  const receipt = issue.receipt;
  if (receipt?.status !== "available") return false;
  assert.equal(String(receipt.runId), issue.reference.runId);
  assert.equal(receipt.headSha, issue.run.validation?.headSha);
  assert.equal(createHash("sha256").update(receipt.content).digest("hex"), receipt.entrySha256);
  assert.equal(`sha256:${receipt.archiveSha256}`, receipt.digest);
  const rows = receipt.content.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 1, "Unrecognized multi-output creation receipt");
  const item = rows[0];
  assert.equal(item.type, "create_issue");
  assert.equal(item.number, issue.number);
  if (Object.hasOwn(item, "metadata")) assert.equal(item.metadata.node_id, issue.id);
  assert.ok(aliases.includes(item.repo));
  assert.equal(item.url, `https://github.com/${item.repo}/issues/${issue.number}`);
  return true;
}

export function fileDietEvents({ proof, inventories }) {
  const inventory = commit => {
    assert.ok(sha(commit) && inventories.has(commit), "Missing immutable inventory");
    return inventories.get(commit);
  };
  const oversized = commit => inventory(commit).filter(file => file.lines >= 800).length;
  const root = `https://github.com/${repository}`;
  const eligibleIssues = proof.issues.filter(issue => issue.eligible !== false
    && issue.receipt?.status !== "not-applied-to-output");
  const receipts = new Set(eligibleIssues.filter(receiptVerified).map(issue => issue.number));
  const events = [];
  let undatedClosingLinks = 0;
  for (const pull of proof.pulls) {
    if (!pull.mergedAt || Date.parse(pull.mergedAt) >= Date.parse(proof.until)) continue;
    assert.equal(pull.graph.id, pull.id, "Merged implementation identity mismatch");
    assert.equal(pull.graph.state, "MERGED", "Implementation is not merged");
    assert.equal(pull.graph.mergeCommit, pull.mergeSha, "Accepted revision mismatch");
    assert.equal(pull.graph.mergedAt, pull.mergedAt, "Acceptance time mismatch");
    const lineage = [];
    const linked = eligibleIssues.filter(issue => {
      if (Date.parse(issue.createdAt) > Date.parse(pull.createdAt)) return false;
      const connection = issue.timeline.events.filter(event => ["connected", "disconnected"].includes(event.type)
        && event.target?.kind === "pull-request" && event.target.number === pull.number
        && Date.parse(event.at) <= Date.parse(pull.mergedAt))
        .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1);
      const connected = connection?.type === "connected";
      const closing = pull.graph.edges.some(edge => edge.relation === "declares-closing" && edge.target.id === issue.id);
      const closedBy = issue.graph?.edges?.find(edge => edge.relation === "closed-by" && edge.target.id === pull.id
        && Date.parse(edge.at) >= Date.parse(pull.mergedAt) && Date.parse(edge.at) <= Date.parse(proof.observedAt));
      const referencedBy = issue.graph?.edges?.find(edge => edge.relation === "referenced-by" && edge.target.id === pull.id
        && Date.parse(edge.at) <= Date.parse(pull.mergedAt));
      if (closing && !connected && !closedBy) undatedClosingLinks++;
      if (closing || connected) {
        for (const edge of [referencedBy, connected ? { relation: "connected", at: connection.at } : null, closedBy]) {
          if (edge) lineage.push({ outputId: issue.id, implementationId: pull.id, relation: edge.relation, at: edge.at });
        }
      }
      return closing || connected;
    });
    if (!linked.length) continue;
    const before = inventory(pull.preMergeSha);
    const after = inventory(pull.mergeSha);
    const targets = [...new Set(linked.map(issue => issue.targetPath).filter(Boolean))].map(target =>
      `${target}: ${before.find(file => file.path === target)?.lines ?? "absent"} -> `
      + `${after.find(file => file.path === target)?.lines ?? "absent"} lines`);
    const additions = pull.files.filter(file => ["added", "renamed"].includes(file.status) && eligible(file.path))
      .map(file => `${file.path} (${after.find(item => item.path === file.path)?.lines ?? "absent"})`);
    events.push({
      id: pull.id, at: pull.mergedAt,
      lineage,
      acceptance: { state: "accepted", at: pull.mergedAt, ref: pull.mergeSha },
      value: oversized(pull.preMergeSha) - oversized(pull.mergeSha),
      attribution: linked.some(issue => receipts.has(issue.number)) ? "receipt-verified" : "corroborated",
      label: `${repository}#${pull.number}`,
      ...(pull.title ? { title: pull.title } : {}),
      summary: targets.length
        ? `${targets[0]}. ${additions.length} production files added or renamed. File structure is measured; unchanged behavior is not verified.`
        : "The oversized-file count is measured before and after this merge. Unchanged behavior is not verified.",
      detail: `${targets.join(". ")}${additions.length ? `. Added ${additions.join(", ")}` : ""}. `
        + "Net change includes replacement oversized files. Behavior preservation and full acceptance remain unverified. Shared workflow-enabled contribution.",
      evidence: [
        { label: "Merged PR", url: `${root}/pull/${pull.number}` },
        { label: "Before revision", url: `${root}/tree/${pull.preMergeSha}` },
        { label: "Merge revision", url: `${root}/tree/${pull.mergeSha}` },
        ...linked.map(issue => ({ label: `Origin issue #${issue.number}`, url: `${root}/issues/${issue.number}` })),
      ],
    });
  }
  const last = proof.snapshots.at(-1);
  assert.equal(proof.snapshots[0].at, proof.adoption.at);
  assert.equal(last.at, proof.until);
  const window = { startAt: proof.adoption.at, endAt: proof.until };
  const complete = Array.isArray(proof.discovery) && proof.discovery.length > 0
    && proof.discovery.every(item => item.complete === true)
    && proof.issues.every(issue => issue.timeline.complete === true && issue.graph?.historyComplete !== false)
    && proof.pulls.filter(pull => pull.mergedAt).every(pull =>
      pull.graph.closingLinksComplete === true && pull.graph.historyComplete !== false);
  return {
    schemaVersion: 1, kind: "operational-value-events",
    repository, workflowSlug: "daily-file-diet", workflowName: "Daily File Diet", sourcePath,
    intent: {
      goal: "Identify oversized production Go files and promote behavior-preserving decomposition.",
      acceptance: "This named structural facet measures net 800+ file reductions at linked merges; full behavior-preserving acceptance remains unknown.",
    },
    provenance: [{ sourceRevision, proofDigest: digest(proof),
      kind: proof.acquisition?.kind ?? "preserved-retrospective-proof",
      ...(proof.acquisition ? { acquisition: proof.acquisition } : {}),
      ...(proof.previousProof ? { previousProof: proof.previousProof } : {}) }],
    observedAt: proof.observedAt, cadenceDays: 1, maturationDays: 0,
    metric: { id: "oversized-files-reduced", name: "Workflow-enabled oversized-file reductions",
      unit: "files", direction: "increase", version: "observed-800-line-net-reductions-v1",
      formula: "Count regular non-test Go files under pkg/ with at least 800 newline characters before the merge, minus the same count after it, including replacements." },
    basis: "workflow-contribution", window, coverage: [{ ...window, status: complete ? "complete" : "partial" }],
    opportunities: oversized(last.commit), events,
    repositoryState: {
      metric: { id: "oversized-files", name: "Oversized production Go files", unit: "files",
        direction: "decrease", version: "observed-800-line-snapshot-v1",
        formula: "Count regular non-test Go files under pkg/ with at least 800 newline characters at the snapshot revision." },
      observations: proof.snapshots.map(snapshot => ({ at: snapshot.at, value: oversized(snapshot.commit),
        ref: snapshot.commit, url: `${root}/tree/${snapshot.commit}` })),
      limitation: "These snapshots include everyone's changes. They are sparse observations, not continuous monitoring; changes between cutoffs and their causes are unknown.",
    },
    checks: [
      { name: "Structural change measured", status: events.length ? "verified" : "not-verified",
        detail: events.length
          ? "File counts were checked before and after linked merges, including replacement files and zero or negative changes."
          : "No linked implementation was measured; output creation alone does not establish a structural result." },
      { name: "Behavior preserved", status: "not-verified",
        detail: "This evidence does not independently establish unchanged behavior for every implementation." },
      { name: "All quality requirements met", status: "not-verified",
        detail: "Required coverage and the size of every new file are not fully verified by this structural measure." },
    ],
    limitations: [
      "Coverage is the surviving discovered File Diet issue cohort and its explicit merge links, not deleted outputs or an exclusive causal effect.",
      ...(proof.issues.some(issue => issue.eligible === false || issue.receipt?.status === "not-applied-to-output")
        ? ["Tracked auxiliary outputs and artifacts naming a different created output remain in the lifecycle proof but are not credited as eligible File Diet deliveries."] : []),
      ...(!complete ? ["Discovery or relationship history is incomplete; observed events do not establish complete-period totals."] : []),
      ...(undatedClosingLinks ? [`${undatedClosingLinks} retained closing links lack a dated connection or closed-by event; these corroborate lineage rather than prove when that relationship was recorded.`] : []),
      "Creation receipts strengthen attribution within the observed contribution; they do not cap its independently measured native change.",
      "Full behavior preservation, required coverage and all-new-files-under-500 acceptance remain unverified; this measures structural progress.",
      `The repository oversized-file count changes from ${oversized(proof.adoption.commit)} to ${oversized(last.commit)}. Other actors' growth is not attributed to this workflow.`,
      "This contribution pulse is not a continuous repository-state or response-latency series; sparse repository snapshots cannot locate changes between their cutoffs.",
      proof.acquisition
        ? "GitHub relationships were freshly collected; immutable inventories and verified receipts are reused by digest where available. Expired receipts remain unavailable unless previously preserved."
        : "Replay validates preserved digests and identities; it does not reacquire Git objects, historical links or expired receipt archives.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  requireArgs(args, 2, 2, "daily-file-diet.mjs <proof-directory> <pulse.html>");
  const ledger = fileDietEvents(readFileDietProof(args[0]));
  const model = writePulse(ledger, args[1]);
  const eventsFile = args[1].replace(/\.html$/, "-events.json");
  mkdirSync(path.dirname(path.resolve(eventsFile)), { recursive: true });
  writeFileSync(eventsFile, writeJson(ledger));
  console.log(`${args[1]}: ${model.metrics[0].observedTotal} reductions; `
    + `${model.metrics[0].receiptTotal} receipt-backed; ${model.signal.status}; attention=${model.signal.attention}`);
}
