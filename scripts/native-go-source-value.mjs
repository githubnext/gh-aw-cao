import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readGoHistory } from "./measure-go-native-history.mjs";
import { readCensusJson } from "./operational-value-census-io.mjs";

export function goBlockerEffect(before, after, threshold) {
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("Invalid structural threshold");
  const facts = [before, after].filter(Boolean);
  if (facts.some(fact => typeof fact.generated !== "boolean" || typeof fact.syntaxValid !== "boolean"
    || !Number.isSafeInteger(fact.lines) || fact.lines < 0)) throw new Error("Malformed native line evidence");
  if (facts.some(fact => fact.generated)) return 0;
  return Number(Boolean(before && before.lines > threshold)) - Number(Boolean(after && after.lines > threshold));
}

export function scoreGoSourceMetric(id, evidence) {
  if (!["native-net", "corroborated-net", "observed-native-net", "observed-linked-net"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.events) || new Set(evidence.events.map(row => row?.id)).size !== evidence.events.length
    || evidence.events.some(row => !row || typeof row.id !== "string" || !row.id
      || typeof row.linked !== "boolean" || (row.value !== null && !Number.isSafeInteger(row.value)))) return null;
  const observed = id.startsWith("observed-");
  const repository = ["native-net", "observed-native-net"].includes(id);
  const rows = evidence.events.filter(row => repository || row.linked);
  if (!observed && (rows.some(row => row.value === null)
    || (id === "corroborated-net" && evidence.linksComplete !== true))) return null;
  const known = rows.filter(row => row.value !== null);
  const knownAssessments = repository ? evidence.knownFileAssessments : evidence.knownLinkedAssessments;
  if (observed && !known.length && ((rows.length && !(Number.isSafeInteger(knownAssessments) && knownAssessments > 0))
    || (!repository && evidence.linksComplete !== true))) return null;
  return known.reduce((sum, row) => sum + row.value, 0);
}

export function nativeGoSourceModule(contract) {
  if (!["exact-gofmt", "go-file-blocker"].includes(contract.facet)
    || contract.nativeModelSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")
    || contract.goModelSha256 !== createHash("sha256").update(readFileSync(
      new URL("./native-go-measures.mjs", import.meta.url))).digest("hex")) {
    throw new Error("Frozen native Go source interpreter or facet changed");
  }
  const formatting = contract.facet === "exact-gofmt";
  const name = formatting ? "Exact Go formatting repairs" : "Go file-blocker reductions";
  const example = value => ({ valid: true, linksComplete: true, events: [{ id: "example", value, linked: true }] });
  const definition = {
    schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: contract.workflowName, sourcePath: `.github/workflows/${contract.workflowId}.md`,
    intent: { goal: contract.goal, acceptance: contract.acceptance, temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: `${contract.facet}-v1`, repositories: [contract.repository],
      nativeModelSha256: contract.nativeModelSha256, goModelSha256: contract.goModelSha256,
      oracleSha256: contract.oracleSha256, collectorSha256: contract.collectorSha256,
      opportunity: formatting ? "Existing non-generated tracked Go files with exact canonical gofmt transformations."
        : "Non-generated tracked non-test Go files crossing the frozen 1000-newline structural boundary.",
      filters: ["Immutable first-parent source changes, excluding vendor, testdata, node_modules and .git.",
        formatting ? "Generated files are excluded; syntactically unavailable formatting stays unknown, not clean."
          : "Generated files are excluded; native newline counts remain observable when syntax or behavior safeguards are unknown.",
        "Native source progress does not establish behavior preservation, full lint acceptance or sole workflow causation.",
        "Workflow contributions require corroborated retained output-to-merge graph links.",
        ...(formatting ? ["Credit exact gofmt output only; reverse exact transformations withdraw credit."]
          : ["Count additions and deletions as well as modifications so moving a blocker cannot hide the destination blocker.",
            "The frozen default threshold is a comparable partial facet, not a claim that every historical configurable policy was identical."])],
      collection: "Replay shared immutable Go source features and one retained workflow linkage archive per batch.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Version-pinned native source oracle and corroborated GitHub outcome graph.",
      recommendation: "Review partial native delivery independently from full acceptance and costs; no keep bar is inferred.",
      presentation: { label: name, betterLabel: "More native repairs, fewer withdrawals" } },
    summary: { nativeLabel: name },
    metrics: [
      { id: "native-net", name: `Repository ${name.toLowerCase()}`, role: "primary", direction: "increase", unit: "files",
        formula: formatting ? "exact canonical formatting repairs minus exact reversals"
          : "files above 1000 newlines before minus files above 1000 newlines after each immutable change",
        presentation: { name, legendLabel: "Repository net repairs", transform: "identity" } },
      { id: "corroborated-net", name: `Corroborated workflow-linked ${name.toLowerCase()}`, role: "diagnostic",
        direction: "increase", unit: "files", formula: "the same signed native effects restricted to corroborated merge revisions",
        presentation: { name: "Workflow-linked native repairs", legendLabel: "Linked net repairs", transform: "identity" } },
      { id: "observed-native-net", name: "Observed repository native subtotal", role: "diagnostic",
        direction: "increase", unit: "files", formula: "known signed native repository effects, retaining partial progress through unknown source assessments",
        presentation: { name: "Observed repository repairs", legendLabel: "Observed source repairs", transform: "identity" } },
      { id: "observed-linked-net", name: "Observed workflow-linked native subtotal", role: "diagnostic",
        direction: "increase", unit: "files", formula: "known corroborated native effects, retaining partial progress through unknown source assessments",
        presentation: { name: "Observed linked native repairs", legendLabel: "Observed linked repairs", transform: "identity" } },
    ],
    signal: { metricId: "observed-linked-net", basis: "workflow-contribution" },
    validationExamples: { targetAttained: example(2), targetMissed: example(0),
      missing: { valid: false }, malformed: example("two") },
  };
  return { definition, scoreMetric: scoreGoSourceMetric, collectBatch(requests) {
    const native = readGoHistory("docs/operational-value/proof/go-source-lifetime");
    const links = readCensusJson(path.join("docs/operational-value/proof", contract.graphDirectory, "links.json.gz"));
    if (native.index.repository !== contract.repository || native.index.revision !== contract.sourceRevision
      || native.index.oracleSha256 !== contract.oracleSha256 || native.index.lineCounter !== "newline-byte-count-v1"
      || native.index.collectorSha256 !== contract.collectorSha256
      || links.repository !== contract.repository || links.workflowId !== contract.workflowId
      || links.sourceRevision !== contract.sourceRevision || links.complete !== true) throw new Error("Native source evidence scope mismatch");
    const linked = new Set(links.contributions.map(row => row.mergeCommit));
    const byBlob = new Map(native.features.map(fact => [fact.id, fact]));
    const events = native.evaluated.flatMap(commit => commit.files.flatMap(file => {
      if (!formatting && file.path.endsWith("_test.go")) return [];
      if (![file.beforeMode, file.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode))) return [];
      const value = formatting ? file.formatting?.value
        : goBlockerEffect(byBlob.get(file.beforeBlob), byBlob.get(file.afterBlob), 1000);
      return value === undefined ? [] : [{ id: `${commit.commit}:${file.path}`, commit: commit.commit,
        at: commit.at, path: file.path, value, linked: linked.has(commit.commit) }];
    }));
    return requests.map(request => {
      if ((request.repository && request.repository !== contract.repository)
        || ![request.windowStart, request.windowEnd, request.observedAt].every(value =>
          typeof value === "string" && Number.isFinite(Date.parse(value)))
        || request.windowStart >= request.windowEnd) throw new Error("Invalid native source observation request");
      const rows = events.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
      return { evidence: { valid: request.windowStart >= contract.adoption.adoptedAt && request.windowEnd <= links.until,
        linksComplete: links.graphConnectionsComplete, coverageStatus: rows.some(row => row.value === null) ? "partial" : "complete",
        assessedFiles: rows.length, linkedAssessedFiles: rows.filter(row => row.linked).length,
        knownFileAssessments: rows.filter(row => row.value !== null).length,
        knownLinkedAssessments: rows.filter(row => row.linked && row.value !== null).length,
        events: rows.filter(row => row.value !== 0), fullAcceptance: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-git-baseline", ref: native.index.baseline },
        { repository: contract.repository, kind: "immutable-git-head", ref: native.index.revision },
        { repository: contract.repository, kind: "native-oracle-sha256", ref: native.index.oracleSha256 }],
      commit: native.index.revision };
    });
  } };
}
