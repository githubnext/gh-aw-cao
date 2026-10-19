import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeGoSourceModule } from "./native-go-source-value.mjs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function goSourceValueEvents(contract) {
  const module = nativeGoSourceModule(contract);
  const links = readCensusJson(`docs/operational-value/proof/${contract.graphDirectory}/links.json.gz`);
  const native = readCensusJson("docs/operational-value/proof/go-source-lifetime/native-history.json.gz");
  const window = { startAt: contract.adoption.adoptedAt, endAt: contract.until };
  const observedAt = new Date(Math.max(Date.parse(links.observedAt), Date.parse(native.completedAt)))
    .toISOString().replace(/\.\d{3}Z$/, "Z");
  const [{ evidence }] = module.collectBatch([{ repository: contract.repository,
    windowStart: window.startAt, windowEnd: window.endAt, observedAt }]);
  const known = module.scoreMetric("observed-linked-net", evidence);
  if (known === null) throw new Error("No native linked subtotal can be established");
  const byCommit = new Map(links.contributions.map(row => [row.mergeCommit, row]));
  const events = evidence.events.filter(row => row.linked && row.value !== null).map(row => ({
    id: `${contract.facet}:${row.id}`, at: row.at, value: row.value, attribution: "corroborated",
    label: `${row.value > 0 ? "Native repair" : "Native withdrawal"}: ${row.path}`,
    detail: contract.acceptance,
    evidence: [{ label: `Pull request #${byCommit.get(row.commit).number}`, url: byCommit.get(row.commit).url },
      { label: "Immutable source change", url: `https://github.com/${contract.repository}/commit/${row.commit}` }],
  }));
  if (events.reduce((sum, row) => sum + row.value, 0) !== known) throw new Error("Source plot differs from the native value function");
  const coverage = [];
  let cursor = Date.parse(window.startAt);
  const gaps = [...new Set(evidence.events.filter(row => row.linked && row.value === null)
    .map(row => Date.parse(row.at)))].sort((a, b) => a - b);
  for (const at of gaps) {
    if (at > cursor) coverage.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(at).toISOString(), status: "complete" });
    coverage.push({ startAt: new Date(at).toISOString(), endAt: new Date(at + 1).toISOString(), status: "missing" });
    cursor = at + 1;
  }
  if (cursor < Date.parse(window.endAt)) coverage.push({ startAt: new Date(cursor).toISOString(), endAt: window.endAt, status: "complete" });
  if (!evidence.linksComplete) coverage.splice(0, coverage.length, { ...window, status: "missing" });
  return { schemaVersion: 1, kind: "operational-value-events", repository: contract.repository,
    workflowSlug: contract.workflowId, workflowName: contract.workflowName, sourcePath: module.definition.sourcePath,
    observedAt, cadenceDays: 7, window, basis: "workflow-contribution", opportunities: null, coverage, events,
    metric: { id: "observed-linked-net", name: module.definition.summary.nativeLabel, unit: "files", direction: "increase",
      version: censusDigest({ module: readFileSync(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`, "utf8"),
        interpreter: contract.nativeModelSha256 }) },
    nativeContext: { repositoryNet: module.scoreMetric("native-net", evidence),
      observedRepositoryNet: module.scoreMetric("observed-native-net", evidence),
      linkedNet: module.scoreMetric("corroborated-net", evidence), observedLinkedNet: known,
      assessedFiles: evidence.assessedFiles, linkedAssessedFiles: evidence.linkedAssessedFiles,
      linkedMergeCandidates: links.contributions.length, roots: links.rootCohort,
      sourceRevision: contract.sourceRevision, oracleSha256: native.oracleSha256,
      fullAcceptance: "not-measured", costs: "not-measured" },
    limitations: [contract.acceptance, ...links.limitations,
      "Zero in this narrow corroborated facet does not establish zero overall workflow value.",
      "Native repository changes count regardless of actor; the plot shows only independently graph-linked shared contributions.",
      "A zero interval is supported by a complete immutable source scan, not invented from absent evidence.",
      "Go formatting is pinned to the retained Go toolchain; newer tooling can differ. No full-goal, safety, cost or keep-bar claim is inferred."],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contractsPath, directory, ...extra] = process.argv.slice(2);
  if (!contractsPath || !directory || extra.length) throw new Error("usage: build-go-source-value-events.mjs CONTRACTS.json REPORT_DIRECTORY");
  for (const contract of readCensusJson(contractsPath)) {
    const result = goSourceValueEvents(contract);
    writeFileSync(path.join(directory, `${contract.workflowId}-value-events.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ workflow: contract.workflowId, ...result.nativeContext }));
  }
}
