import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { corpus } from "./corpus.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
export const activation = "2026-10-01T00:00:00Z";
export const firstEnd = "2026-10-08T00:00:00Z";
export const secondEnd = "2026-10-15T00:00:00Z";

export async function referenceModule(id) {
  const item = corpus.find(candidate => candidate.id === id);
  if (!item || item.disposition !== "measurable") throw new Error(`No reference contract for ${id}`);
  const original = item.module
    ? await import(pathToFileURL(path.join(root, item.module)).href)
    : null;
  const fields = item.fields ?? [];
  const empty = { valid: true, records: [] };
  const validRows = records => Array.isArray(records)
    && new Set(records.map(record => record?.id)).size === records.length
    && records.every(record => typeof record?.id === "string"
      && fields.every(field => typeof record[field] === "boolean"));
  const metricId = item.metric ?? "outcome";
  const scoreMetric = original?.scoreMetric ?? ((metric, evidence) => {
    if (metric !== metricId || evidence?.valid !== true) return null;
    if (item.kind === "target") {
      return Number.isInteger(evidence.errors) && Number.isInteger(evidence.requests)
        && evidence.requests > 0 && evidence.errors >= 0 && evidence.errors <= evidence.requests
        ? evidence.errors * 100 / evidence.requests : null;
    }
    if (!validRows(evidence.records)) return null;
    const accepted = evidence.records.filter(record => fields.every(field => record[field])).length;
    return item.kind === "count" ? accepted
      : evidence.records.length ? accepted * 100 / evidence.records.length : null;
  });
  const all = value => ({
    valid: true, records: [0, 1].map(index => ({
      id: `example-${index}`, ...Object.fromEntries(fields.map(field => [field, value])),
    })),
  });
  const validationExamples = original?.definition.validationExamples ?? (
    item.kind === "target" ? {
      targetAttained: { valid: true, errors: 2, requests: 100 },
      targetMissed: { valid: true, errors: 10, requests: 100 },
      missing: { valid: false }, malformed: { valid: true, errors: "two", requests: 100 },
    } : {
      targetAttained: all(item.kind !== "count"),
      targetMissed: all(item.kind === "count"),
      missing: { valid: false },
      malformed: { valid: true, records: [{ id: "invalid", [fields[0]]: "true" }] },
    }
  );
  const definition = {
    schemaVersion: 3, slug: item.id, repository: "githubnext/gh-aw-cao",
    sourcePath: item.source ?? `benchmark-goal:${item.id}`, workflowName: item.goal,
    intent: { goal: item.goal, acceptance: item.acceptance, temporalAnchor: "contract-activation" },
    adoption: { commit: "0".repeat(40), adoptedAt: activation, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: {
      key: item.id, repositories: ["githubnext/gh-aw-cao"], opportunity: item.acceptance,
      filters: ["Synthetic fixed evidence population; not a live repository measurement."],
      collection: "Read the explicitly supplied synthetic cutoff snapshots; unknown cutoffs remain missing.",
      measurementKind: original?.definition.evidence.measurementKind ?? "snapshot",
      window: original?.definition.evidence.window ?? { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    },
    model: {
      architecture: "Author-curated reference contract over synthetic accepted evidence.",
      recommendation: "Keep native outcomes separate from execution and output volume.",
      presentation: { label: item.id, betterLabel: item.kind === "target" ? "Closer to the documented reference" : "Follow the declared native direction" },
    },
    summary: { nativeLabel: item.goal },
    metrics: original ? structuredClone(original.definition.metrics) : [{
      id: metricId, name: item.goal, role: "primary",
      formula: item.kind === "count" ? "confirmed barriers in the fixed page cohort"
        : item.kind === "target" ? "errors * 100 / requests" : "accepted opportunities * 100 / eligible opportunities",
      unit: item.kind === "count" ? "pages" : "percent",
      direction: item.kind === "count" ? "decrease" : item.kind === "target" ? "target" : "increase",
      ...(item.kind === "target" ? { target: item.target } : {}),
      presentation: { name: item.goal, legendLabel: "Native outcome", transform: "identity" },
    }],
    validationExamples,
  };
  const provenance = [{
    repository: definition.repository, kind: "synthetic-fixture",
    ref: `sha256:${createHash("sha256").update(JSON.stringify(item)).digest("hex")}`,
  }];
  const collectBatch = requests => requests.map(request => {
    const known = Date.parse(request.windowStart) === Date.parse(request.windowEnd)
      - definition.evidence.window.durationDays * 86_400_000;
    const evidence = known && Date.parse(request.windowEnd) === Date.parse(firstEnd) ? item.before
      : known && Date.parse(request.windowEnd) === Date.parse(secondEnd) ? item.after
        : { valid: false, coverageStatus: "missing", missingReason: "No synthetic snapshot for the requested cutoff." };
    return { evidence: structuredClone(evidence), provenance: structuredClone(provenance) };
  });
  return { definition, scoreMetric, collectBatch, metricId, empty };
}
