import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definition, collectBatch, scoreMetric } from "../docs/operational-value/proof/functions/daily-go-test-parallelizer.mjs";
import { readGoHistory } from "./measure-go-native-history.mjs";
import { readCensusJson } from "./operational-value-census-io.mjs";

export function goParallelizationValueEvents() {
  const directory = "docs/operational-value/proof/go-parallelization";
  const native = readGoHistory(path.join(directory, "native-v2"));
  const links = readCensusJson(path.join(directory, "links.json.gz"));
  const byCommit = new Map(links.contributions.map(row => [row.mergeCommit, row]));
  const observedAt = new Date(Math.max(Date.parse(native.index.completedAt), Date.parse(links.observedAt)))
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  const window = { startAt: definition.adoption.adoptedAt, endAt: links.until };
  const [{ evidence }] = collectBatch([{ windowStart: window.startAt, windowEnd: window.endAt, observedAt }]);
  const expected = scoreMetric("corroborated-net", evidence);
  if (expected === null) throw new Error("Cannot publish incomplete native parallelization evidence as a complete series");
  const events = evidence.events.filter(row => row.linked && row.enabled !== row.disabled).map(row => {
    const contribution = byCommit.get(row.id);
    const value = scoreMetric("corroborated-net", { valid: true, complete: true, events: [row] });
    return { id: `go-parallel:${row.id}`, at: row.at, value, attribution: "corroborated",
      label: `Existing-test parallelization: +${row.enabled} / -${row.disabled}`,
      detail: `${row.enabled} unchanged-body leading parallel activations; ${row.disabled} withdrawals. Native partial progress, not proven race safety, speedup or full-suite acceptance.`,
      evidence: [{ label: `Pull request #${contribution.number}`, url: contribution.url },
        { label: "Immutable first-parent change", url: `https://github.com/${definition.repository}/commit/${row.id}` }] };
  });
  if (events.reduce((sum, event) => sum + event.value, 0) !== expected) throw new Error("Native event projection differs from its frozen value function");
  const functionPath = "docs/operational-value/proof/functions/daily-go-test-parallelizer.mjs";
  return { schemaVersion: 1, kind: "operational-value-events", repository: definition.repository,
    workflowSlug: definition.slug, workflowName: definition.workflowName, sourcePath: definition.sourcePath,
    observedAt, cadenceDays: definition.evidence.window.cadenceDays,
    metric: { id: "corroborated-net", name: "Corroborated unchanged-body parallel activations",
      unit: "tests", direction: "increase",
      version: createHash("sha256").update(readFileSync(functionPath)).digest("hex") },
    basis: "workflow-contribution", window, opportunities: null,
    coverage: [{ ...window, status: "complete" }], events,
    nativeContext: { repositoryNet: scoreMetric("native-net", evidence), linkedNet: expected,
      nativeCommits: native.index.commits, blobs: native.index.uniqueBlobs,
      linkedMergeCandidates: links.contributions.length, nativeLinkedChanges: events.length,
      sourceRevision: native.index.revision, baseline: native.index.baseline, oracleSha256: native.index.oracleSha256 },
    limitations: [...links.limitations,
      "Counts are source-verified partial progress: unchanged existing top-level test bodies gain a leading parallel call. Added/renamed tests and changed bodies are not counted.",
      "Package/build-constraint changes, generated files and directly detected incompatible process-state calls are excluded.",
      "Same-file global references are retained as risk context; cross-file globals, resource isolation, race safety and full-suite acceptance are not established.",
      "Complete coverage describes the declared immutable first-parent source facet and retained named-marker graph cohort, not all possible workflow contributions.",
      "Delivery timestamps are immutable mainline commit committer times; GitHub merge times are retained separately.",
      "Eligible safe opportunities and matching costs are not measured; no automatic keep/retire bar is inferred."],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error("usage: build-go-parallelization-value-events.mjs EVENTS.json");
  const value = goParallelizationValueEvents();
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify(value.nativeContext));
}
