import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { cutoff, historyStart, repository, revision, gitBlob, sha256, validatePacket,
  validateTransitions } from "../../../../scripts/native-changeset.mjs";

const adoption = "2025-11-01T16:31:43Z";
const packetFile = fileURLToPath(new URL("../changeset/native.json.gz", import.meta.url));
const freeze = fileURLToPath(new URL("../changeset/contract.json", import.meta.url));
const contract = JSON.parse(readFileSync(freeze, "utf8"));
const fixtureSources = readJsonArchive(packetFile).sources.filter(row => [
  ".github/workflows/changeset.md", ".github/workflows/shared/changeset-format.md", "scripts/changeset.js",
].includes(row.path));
const metric = (id, name, role, formula) => ({ id, name, role, formula,
  direction: "increase", unit: "changeset files",
  presentation: { name, legendLabel: id, transform: "identity" } });
const isUtc = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().replace(".000Z", "Z") === value;

function example(content) {
  const encode = (file, text) => {
    const bytes = Buffer.from(text);
    return { path: file, mode: "100644", gitBlob: gitBlob(bytes), sha256: sha256(bytes),
      bytes: bytes.length, content: bytes.toString("base64"), status: "available" };
  };
  const sources = fixtureSources;
  const entry = encode(".changeset/patch-example.md", content);
  const nativeTree = [...sources, entry].map(row => `${row.mode} blob ${row.gitBlob}\t${row.path}\0`).join("");
  const tree = [{ mode: entry.mode, gitBlob: entry.gitBlob, path: entry.path }];
  const parent = "1".repeat(40), at = "2026-10-05T00:00:00Z";
  const rawCommit = Buffer.from(`tree ${"2".repeat(40)}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1791158400 +0000\ncommitter Fixture <fixture@example.invalid> 1791158400 +0000\n\nValidation fixture, never a production observation.\n`);
  const commit = createHash("sha1").update(`commit ${rawCommit.length}\0`).update(rawCommit).digest("hex");
  const rawDiff = Buffer.from(`:000000 100644 ${"0".repeat(40)} ${entry.gitBlob} A\0${entry.path}\0`);
  const profile = ["scripts/changeset.js", ".github/workflows/shared/changeset-format.md"]
    .map(file => sources.find(row => row.path === file).gitBlob);
  const raw = { schemaVersion: 1, repository, repositoryId: 1036865607, revision, cutoff, sources,
    entries: [entry], tree, rawTree: Buffer.from(nativeTree).toString("base64"),
    treeSha256: sha256(nativeTree), historyStart, commitInventory: [commit],
    transitions: [{ commit, parent, at, rawCommit: rawCommit.toString("base64"),
      rawDiff: rawDiff.toString("base64"), diffSha256: sha256(rawDiff),
      profileBefore: profile, profileAfter: profile,
      changes: [{ path: entry.path, before: null, after: entry }] }] };
  return { raw, windowStart: historyStart, windowEnd: cutoff };
}

export const definition = {
  schemaVersion: 3, slug: "changeset", repository, workflowName: "Changeset Generator",
  sourcePath: ".github/workflows/changeset.md",
  intent: { goal: "Document release-relevant changes accurately according to the actual changeset specification.",
    acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
  adoption: { commit: "06d7770e80228207b6436fd22cd01ce145daf71c", adoptedAt: adoption,
    baselineCommit: "feef623b4840ab0b26128b8bc3d7d96907b07fd5", baselineAt: "2025-11-01T16:25:40Z" },
  evaluation: { mode: "attainment-only",
    reason: "Source-and-lock introduction is established against its real parent; no pre-adoption baseline or earlier semantic rule continuity is reconstructed." },
  evidence: { key: "changeset-frozen-release-reader", repositories: [repository],
    opportunity: "All direct .changeset/*.md native first-parent state transitions in the requested half-open interval, regardless of actor.",
    filters: ["Exclude nested paths and non-.md files, matching readChangesets().",
      "Missing blobs remain unknown; no output marker or merge establishes accuracy."],
    collection: "Digest-checked raw native tree and Git blobs; source-bound port of parseChangesetFile. Offline only.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
  model: { architecture: "Source-bound deterministic native decoder, no LLM and no target-code execution.",
    recommendation: "Retain structural partial evidence; obtain independent change-bound semantic acceptance before claiming accurate documentation or workflow contribution.",
    presentation: { label: "Release-readable changesets (partial)", betterLabel: "More release-readable entries; not proof of accuracy" } },
  summary: { nativeLabel: "Newly release-readable changeset files (partial structural transitions, not semantic accuracy)" },
  scope: contract,
  instrumentSha256: sha256(readFileSync(new URL("../../../../scripts/native-changeset.mjs", import.meta.url))),
  metrics: [
    metric("release-readable", "Newly release-readable changesets (partial)", "primary",
      "Count observed false-to-true release-reader compatibility transitions in the half-open native integration period. Missing transitions remain gaps; deletions reported separately."),
    metric("with-description", "Newly nonempty release-readable descriptions", "diagnostic",
      "Count observed false-to-true native readability with description.length > 0 after Codemod separation."),
    metric("specified-format", "Newly explicit-format-conforming files", "diagnostic",
      "Count observed false-to-true exact quoted gh-aw header, matching descriptive type-prefixed filename and nonempty description. No semantic claim."),
  ],
  validationExamples: {
    targetAttained: example('---\n"gh-aw": patch\n---\nFixed a bug.\n'),
    targetMissed: example("Invalid changeset"),
    missing: {}, malformed: { raw: { entries: "invalid" } },
  },
};

function decodeEvidence(evidence) {
  try {
    if (!evidence?.raw || !isUtc(evidence.windowStart) || !isUtc(evidence.windowEnd)
      || evidence.windowStart < historyStart || evidence.windowEnd > cutoff
      || Date.parse(evidence.windowStart) >= Date.parse(evidence.windowEnd)) return null;
    const decoded = validateTransitions(evidence.raw);
    return { events: decoded.events.filter(row => row.at >= evidence.windowStart && row.at < evidence.windowEnd),
      gaps: decoded.gaps.filter(row => row.at >= evidence.windowStart && row.at < evidence.windowEnd) };
  } catch { return null; }
}

export function scoreMetric(id, evidence) {
  const decoded = decodeEvidence(evidence);
  if (!decoded) return null;
  if (decoded.events.length === 0 && decoded.gaps.length > 0) return null;
  const field = ({ "release-readable": "additions", "with-description": "describedAdditions",
    "specified-format": "specifiedAdditions" })[id];
  return field ? decoded.events.reduce((sum, row) => sum + row[field], 0) : null;
}

export async function collectBatch(requests) {
  const raw = readJsonArchive(packetFile);
  const decoded = validatePacket(raw);
  const transitions = validateTransitions(raw);
  const packetDigest = sha256(JSON.stringify(raw));
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt } = request;
    if ([windowStart, windowEnd, observedAt].some(value => !isUtc(value))
      || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(windowEnd) > Date.parse(observedAt)
      || request.repository && request.repository !== repository) throw new Error("Invalid changeset observation window");
    const retained = windowStart >= historyStart && windowEnd <= cutoff;
    const events = transitions.events.filter(row => row.at >= windowStart && row.at < windowEnd);
    const gaps = transitions.gaps.filter(row => row.at >= windowStart && row.at < windowEnd);
    const evidence = { key: definition.evidence.key, repositories: [repository],
      measurementKind: "interval", windowStart, windowEnd,
      window: definition.evidence.window, eligibleCount: retained ? events.length + gaps.length : null,
      populationDigest: retained ? sha256(JSON.stringify([...events, ...gaps].map(row => `${row.commit}:${row.path}`).sort())) : null,
      coverageStatus: retained ? gaps.length ? "partial" : "complete" : "missing",
      maturityStatus: "mature", dubious: false,
      missingReason: retained ? gaps.length ? "Some native transitions are unavailable; observed subtotal only." : null
        : "The complete requested native period is not retained under an established contemporaneous parser/format profile.",
      fullGoal: { value: null, reason: contract.semanticGap },
      repositoryCondition: windowEnd === cutoff ? { at: cutoff, kind: "snapshot",
        available: decoded.results.length, missing: decoded.missing.length,
        eligible: decoded.total, releaseReadable: decoded.readable,
        described: decoded.described, specifiedFormat: decoded.specified } : null,
      structuralTransitions: retained ? { assessed: events.length, missing: gaps.length,
        readableAdditions: events.reduce((sum, row) => sum + row.additions, 0),
        readableNet: events.reduce((sum, row) => sum + row.readable, 0),
        readableLosses: events.filter(row => row.readable < 0).length,
        events, gaps } : null,
      workflowContribution: { value: null, reason: "No independent creation/consumer acceptance receipt bound to an actual change." },
      safeguards: { semanticAccuracy: null, semanticCompleteness: null, bumpAppropriateness: null,
        unnecessaryChangesets: null, regressionSafety: null },
      costs: { value: null, reason: "No independently workflow-version-period-bound costs." },
      keepDecision: "not rated",
      ...(retained ? { raw } : {}) };
    return { evidence, provenance: [
      { repository, kind: "immutable-native-source", ref: `${revision}:.github/workflows/changeset.md` },
      { repository, kind: "digest-checked-native-packet", ref: `sha256:${packetDigest}` },
      { repository, kind: "source-and-lock-introduction-real-parent", ref: `${definition.adoption.commit}^..${definition.adoption.commit}` },
    ], ...(windowEnd === cutoff ? { commit: revision } : {}) };
  });
}
