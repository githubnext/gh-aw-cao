import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { loadNative, readJson, sha256 } from "../../../../scripts/native-smoke-copilot-small.mjs";

const root = fileURLToPath(new URL("../smoke-copilot-small/", import.meta.url));
const metric = (id, name, role) => ({
  id, name, role, formula: `Count distinct retained run attempts with independently verified ${name.toLowerCase()} in the bounded interval`,
  direction: "increase", unit: "run attempts",
  presentation: { name, legendLabel: name.slice(0, 24), transform: "identity" },
});

export const definition = {
  schemaVersion: 3,
  slug: "smoke-copilot-small",
  repository: "github/gh-aw",
  workflowName: "Smoke Copilot Small - native partial outcomes",
  sourcePath: ".github/workflows/smoke-copilot-small.md",
  intent: {
    goal: "Exercise actual small-model file write/readback and Bash arithmetic; original testing haiku and imported acceptance remain separate requirements.",
    acceptance: "Protected typed Bash completion at the original source-bound run attempt proves exact echo arithmetic or exact three-line file readback. Neither issue PASS nor a green run proves these effects.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "9c0ce8fcde9f1851a0a072bc0c2dd4e63f43a4df", adoptedAt: "2026-07-08T13:46:46Z",
    baselineCommit: "adb344b16f741da11a367e06d099653147eadc43", baselineAt: "2026-07-08T12:58:16Z",
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "smoke-copilot-small-native-facets-v1",
    repositories: ["github/gh-aw"],
    opportunity: "Distinct retained source-matched smoke-copilot-small run attempts, not issue count or all platform activity",
    filters: ["Original exact-head source/compiled binding", "Protected typed Bash execution and native shell_exit", "Inclusive start/exclusive end", "No invented missing history zeros"],
    collection: "Offline digest-checked original provider receipts, logs and Git objects; deterministic parsing of typed execution. Sealed case study, not a deployed continuous collector.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Frozen native acceptance, batched immutable evidence reads, deterministic partial-facet counters; no model calls during observation collection/scoring/reporting.",
    recommendation: "Preserve independently established useful effects without promoting them to full original-haiku, provider identity or imported workflow acceptance.",
    presentation: { label: "Verified native effects", betterLabel: "More verified effects" },
  },
  summary: { nativeLabel: "Native execution facets; unknown coverage is not zero" },
  metrics: [
    metric("arithmetic", "Arithmetic execution", "primary"),
    metric("readback", "Three-line readback", "diagnostic"),
    metric("written", "File write and readback", "diagnostic"),
    metric("fullAcceptance", "Full workflow acceptance", "diagnostic"),
  ],
  signal: { metricId: "arithmetic", basis: "repository-outcome" },
  validationExamples: {
    targetAttained: { valid: true, arithmetic: 1, readback: 1, written: 1, fullAcceptance: 1 },
    targetMissed: { valid: true, arithmetic: 0, readback: 0, written: 0, fullAcceptance: 0 },
    missing: { valid: false, missingReason: "No native originals" },
    malformed: { valid: true, arithmetic: "42", readback: -1, written: "unknown", fullAcceptance: "PASS" },
  },
};

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id) || evidence?.valid !== true) return null;
  const value = evidence[id];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new Error("Expected batch windows");
  const acceptance = readFileSync(path.join(root, "acceptance.json"));
  const facts = loadNative(root);
  const discovery = JSON.parse(gunzipSync(readFileSync(path.join(root, "discovery.json.gz"))));
  const audit = readJson(path.join(root, "sources.json"));
  const provenance = [
    { repository: definition.repository, kind: "immutable-git-source", ref: `git:${audit.revision}:.github/workflows/smoke-copilot-small.md` },
    { repository: definition.repository, kind: "frozen-native-acceptance", ref: `sha256:${sha256(acceptance)}` },
    { repository: definition.repository, kind: "retained-public-originals", ref: `sha256:${sha256(readFileSync(path.join(root, "packets.json")))}` },
  ];
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt, repository = definition.repository } = request;
    if (repository !== definition.repository || ![windowStart, windowEnd, observedAt].every(value =>
      typeof value === "string" && Number.isFinite(Date.parse(value)))
      || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(observedAt) < Date.parse(windowEnd)) {
      throw new Error("Invalid bounded native observation request");
    }
    const inside = time => time && Date.parse(time) >= Date.parse(windowStart) && Date.parse(time) < Date.parse(windowEnd);
    const relevant = facts.filter(row => ["arithmetic", "readback", "written"].some(id => inside(row[`${id}At`])));
    const evidence = {
      valid: true, windowStart, windowEnd, observedAt, coverageStatus: relevant.length ? "partial" : "missing",
      maturityStatus: relevant.length ? "matured" : "unavailable",
      missingReason: relevant.length
        ? "Retained native subset only; all-attempt coverage, originality, alias identity and full imported acceptance unavailable"
        : "No timestamped accepted native evidence retained in this interval; unknown, not zero",
      discoveryCandidates: discovery.direct.length,
      discoveryRunIds: new Set(discovery.direct.map(row => row.workflowReference?.runId).filter(Boolean)).size,
      retainedAttempts: facts.length, assessedAttemptsInWindow: relevant.length,
      fullAcceptance: null, facts: relevant,
    };
    for (const id of ["arithmetic", "readback", "written"]) {
      const measured = facts.filter(row => row[id] !== null && inside(row[`${id}At`]));
      evidence[id] = measured.length ? measured.filter(row => row[id] === true).length : null;
    }
    return { evidence, provenance, commit: audit.revision };
  });
}
