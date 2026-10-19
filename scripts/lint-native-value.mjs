import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const ids = ["native-net", "linked-net", "observed-native-net", "observed-linked-net"];

export function scoreLintNative(id, evidence) {
  if (!ids.includes(id) || evidence?.valid !== true || !Array.isArray(evidence.events)
    || !Number.isSafeInteger(evidence.knownAssessments) || evidence.knownAssessments < 0
    || !Number.isSafeInteger(evidence.knownLinkedAssessments) || evidence.knownLinkedAssessments < 0
    || new Set(evidence.events.map(row => row?.id)).size !== evidence.events.length
    || evidence.events.some(row => typeof row?.id !== "string" || !row.id || typeof row.linked !== "boolean"
      || (row.value !== null && !Number.isSafeInteger(row.value)))) return null;
  const linked = ["linked-net", "observed-linked-net"].includes(id);
  const observed = id.startsWith("observed-");
  if (linked && evidence.linksComplete !== true) return null;
  const rows = evidence.events.filter(row => !linked || row.linked);
  if (!observed && rows.some(row => row.value === null)) return null;
  if (observed && rows.some(row => row.value === null)
    && (linked ? evidence.knownLinkedAssessments : evidence.knownAssessments) === 0) return null;
  return rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
}

export function lintNativeModule(contract) {
  if (contract.modelSha256 !== hash(import.meta.filename)) throw new Error("Frozen lint scoring interpreter changed");
  const base = `docs/operational-value/proof/${contract.directory}`;
  const nativeBase = path.join(base, contract.facetDirectory);
  const definition = {
    schemaVersion: 3, slug: contract.workflow, repository: "github/gh-aw",
    workflowName: contract.workflowName, sourcePath: `.github/workflows/${contract.workflow}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: {
      key: `${contract.workflow}-${contract.facet}-v1`, repositories: ["github/gh-aw"],
      sourceGitBlob: contract.sourceGitBlob, adoptionGitBlob: contract.adoptionGitBlob,
      nativeIndexSha256: contract.nativeIndexSha256, modelSha256: contract.modelSha256,
      oracleSha256: contract.oracleSha256, collectorSha256: contract.collectorSha256,
      opportunity: contract.opportunity,
      filters: [...contract.filters,
        "Signed immutable first-parent changes; additions, deletions, unsupported file modes and JS parse failures remain unknown.",
        "Native source diagnostics are partial progress, not full lint, regression, behavior or generator-root-cause acceptance.",
        "Corroborated retained output graph joins establish shared contribution, not receipt-verified creation or exclusive causality.",
        "Only known effects enter observed subtotals; complete totals remain null across unknown source assessments."],
      collection: "Offline replay of digest-checked, bounded immutable Git source facts and retained shared output lineage.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    },
    model: { architecture: "Frozen local native oracle; no upstream code or configuration execution.",
      recommendation: "Native partial progress, unknown safeguards, and costs are separate; no keep threshold is inferred.",
      presentation: { label: contract.label, betterLabel: "More diagnostic removals, fewer introductions" } },
    summary: { nativeLabel: contract.label },
    metrics: ids.map((id, i) => ({
      id, name: ["Repository net diagnostic reductions", "Corroborated net diagnostic reductions",
        "Observed repository diagnostic subtotal", "Observed corroborated diagnostic subtotal"][i],
      role: i === 0 ? "primary" : "diagnostic", direction: "increase", unit: "diagnostics",
      formula: `${id.startsWith("observed-") ? "Known" : "Complete"} before-minus-after native diagnostic counts${
        id.includes("linked") ? " restricted to independently corroborated workflow-linked merge revisions" : ""}`,
      presentation: { name: contract.label, legendLabel: ["Repository net", "Linked net",
        "Observed repository net", "Observed linked net"][i], transform: "identity" },
    })),
    signal: { metricId: "observed-linked-net", basis: "workflow-contribution" },
    validationExamples: {
      targetAttained: { valid: true, linksComplete: true, knownAssessments: 1, knownLinkedAssessments: 1,
        events: [{ id: "positive", value: 2, linked: true }] },
      targetMissed: { valid: true, linksComplete: true, knownAssessments: 1, knownLinkedAssessments: 1,
        events: [{ id: "negative", value: -1, linked: true }] },
      missing: { valid: false },
      malformed: { valid: true, linksComplete: true, knownAssessments: 1, knownLinkedAssessments: 1,
        events: [{ id: "malformed", value: "two", linked: true }] },
    },
  };
  return { definition, scoreMetric: scoreLintNative, collectBatch(requests) {
    const index = readCensusJson(path.join(nativeBase, "native-index.json"));
    const links = readCensusJson(path.join(base, "graph/links.json.gz"));
    if (censusDigest(index) !== contract.nativeIndexSha256 || censusDigest(links) !== contract.linksSha256
      || index.repository !== definition.repository || index.workflow !== contract.workflow
      || index.revision !== contract.revision || index.cutoff !== contract.cutoff
      || index.sourceGitBlob !== contract.sourceGitBlob || index.adoptionGitBlob !== contract.adoptionGitBlob
      || index.adoptionVerified !== true || index.adoptionParent !== contract.adoption.baselineCommit
      || links.workflowId !== contract.workflow || links.sourceRevision !== contract.revision
      || links.until !== contract.cutoff || links.complete !== true) throw new Error("Frozen lint evidence scope mismatch");
    const linked = new Set(links.contributions.map(row => row.mergeCommit));
    const rows = index.partitions.flatMap(part => {
      if (part.file !== path.basename(part.file)) throw new Error("Invalid native partition path");
      const values = readCensusJson(path.join(nativeBase, part.file));
      if (values.length !== part.rows || censusDigest(values) !== part.sha256) throw new Error("Native partition digest mismatch");
      return values;
    }).map(row => ({ id: `${row.commit}:${row.path}`, commit: row.commit, at: row.at, path: row.path,
      beforeBlob: row.beforeBlob, afterBlob: row.afterBlob, before: row.before, after: row.after,
      value: row.value, linked: linked.has(row.commit) }));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate native source change");
    return requests.map(request => {
      if (request.repository && request.repository !== definition.repository) throw new Error("Repository scope mismatch");
      if (![request.windowStart, request.windowEnd, request.observedAt].every(value =>
        typeof value === "string" && Number.isFinite(Date.parse(value)))
        || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd) {
        throw new Error("Invalid native lint observation window");
      }
      const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      return { evidence: {
        valid: request.windowStart >= contract.adoption.adoptedAt && request.windowEnd <= contract.cutoff,
        linksComplete: links.graphConnectionsComplete, assessedFiles: selected.length,
        knownAssessments: selected.filter(row => row.value !== null).length,
        knownLinkedAssessments: selected.filter(row => row.linked && row.value !== null).length,
        unknownAssessments: selected.filter(row => row.value === null).length,
        fullAcceptance: "not-measured", costs: "not-measured",
        events: selected.filter(row => row.value !== 0),
      }, provenance: [
        { repository: definition.repository, kind: "immutable-intent-blob", ref: contract.sourceGitBlob },
        { repository: definition.repository, kind: "immutable-adoption-blob", ref: contract.adoptionGitBlob },
        { repository: definition.repository, kind: "immutable-git-baseline", ref: index.baseline },
        { repository: definition.repository, kind: "immutable-git-revision", ref: index.revision },
        { repository: definition.repository, kind: "native-facts-sha256", ref: contract.nativeIndexSha256 },
      ], commit: index.revision };
    });
  } };
}
