import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import {
  assessCase, cutoff, isUtc, profileStart, repository, repositoryId, revision, sha256,
  summarizeCases, validateNativeSchema,
} from "../daily-syntax-error-quality/native-diagnostics.mjs";

const evidenceRoot = new URL("../daily-syntax-error-quality/", import.meta.url);
const metric = (id, name, role, formula, legendLabel) => ({
  id, name, role, formula, direction: "increase", unit: "percent",
  presentation: { name, legendLabel, transform: "identity" },
});
const original = "---\non: workflow_dispatch\nengine: copilot\n---\n# Example\nCheck syntax.\n";
const result = (valid, message = "") => JSON.stringify([{
  workflow: "test.md", valid, errors: valid ? [] : [{ type: "parse_error", message }], warnings: [],
}]);
const example = good => ({
  windowStart: profileStart, windowEnd: cutoff, observedAt: cutoff,
  nativeCases: [{
    workflow: "test.md", completedAt: "2026-10-18T10:00:00Z",
    originals: {
      compilerBuildInfo: `/original/gh-aw: go1.26.0\n\tpath\tgithub.com/github/gh-aw/cmd/gh-aw\n\tbuild\tvcs=git\n\tbuild\tvcs.revision=${revision}\n\tbuild\tvcs.modified=false\n`,
      beforeInput: original, afterInput: original.replace("engine: copilot", "engine: 123"),
      beforeResult: result(true),
      afterResult: result(false, `test.md:${good ? 3 : 1}:1: error: expected string or object, got number.\nExample:\nengine: copilot\n`),
    },
  }],
});

export const definition = {
  schemaVersion: 3, slug: "daily-syntax-error-quality", repository,
  workflowName: "Daily Syntax Error Quality Check",
  sourcePath: ".github/workflows/daily-syntax-error-quality.md",
  intent: {
    goal: "Compiler errors that help developers actually correct syntax.",
    acceptance: "For native numeric-engine mutation opportunities, independently verify the exact file, line and engine-key or invalid-value token location, and an explicit repair restoring the native-accepted original. These are partial facets, not measured developer usability.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: profileStart, baselineCommit: null, baselineAt: null },
  evaluation: {
    mode: "attainment-only",
    reason: "Current-source-only reconstruction. This is not workflow adoption; historical source profiles and original native diagnostic/input receipts are not acquired. Earlier evidence has not been exhausted.",
  },
  evidence: {
    key: "gh-aw-native-numeric-engine-diagnostics",
    repositories: [repository],
    opportunity: "One distinct full document accepted by the pinned compiler, mutated only from a scalar built-in engine name to a numeric engine value, with original native validation JSON retained for both inputs.",
    filters: [
      "Exact repository ID 1036865607 and compiler revision c86377ec47b38f0b5af463277ee55d1d03d08da8.",
      "Numeric-engine facet only; exactly one parse_error; no shared/redirect skip, ambiguous aliases, duplicate engine, multiline edits or inferred compiler results.",
      "Native case completion in inclusive windowStart/exclusive windowEnd; never use acquisition timestamps as historical execution dates.",
      "Actor independent. Agent scores, issue creation, closure, merges and editable tracking markers are not acceptance.",
    ],
    collection: "Offline, digest-checked original input and native gh aw compile --json outputs. Read the shared source archive once per batch. No API calls, code execution, inferred historical predicates, or reconstructed diagnostic prose.",
    measurementKind: "interval",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    authority: "The archive is a preserved-evidence boundary, not cryptographic proof of who ran a compiler. Original native producer custody must be established separately; checksum integrity alone does not establish authenticity.",
  },
  model: {
    architecture: "Fixed native partial facets; independent source mutation oracle and original compiler-result decoder.",
    recommendation: "Report unavailable until original inputs and compiler receipts exist; do not interpret partial facets as full usability or delivered improvement.",
    presentation: { label: "Correct diagnostic locations", betterLabel: "Higher independently correct location coverage" },
  },
  summary: { nativeLabel: "Correct diagnostic locations (%) - partial value only" },
  metrics: [
    metric("correct-location-percent", "Correct native diagnostic locations", "primary",
      "100 * correctLocations / eligibleCount; null for absent, unsupported, incomplete or empty native evidence", "Correct locations"),
    metric("verified-repair-percent", "Verified explicit diagnostic repairs", "diagnostic",
      "100 * verifiedRepairs / eligibleCount; a unique native Did you mean or Example repair must restore the unchanged, native-accepted original", "Verified repairs"),
  ],
  validationExamples: {
    targetAttained: example(true), targetMissed: example(false),
    missing: { nativeCases: [] }, malformed: { nativeCases: "not original receipts" },
  },
  limitations: [
    "This deliberately narrow oracle does not cover all YAML/configuration errors, clarity, examples, consistency, developer task success, time-to-repair or regression safety.",
    "Missing original observations are null, not zero. Unassessed cases block a complete cohort; observed partial native subtotals remain visible.",
    "Full usability needs independent developer correction-task evidence with original diagnostic exposure and accepted repaired input; the workflow's subjective dimensions are rejected.",
    "Workflow-linked delivered improvement needs original safe-output/run identity, accepted issue-to-PR graph, immutable merge/parent changes and paired native before/after diagnostic evidence on the same cases. None is inferred from the discovery inventory.",
    "Delivery, if later supported, belongs in separate disjoint merge-time cohorts, never rolling diagnostic snapshots or sums of overlapping periods.",
    "Current source predicates are not applied to earlier revisions. A reviewed new profile is required for any historical backfill or later compiler revision.",
  ],
};

function loadArchive() {
  const manifest = readJsonArchive(fileURLToPath(new URL("sources.json", evidenceRoot)));
  if (manifest.repository !== repository || manifest.repositoryId !== repositoryId || manifest.revision !== revision) {
    throw new Error("Frozen source manifest identity mismatch");
  }
  const required = [
    [".github/workflows/daily-syntax-error-quality.md", "8dae2d78259ddc6dcd2e81ef156a246accfba506"],
    ["pkg/parser/schemas/main_workflow_schema.json", "b1d8b1b19f7afb0dd140a078f52e3e670e7b6f53"],
  ];
  for (const [sourcePath, blob] of required) {
    const item = manifest.files.find(item => item.path === sourcePath);
    if (!item || !/^sources\/\d{3}\.json\.gz$/.test(item.file)) throw new Error("Missing frozen oracle source");
    const source = readJsonArchive(fileURLToPath(new URL(item.file, evidenceRoot)));
    const actualBlob = createHash("sha1").update(`blob ${Buffer.byteLength(source.content)}\0`)
      .update(source.content).digest("hex");
    if (source.path !== sourcePath || source.revision !== revision || source.gitBlob !== item.gitBlob
      || source.gitBlob !== blob || actualBlob !== blob
      || sha256(source.content) !== item.sha256) throw new Error("Source integrity mismatch");
    if (sourcePath.endsWith(".json")) validateNativeSchema(source.content);
  }
  const archive = readJsonArchive(fileURLToPath(new URL("native-observations.json", evidenceRoot)));
  if (archive.repository !== repository || archive.repositoryId !== repositoryId || archive.revision !== revision
    || archive.cutoff !== cutoff || !Array.isArray(archive.cases) || archive.cases.length > 10000) {
    throw new Error("Native archive identity or bound mismatch");
  }
  return { archive, sourceDigest: sha256(readFileSync(new URL("sources.json", evidenceRoot))) };
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new Error("Expected batch of native evidence windows");
  const { archive, sourceDigest } = loadArchive();
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt } = request;
    if (request.repository !== undefined && request.repository !== repository) throw new Error("Unsupported evidence repository");
    const counts = summarizeCases(archive.cases, windowStart, windowEnd, observedAt);
    const supported = windowStart >= profileStart && windowEnd <= cutoff;
    const available = supported && counts.eligibleCount > 0 && counts.unassessedCount === 0;
    const missingReason = !supported ? "Window outside frozen current-source profile; no earlier or later native profile acquired."
      : counts.unassessedCount ? "Original native inputs or diagnostic oracle missing for one or more cases."
        : counts.eligibleCount === 0 ? archive.missingReason : null;
    const interim = Date.parse(windowEnd) - Date.parse(windowStart) < 86400000;
    return {
      evidence: {
        ...definition.evidence, ...counts, windowStart, windowEnd, observedAt,
        nativeCases: supported ? archive.cases.filter(item => item.completedAt >= windowStart
          && item.completedAt < windowEnd && item.completedAt <= observedAt) : [],
        nativeFacetStatus: available ? "complete" : "missing",
        coverageStatus: available ? "complete" : counts.eligibleCount ? "partial" : "missing",
        maturityStatus: available ? interim ? "interim" : "matured" : "unavailable",
        dubious: !available || interim, missingReason,
        fullUsability: { value: null, reason: "No independent developer correction-task originals or native acceptance instrument acquired." },
        deliveredImprovement: { value: null, reason: "No original producer, accepted graph, merge change and paired native diagnostics acquired." },
      },
      provenance: [
        { repository, kind: "immutable-git-source", ref: `${revision}:.github/workflows/daily-syntax-error-quality.md` },
        { repository, kind: "preserved-source-manifest-sha256", ref: sourceDigest },
        { repository, kind: "native-observation-archive-sha256", ref: sha256(JSON.stringify(archive)) },
      ],
      commit: revision,
    };
  });
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id) || !evidence
    || !Array.isArray(evidence.nativeCases) || evidence.nativeCases.length > 10000
    || ![evidence.windowStart, evidence.windowEnd, evidence.observedAt].every(isUtc)
    || evidence.windowStart < profileStart || evidence.windowEnd > cutoff
    || evidence.windowStart >= evidence.windowEnd || evidence.observedAt < evidence.windowEnd
    || evidence.nativeCases.some(item => !assessCase(item)
      || item.completedAt < evidence.windowStart || item.completedAt >= evidence.windowEnd)) return null;
  if (new Set(evidence.nativeCases.map(item => assessCase(item).id)).size !== evidence.nativeCases.length) return null;
  const counts = summarizeCases(evidence.nativeCases, evidence.windowStart, evidence.windowEnd, evidence.observedAt);
  if (!counts.eligibleCount || counts.unassessedCount) return null;
  return 100 * (id === "correct-location-percent" ? counts.correctLocations : counts.verifiedRepairs) / counts.eligibleCount;
}

export { assessCase, isUtc };
