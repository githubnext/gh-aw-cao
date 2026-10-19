import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = new URL("../docs/operational-value/proof/native-cleanup-outcomes/", import.meta.url);
const repository = "github/gh-aw";
const repositoryId = 1036865607;
const cutoff = "2026-10-18T15:00:12Z";
const day = 86400000;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const validDate = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const unknown = reason => ({ status: "unknown", reason });
const endpoint = (number, suffix = "") => `repos/${repository}/issues/${number}${suffix}`;
const uniqueEvents = rows => {
  const events = new Map();
  for (const row of rows) {
    const key = `${row.event}:${row.id ?? row.sha ?? row.node_id ?? digest(Buffer.from(JSON.stringify(row)))}`;
    if (events.has(key)) assert.deepEqual(events.get(key), row, "Contradictory duplicate event");
    events.set(key, row);
  }
  return [...events.values()];
};

export function lifecycle(entity, rows, at) {
  if (!entity || !Array.isArray(rows) || !validDate(entity.created_at) || !validDate(at)) return unknown("Missing lifecycle");
  const events = uniqueEvents(rows);
  if (events.some(row => /transfer|convert/.test(row.event))) return unknown("Transferred or converted identity");
  let state = "open";
  let closedAt = null;
  let firstClosure = null;
  let stateAt = Date.parse(entity.created_at) <= Date.parse(at) ? "open" : null;
  let previousTime = -Infinity;
  for (const row of events) {
    if (!["closed", "reopened", "merged"].includes(row.event)) continue;
    if (!validDate(row.created_at) || Date.parse(row.created_at) < previousTime
      || Date.parse(row.created_at) < Date.parse(entity.created_at)) return unknown("Invalid lifecycle ordering");
    previousTime = Date.parse(row.created_at);
    if (row.event === "reopened") {
      if (state !== "closed") return unknown("Reopen without a retained closure");
      state = "open";
      closedAt = null;
    } else {
      if (state !== "open") return unknown("Close without an open predecessor");
      state = "closed";
      closedAt = row.created_at;
      firstClosure ??= row;
    }
    if (Date.parse(row.created_at) <= Date.parse(at)) stateAt = state;
  }
  if (entity.state !== state || (state === "closed" && entity.closed_at !== closedAt)
    || (state === "open" && entity.closed_at !== null)) return unknown("Terminal state contradicts timeline");
  return { status: "verified", stateAt, firstClosure,
    reopened: events.some(row => row.event === "reopened" && Date.parse(row.created_at) < Date.parse(at)) };
}

export function verifyParent({ parent, events, children, histories, at = cutoff }) {
  if (!parent || !Number.isSafeInteger(parent.id)
    || !Array.isArray(events) || !Array.isArray(children) || !histories) return unknown("Missing parent evidence");
  if (parent.pull_request || parent.url !== `https://api.github.com/${endpoint(parent.number)}`) return unknown("Wrong parent identity");
  const state = lifecycle(parent, events, at);
  if (state.status !== "verified") return state;
  const close = state.firstClosure;
  if (!close || !Number.isSafeInteger(close.id)
    || Date.parse(close.created_at) >= Date.parse(at)) return unknown("No pre-cutoff parent closure");
  const membership = new Set();
  let before = null;
  let previousGraphTime = Date.parse(parent.created_at);
  for (const row of uniqueEvents(events)) {
    if (!["sub_issue_added", "sub_issue_removed"].includes(row.event)) continue;
    if (!validDate(row.created_at) || Date.parse(row.created_at) < previousGraphTime) return unknown("Invalid graph ordering");
    previousGraphTime = Date.parse(row.created_at);
    if (Date.parse(row.created_at) === Date.parse(close.created_at)) return unknown("Graph mutation races closure");
    const child = row.sub_issue;
    if (child?.repository?.id !== repositoryId || child.repository.private !== false
      || child.repository.full_name !== repository || !Number.isSafeInteger(child.number)) return unknown("Unresolved child identity");
    if (before === null && Date.parse(row.created_at) > Date.parse(close.created_at)) before = new Set(membership);
    if (row.event === "sub_issue_added") {
      if (membership.has(child.number)) return unknown("Duplicate relationship addition");
      membership.add(child.number);
    } else {
      if (!membership.has(child.number)) return unknown("Removal without a retained addition");
      membership.delete(child.number);
    }
  }
  before ??= new Set(membership);
  const terminal = children.map(child => child.number).toSorted((a, b) => a - b);
  if (new Set(terminal).size !== terminal.length
    || JSON.stringify([...membership].toSorted((a, b) => a - b)) !== JSON.stringify(terminal)) {
    return unknown("Terminal child set contradicts relationship history");
  }
  if (!before.size) return unknown("Empty parent is ineligible");
  const verifiedChildren = [];
  for (const number of [...before].toSorted((a, b) => a - b)) {
    const child = children.find(child => child.number === number) ?? histories[number]?.entity;
    if (!child || child.url !== `https://api.github.com/${endpoint(number)}` || child.pull_request) return unknown("Missing historical child");
    const childState = lifecycle(child, histories[number]?.events, close.created_at);
    if (childState.status !== "verified") return unknown(`Child ${number}: ${childState.reason}`);
    if (childState.stateAt !== "closed") return unknown(`Child ${number} was not closed before its parent`);
    if (histories[number].events.some(event => ["closed", "reopened"].includes(event.event)
      && Date.parse(event.created_at) === Date.parse(close.created_at))) return unknown("Child/parent closure ordering ambiguous");
    verifiedChildren.push({ number, id: child.id });
  }
  return {
    status: "accepted", id: parent.id, number: parent.number,
    eventId: close.id, deliveredAt: close.created_at,
    children: verifiedChildren, childCount: before.size,
    stateReason: parent.state_reason ?? null, reopened: state.reopened,
  };
}

export function verifyPullRequest({ slug, pr, events, snapshot, supersession, at = cutoff }) {
  if (!pr || !Array.isArray(events)) return unknown("Missing PR lifecycle");
  if (pr.url !== `https://api.github.com/repos/${repository}/pulls/${pr.number}`
    || pr.base?.repo?.id !== repositoryId || pr.base.repo.private !== false) return unknown("Wrong PR authority");
  const state = lifecycle(pr, events, at);
  if (state.status !== "verified") return state;
  const close = state.firstClosure;
  if (!close || Date.parse(close.created_at) >= Date.parse(at) || pr.merged_at !== null || events.some(event => event.event === "merged")) {
    return unknown("No unmerged pre-cutoff closure");
  }
  if (!snapshot || snapshot.number !== pr.number || snapshot.repositoryId !== repositoryId
    || snapshot.state !== "open" || !validDate(snapshot.capturedAt) || !validDate(snapshot.updatedAt)
    || Date.parse(snapshot.capturedAt) >= Date.parse(close.created_at)
    || Date.parse(snapshot.updatedAt) > Date.parse(snapshot.capturedAt)
    || !Array.isArray(snapshot.labels) || !snapshot.labels.every(label => typeof label === "string")) {
    return unknown("Missing independent pre-action state");
  }
  const threshold = slug === "draft-pr-cleanup" ? 14 : 30;
  if (Date.parse(snapshot.capturedAt) - Date.parse(snapshot.updatedAt) < threshold * day) return unknown("Activity too recent");
  if (events.some(event => validDate(event.created_at) && Date.parse(event.created_at) > Date.parse(snapshot.capturedAt)
    && Date.parse(event.created_at) < Date.parse(close.created_at) && event.event !== "closed")) {
    return unknown("State changed after eligibility capture");
  }
  const exemptions = slug === "draft-pr-cleanup"
    ? ["keep-draft", "blocked", "awaiting-review"]
    : ["keep-open", "blocked", "awaiting-review", "do-not-close", "hold"];
  if (snapshot.labels.some(label => exemptions.includes(label.toLowerCase()))) return unknown("Exempt PR");
  if (snapshot.draft !== true) return unknown("This bounded facet requires a historically draft PR");
  if (slug === "draft-pr-cleanup" && (!Array.isArray(snapshot.activityAt)
    || !snapshot.activityAt.every(validDate)
    || snapshot.activityAt.some(time => Date.parse(snapshot.capturedAt) - Date.parse(time) < 14 * day))) {
    return unknown("Missing or recent draft activity");
  }
  if (slug === "stale-pr-cleanup" && (!supersession?.mergedPr
    || supersession.mergedPr.base?.repo?.id !== repositoryId
    || supersession.mergedPr.base.repo.private !== false
    || supersession.mergedPr.base.ref !== pr.base.ref
    || !validDate(supersession.mergedPr.merged_at)
    || Date.parse(supersession.mergedPr.merged_at) <= Date.parse(pr.created_at)
    || Date.parse(supersession.mergedPr.merged_at) > Date.parse(snapshot.capturedAt)
    || !Array.isArray(supersession.closedFiles) || !Array.isArray(supersession.mergedFiles)
    || !supersession.closedFiles.some(file => supersession.mergedFiles.includes(file)))) {
    return unknown("Category A precedence and maintainer protection unresolved");
  }
  return { status: "accepted", id: pr.id, number: pr.number, eventId: close.id,
    deliveredAt: close.created_at, reopened: state.reopened };
}

export function deliveredInPeriod(cases, start, end) {
  assert.ok(validDate(start) && validDate(end) && Date.parse(start) < Date.parse(end), "Invalid measurement interval");
  const byIdentity = new Map();
  for (const item of cases.filter(item => item.status === "accepted").toSorted((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt))) {
    const previous = byIdentity.get(item.id);
    if (previous?.deliveredAt === item.deliveredAt) assert.deepEqual(previous, item, "Contradictory native fact");
    if (!previous) byIdentity.set(item.id, item);
  }
  return [...byIdentity.values()].filter(item => Date.parse(item.deliveredAt) >= Date.parse(start)
    && Date.parse(item.deliveredAt) < Date.parse(end));
}

export function readZipEntries(bytes, names) {
  const parser = `
import io,json,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
names=json.loads(sys.argv[1])
entries=z.infolist()
assert len(entries)<=256 and len({i.filename for i in entries})==len(entries)
assert sum(i.file_size for i in entries)<=128*1024*1024
out={}
for name in names:
 if name in z.namelist():
  info=z.getinfo(name)
  assert info.file_size<=16*1024*1024
  out[name]=z.read(name).decode("utf-8")
print(json.dumps(out))
`;
  const result = spawnSync("python3", ["-c", parser, JSON.stringify(names)], {
    input: bytes, maxBuffer: 32 * 1024 * 1024, timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Native ZIP read failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout);
}

export function loadInputs(expectedSha256) {
  const file = new URL("inputs.json", directory);
  assert.equal(digest(readFileSync(file)), expectedSha256, "Native input contract changed");
  const inputs = JSON.parse(readFileSync(file));
  for (const entry of inputs.files) {
    assert.ok(/^(?:originals|sources)\/[\w.-]+$/.test(entry.path)
      || ["source-index.json.gz", "contracts.json", "discovery.json.gz"].includes(entry.path));
    assert.equal(digest(readFileSync(new URL(entry.path, directory))), entry.sha256, `Evidence changed: ${entry.path}`);
  }
  const receipts = new Map();
  for (const entry of inputs.files.filter(entry => /^originals\/[^/]+\.json\.gz$/.test(entry.path) && !entry.path.includes("-part-"))) {
    const receipt = readJsonArchive(fileURLToPath(new URL(entry.path, directory)));
    assert.equal(receipt.status, 200, `Unavailable acquisition: ${receipt.endpoint}`);
    const bytes = Buffer.from(receipt.data, "base64");
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(digest(bytes), receipt.sha256);
    assert.equal(receipt.method, "GET");
    assert.ok(!receipts.has(receipt.endpoint), "Duplicate endpoint custody");
    receipts.set(receipt.endpoint, { ...receipt, bytes });
  }
  const authority = JSON.parse(receipts.get(`repos/${repository}`).bytes);
  assert.equal(authority.id, repositoryId);
  assert.equal(authority.private, false);
  const json = name => receipts.has(name) ? JSON.parse(receipts.get(name).bytes) : null;
  const paged = name => {
    const rows = [];
    for (let page = 1; page <= 8; page++) {
      const next = json(`${name}?per_page=100${page === 1 ? "" : `&page=${page}`}`);
      if (!Array.isArray(next)) return null;
      rows.push(...next);
      if (next.length < 100) return rows;
    }
    return null;
  };
  const sources = readJsonArchive(fileURLToPath(new URL("source-index.json.gz", directory)));
  const objects = new Map();
  for (const object of sources.objects) {
    const value = readJsonArchive(fileURLToPath(new URL(object.archive, directory)));
    const bytes = Buffer.from(value.data, "base64");
    assert.equal(digest(bytes), value.sha256);
    assert.equal(createHash("sha1").update(`${object.type} ${bytes.length}\0`).update(bytes).digest("hex"), object.sha);
    objects.set(object.sha, { type: object.type, bytes });
  }
  const treeEntry = (sha, name) => {
    const tree = objects.get(sha);
    assert.equal(tree?.type, "tree", "Missing retained Git tree");
    let offset = 0;
    while (offset < tree.bytes.length) {
      const space = tree.bytes.indexOf(32, offset);
      const zero = tree.bytes.indexOf(0, space);
      assert.ok(space > offset && zero > space && zero + 21 <= tree.bytes.length, "Malformed Git tree");
      const filename = tree.bytes.subarray(space + 1, zero).toString();
      const child = tree.bytes.subarray(zero + 1, zero + 21).toString("hex");
      if (filename === name) return child;
      offset = zero + 21;
    }
    return null;
  };
  const atPath = (commit, filename) => {
    const object = objects.get(commit);
    assert.equal(object?.type, "commit", "Missing retained commit");
    let sha = /^tree ([a-f0-9]{40})$/m.exec(object.bytes.toString())?.[1];
    assert.ok(sha, "Commit tree missing");
    for (const part of filename.split("/")) {
      sha = treeEntry(sha, part);
      if (!sha) return null;
    }
    return sha;
  };
  for (const [slug, history] of Object.entries(sources.histories)) {
    const first = history[0];
    const commit = objects.get(first.commit)?.bytes.toString();
    assert.ok(commit?.includes(`\nparent ${first.parent}\n`), "Adoption parent mismatch");
    const timestamp = /^committer .+> (\d+) [+-]\d{4}$/m.exec(commit)?.[1];
    assert.equal(Date.parse(first.committedAt), Number(timestamp) * 1000, "Adoption timestamp mismatch");
    assert.equal(atPath(first.parent, `.github/workflows/${slug}.md`), null, "Source predates claimed adoption");
    assert.ok(atPath(first.commit, `.github/workflows/${slug}.lock.yml`), "Compiled workflow absent at adoption");
  }
  const source = (commit, filename) => {
    const entry = sources.entries.find(item => item.commit === commit && item.path === filename);
    if (!entry) return null;
    const value = readJsonArchive(fileURLToPath(new URL(entry.archive, directory)));
    const bytes = Buffer.from(value.data, "base64");
    assert.equal(digest(bytes), value.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), entry.gitBlob);
    if (objects.has(commit)) assert.equal(atPath(commit, filename), entry.gitBlob, "Source is not at claimed revision");
    return { entry, text: bytes.toString() };
  };
  return { inputs, receipts, json, paged, sources, source };
}

export function verifyContribution(store, slug, nativeCase, runId, artifactId) {
  const run = store.json(`repos/${repository}/actions/runs/${runId}`);
  const artifacts = store.json(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifact = artifacts?.artifacts?.find(item => item.id === artifactId && item.name === "safe-outputs-items");
  const original = store.receipts.get(`repos/${repository}/actions/artifacts/${artifactId}/zip`);
  const intent = run && store.source(run.head_sha, `.github/workflows/${slug}.md`);
  const lock = run && store.source(run.head_sha, `.github/workflows/${slug}.lock.yml`);
  if (!run || run.repository?.id !== repositoryId || run.repository.private !== false
    || run.path !== `.github/workflows/${slug}.lock.yml`
    || run.id !== runId || run.created_at > nativeCase.deliveredAt || run.updated_at < nativeCase.deliveredAt
    || artifact?.workflow_run?.id !== runId || artifact.workflow_run.head_sha !== run.head_sha
    || !original || !intent || !lock
    || !lock.text.includes(`.github/workflows/${slug}.md`)) return unknown("Missing source/runtime/application join");
  const entries = readZipEntries(original.bytes, ["safe-output-items.jsonl"]);
  if (!entries["safe-output-items.jsonl"]) return unknown("Missing application receipts");
  const rows = entries["safe-output-items.jsonl"].trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const applied = rows.find(item => item.type === "update_issue" && item.number === nativeCase.number
    && item.repo === repository && item.target?.repository === repository && item.target.number === nativeCase.number
    && item.before_state?.state === "open" && item.after_state?.state === "closed"
    && validDate(item.timestamp) && Math.abs(Date.parse(item.timestamp) - Date.parse(nativeCase.deliveredAt)) < 1000);
  const comments = store.paged(endpoint(nativeCase.number, "/timeline"))?.filter(item => item.event === "commented") ?? [];
  const commented = rows.some(item => item.type === "add_comment" && item.number === nativeCase.number
    && item.repo === repository && item.target?.repository === repository && item.target.number === nativeCase.number
    && comments.some(comment => comment.id === item.id && comment.created_at >= nativeCase.deliveredAt
      && comment.created_at <= run.updated_at));
  return applied && commented ? { status: "verified", runId, artifactId,
    sourceGitBlob: intent.entry.gitBlob, runtimeGitBlob: lock.entry.gitBlob }
    : unknown("Application receipt does not match independent transition and comment");
}

export function nativeCleanupModule(slug, { inputsSha256, oracleSha256, archiveReaderSha256 }) {
  assert.equal(digest(readFileSync(fileURLToPath(import.meta.url))), oracleSha256, "Native oracle changed");
  const archiveReader = new URL("../.github/skills/add-operational-value/scripts/json-archive.mjs", import.meta.url);
  assert.equal(digest(readFileSync(archiveReader)), archiveReaderSha256, "Archive reader changed");
  const store = loadInputs(inputsSha256);
  const contract = JSON.parse(readFileSync(new URL("contracts.json", directory))).instruments[slug];
  assert.ok(contract, "Unknown cleanup goal");
  const adoption = store.sources.histories[slug][0];
  assert.equal(contract.adoption, adoption.commit);
  const metrics = [
    ["native", contract.unit, "primary", "Count unique independently verified source-eligible closures delivered in [start,end); null without native evidence."],
    ["contribution", "Receipt-linked closures", "diagnostic", "Subset of native closures joined to actual source/runtime/application receipts; null without those receipts."],
    ["full", "Full goal completion", "diagnostic", "Null until all original acceptance and safeguards, complete eligible population and historical state are established."],
  ].map(([id, name, role, formula]) => ({
    id, name, role, formula, direction: "increase", unit: id === "full" ? "complete accepted goals" : contract.unit,
    presentation: { name, legendLabel: id === "native" ? "Verified closures" : id === "contribution" ? "Receipt-linked" : "Full goal", transform: "identity" },
  }));
  const example = value => ({ schemaVersion: 1, slug, native: value, contribution: value, full: value });
  const definition = {
    schemaVersion: 3, slug, repository,
    workflowName: slug.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" "),
    sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal: contract.goal, acceptance: contract.nativeFacet, temporalAnchor: "workflow-adoption" },
    adoption: { commit: adoption.commit, adoptedAt: adoption.committedAt,
      baselineCommit: adoption.parent, baselineAt: adoption.parentAt },
    evaluation: { mode: "attainment-only" },
    evidence: {
      key: `native-cleanup-v1-${slug}`, repositories: [repository],
      opportunity: "Bounded discovery-selected public output entities, not an eligible-opportunity census.",
      filters: ["Frozen cutoff 2026-10-18T15:00:12Z", "No activity/prose-only acceptance", "Unknown periods stay null"],
      collection: "Digest-checked retained provider originals; independent event replay and historical graph reconciliation; no network, Git, target execution or model calls.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    },
    model: {
      architecture: "Source-native deterministic lifecycle/graph oracle, separate acquisition, standard schema-3 collection and reporting.",
      recommendation: "Not rated: no agreed keep bar. Partial native subtotals are not complete periods or causal evidence.",
      presentation: { label: contract.unit, betterLabel: "More independently verified eligible closures" },
    },
    summary: { nativeLabel: contract.unit },
    metrics,
    validationExamples: { targetAttained: example(1), targetMissed: example(0), missing: {}, malformed: example(-1) },
    originalAcceptance: contract.originalAcceptance,
    safeguards: contract.safeguards,
    dependencyIdentity: { inputsSha256, oracleSha256, archiveReaderSha256 },
    limitations: [
      "Retrospective source-history-informed bounded assessment, not complete eligible-population coverage.",
      "Only sub-issue-closer currently has real native acceptance evidence. Neither PR cleanup instrument is qualified as measured completion.",
      "Full goal acceptance, keep/change verdict and costs remain unmeasured. Original stricter contracts are preserved.",
    ],
  };

  const cases = [];
  const candidateResults = [];
  if (slug === "sub-issue-closer") {
    for (const number of store.inputs.parents) {
      const parent = store.json(endpoint(number));
      const children = store.paged(endpoint(number, "/sub_issues"));
      const histories = Object.fromEntries((children ?? []).map(child => [child.number, {
        entity: child, events: store.paged(endpoint(child.number, "/timeline")),
      }]));
      const result = verifyParent({ parent, events: store.paged(endpoint(number, "/timeline")), children, histories });
      candidateResults.push({ number, ...result });
      if (result.status === "accepted") {
        cases.push({ ...result, contribution: verifyContribution(store, slug, result,
          store.inputs.parentRun, store.inputs.parentApplicationArtifact) });
      }
    }
  } else {
    for (const number of store.inputs.pullRequests[slug]) {
      const result = verifyPullRequest({
        slug, pr: store.json(`repos/${repository}/pulls/${number}`),
        events: store.paged(endpoint(number, "/timeline")),
        snapshot: null,
      });
      candidateResults.push({ number, ...result });
    }
  }
  return {
    definition,
    collectBatch(requests) {
      assert.ok(Array.isArray(requests));
      return requests.map(request => {
        assert.ok(request.repository === undefined || request.repository.toLowerCase() === repository);
        assert.ok(validDate(request.observedAt) && validDate(request.windowEnd)
          && Date.parse(request.observedAt) >= Date.parse(request.windowEnd), "Immature interval");
        assert.ok(Date.parse(request.windowEnd) <= Date.parse(cutoff), "Interval exceeds frozen evidence cutoff");
        const delivered = deliveredInPeriod(cases, request.windowStart, request.windowEnd);
        const linked = delivered.filter(item => item.contribution.status === "verified");
        return {
          commit: store.sources.revision,
          evidence: {
            schemaVersion: 1, slug,
            coverageStatus: "partial",
            native: delivered.length ? delivered.length : null,
            nativeKnownSubtotal: delivered.length,
            contribution: linked.length ? linked.length : null,
            full: null,
            cases: delivered, candidates: candidateResults,
            missingReason: delivered.length ? "Native subtotal measured; full period opportunity coverage remains unknown."
              : "No independently accepted native closure retained in this period; zero cannot be inferred.",
            safeguards: { reopenObserved: delivered.filter(item => item.reopened).length,
              fullPopulation: null, completeRecursion: null, completeCommunication: null },
            costs: null, decision: "not-rated",
          },
          provenance: [
            { repository, kind: "frozen-source", ref: store.sources.revision },
            { repository, kind: "retained-native-inputs", ref: `sha256:${inputsSha256}` },
            ...delivered.map(item => ({ repository, kind: "independent-closure-event",
              ref: `https://api.github.com/repos/${repository}/issues/events/${item.eventId}` })),
          ],
        };
      });
    },
    scoreMetric(id, evidence) {
      const value = evidence?.[id];
      return metrics.some(metric => metric.id === id) && evidence?.schemaVersion === 1 && evidence.slug === slug
        && Number.isSafeInteger(value) && value >= 0 ? value : null;
    },
  };
}
