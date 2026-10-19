import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readGoHistory } from "../../../../scripts/measure-go-native-history.mjs";
import { readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";
import { scoreGoParallelMetric } from "../../../../scripts/native-go-measures.mjs";

const proof = path.resolve(import.meta.dirname, "../go-parallelization");
const nativeModelSha256 = "69e0dcb71fb9c72a630278c3a5f3fc620b8e7d880fc9f0e628e30c3b5d91721e";
if (createHash("sha256").update(readFileSync(new URL("../../../../scripts/native-go-measures.mjs", import.meta.url)))
  .digest("hex") !== nativeModelSha256) throw new Error("Frozen Go interpreter changed; explicitly version the native function");
const example = (enabled, disabled) => ({ valid: true, complete: true,
  events: [{ id: "example", enabled, disabled, linked: true }] });
export const definition = {
  schemaVersion: 3, slug: "daily-go-test-parallelizer", repository: "github/gh-aw",
  workflowName: "Daily Go Test Parallelizer", sourcePath: ".github/workflows/daily-go-test-parallelizer.md",
  intent: {
    goal: "Safely enable parallel execution of existing Go tests without changing test behavior.",
    acceptance: "Observed partial facet: the same top-level Test name, file, package, build constraints and unchanged body gain a direct leading call on the actual testing.T parameter; exclude generated files and directly detected os/testing process-state mutations. Race safety, fixed-resource isolation, package-global behavior and full-suite acceptance are separate and not inferred.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: { commit: "bf7f1e5d3a297c2aba57775f0083c9e77986b36a", adoptedAt: "2026-07-27T04:58:37Z",
    baselineCommit: "870215a79912f85171230e5ffac272a2e0d406d6", baselineAt: "2026-07-27T04:41:08Z" },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "go-leading-parallel-unchanged-body-v2", repositories: ["github/gh-aw"],
    nativeModelSha256,
    oracleSha256: "753dd2574b4389eaee0a0bb63fb74f7c7357696cc6d8e7c7a6f52e833ba1cf2c",
    opportunity: "Existing top-level testing.T tests in tracked, non-generated Go test files, excluding vendor, testdata and node_modules.",
    filters: ["Added, deleted or renamed test identities are not parallelization deliveries.",
      "Compare each mainline change with its immutable first parent; retain signed withdrawals.",
      "Count demonstrated source changes, not full race-safe acceptance, faster execution, PR counts or exclusive workflow causation.",
      "Direct-marker and independently graph-linked downstream PRs are corroborated contributions, not safe-output creation receipts."],
    collection: "Replay the retained immutable Go blob feature table and normalized GitHub linkage archive once per batch; no network calls during scoring.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "A Go standard-library AST oracle verifies the native source facet; Git first-parent deltas identify deliveries and normalized GitHub graph identities identify shared contributions.",
    recommendation: "Review delivery changes separately from race/full-suite evidence; no keep bar or cost claim is inferred.",
    presentation: { label: "Observed test parallelization", betterLabel: "More unchanged-body parallel activations" },
  },
  summary: { nativeLabel: "Net unchanged-body test parallel activations" },
  metrics: [
    { id: "native-net", name: "Repository net unchanged-body parallel activations", role: "primary",
      formula: "qualifying leading parallel activations minus qualifying withdrawals in the non-overlapping period",
      unit: "tests", direction: "increase",
      presentation: { name: "Repository parallel activations", legendLabel: "Repository tests", transform: "identity" } },
    { id: "corroborated-net", name: "Corroborated workflow-linked net parallel activations", role: "diagnostic",
      formula: "the same native signed effects restricted to immutable merge revisions linked to this workflow",
      unit: "tests", direction: "increase",
      presentation: { name: "Workflow-linked parallel activations", legendLabel: "Linked tests", transform: "identity" } },
  ],
  signal: { metricId: "corroborated-net", basis: "workflow-contribution" },
  validationExamples: { targetAttained: example(2, 0), targetMissed: example(0, 0),
    missing: { valid: false, missingReason: "Native evidence unavailable" },
    malformed: { valid: true, complete: true, events: [{ id: "invalid", enabled: "2", disabled: 0, linked: true }] } },
};
export const scoreMetric = scoreGoParallelMetric;
export function collectBatch(requests) {
  const native = readGoHistory(path.join(proof, "native-v2"));
  const links = readCensusJson(path.join(proof, "links.json.gz"));
  if (native.index.oracleSha256 !== definition.evidence.oracleSha256
    || native.index.repository !== definition.repository || native.index.baseline !== definition.adoption.baselineCommit
    || links.repository !== definition.repository || links.complete !== true
    || links.workflowId !== definition.slug || links.sourceRevision !== native.index.revision
    || !Array.isArray(links.contributions)) throw new Error("Native parallelization evidence scope mismatch");
  const linked = new Set(links.contributions.map(row => row.mergeCommit));
  return requests.map(request => {
    if (![request.windowStart, request.windowEnd, request.observedAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
      || request.windowStart >= request.windowEnd || (request.repository && request.repository !== definition.repository)) {
      throw new Error("Invalid native parallelization evaluation window");
    }
    const inScope = request.windowStart >= definition.adoption.adoptedAt && request.windowEnd <= links.until;
    const rows = native.evaluated.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
    const events = rows.map(row => ({ id: row.commit, at: row.at,
      enabled: row.files.reduce((sum, file) => sum + (file.parallel?.enabled.length ?? 0), 0),
      disabled: row.files.reduce((sum, file) => sum + (file.parallel?.disabled.length ?? 0), 0),
      linked: linked.has(row.commit) }));
    return { evidence: { valid: inScope, complete: inScope && rows.every(row => row.parallelComplete),
      events, fullAcceptance: "not-measured", costs: "not-measured",
      ...(!inScope ? { missingReason: "Requested period extends beyond retained adoption-to-cutoff evidence." } : {}) },
    provenance: [{ repository: definition.repository, kind: "immutable-git-baseline", ref: definition.adoption.baselineCommit },
      { repository: definition.repository, kind: "immutable-git-head", ref: native.index.revision },
      { repository: definition.repository, kind: "native-oracle-sha256", ref: native.index.oracleSha256 }],
    commit: native.index.revision };
  });
}
