import { readFileSync } from "node:fs";
import { contract, hash, nativeCases } from "../codex-remote-mcp/native.mjs";

const lockSha256 = "f50641e8742f9e9f2bfb62e2ed888f1fe3e283b3fc813df2dcdb12282266ac2b";
const lockBytes = readFileSync(new URL("../codex-remote-mcp/instrument-lock.json", import.meta.url));
if (hash(lockBytes) !== lockSha256) throw new Error("Codex MCP instrument lock changed");
const instrument = JSON.parse(lockBytes), root = new URL("../../../../", import.meta.url);
for (const row of instrument.files) {
  if (hash(readFileSync(new URL(row.file, root))) !== row.sha256) throw new Error(`Codex MCP instrument dependency changed: ${row.file}`);
}
const contractSha256 = instrument.files.find(row => row.file.endsWith("/contract.json")).sha256;
const sample = cases => ({ workflow: contract.workflow, contractSha256, cases });
const metric = (id, name, role, unit, formula) => ({ id, name, role, unit, formula, direction: "increase",
  presentation: { name, legendLabel: name.slice(0, 24), transform: "identity" } });
export const definition = {
  schemaVersion: 3, slug: contract.workflow, repository: contract.repository, workflowName: contract.workflow,
  sourcePath: `.github/workflows/${contract.workflow}.md`,
  intent: { goal: contract.goal, acceptance: contract.acceptance.nativeAccess, temporalAnchor: "workflow-adoption" },
  adoption: nativeCases().adoption, evaluation: { mode: "attainment-only" },
  evidence: { key: `${contract.workflow}-${contract.version}`, repositories: [contract.repository],
    opportunity: contract.selection.population,
    filters: [...Object.values(contract.acceptance), ...contract.limitations],
    collection: "Offline exact provider-digest artifact, protected Codex stdout, matching native/normalized call IDs, independently captured official-backend gateway exchange and integrity-filter resource witnesses.",
    measurementKind: "interval", window: contract.window },
  model: { architecture: "Frozen source-native access predicate; upstream server bytes and post-policy agent delivery are different evidence surfaces.",
    recommendation: "Not rated; no keep threshold, inferred repository repairs or measured costs.",
    presentation: { label: "Verified Codex remote MCP access", betterLabel: "More independently verified native access opportunities" } },
  summary: { nativeLabel: "Verified Codex remote MCP access" },
  metrics: [
    metric("native-access", "Verified native access", "primary", "verified access attempts",
      "Count distinct source-bound attempts with independently correlated non-error native remote-MCP access; null without an assessed native case."),
    metric("filtered-resources", "Native filtered resources", "diagnostic", "policy-filtered resources",
      "Count concrete independent integrity-filter resource witnesses within accepted native accesses, not agent-readable issues."),
    metric("upstream-issues", "Upstream open issues", "diagnostic", "upstream issue identities",
      "Count distinct open issue identities in accepted upstream server exchanges; never substitute these pre-filter bytes for agent readback."),
  ],
  validationExamples: {
    targetAttained: sample([{ id: "fixture-accepted", status: "accepted", nativeAccess: 1, filteredResources: 3, upstreamIssues: 3 }]),
    targetMissed: sample([{ id: "fixture-rejected", status: "rejected", nativeAccess: 0, filteredResources: 0, upstreamIssues: 0 }]),
    missing: {}, malformed: sample([{ id: "fixture-malformed", status: "accepted", nativeAccess: "1" }]),
  },
  implementation: { lockSha256, contractSha256,
    limitations: "Bounded retained native filtered-response interface; unknown or changed provider formats are never automatically accepted." },
  limitations: { fullGoal: null, agentIssueReadback: null, workflowContribution: null, costs: null, keepDecision: "not rated",
    sourceEra: "October 3's executed source required titles and did not yet declare filtering an expected result. Modern policy language is not backdated into full historical success.",
    correlation: "Native call-ID and exact arguments/time bounds plus a unique sequential gateway exchange, not a fabricated shared gateway request ID." },
};

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(row => row.id === id) || evidence?.workflow !== contract.workflow
    || evidence.contractSha256 !== contractSha256 || !Array.isArray(evidence.cases)
    || new Set(evidence.cases.map(row => row?.id)).size !== evidence.cases.length
    || evidence.cases.some(row => typeof row?.id !== "string" || !row.id
      || !["accepted", "rejected", "unknown"].includes(row.status)
      || row.status === "accepted" && row.nativeAccess !== 1
      || row.status === "rejected" && row.nativeAccess !== 0)) return null;
  const known = evidence.cases.filter(row => row.status !== "unknown");
  if (!known.length) return null;
  if (id === "native-access") return known.filter(row => row.status === "accepted").length;
  const field = id === "filtered-resources" ? "filteredResources" : "upstreamIssues";
  const values = known.map(row => row[field]);
  return values.every(value => Number.isSafeInteger(value) && value >= 0)
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
export async function collectBatch(requests) {
  if (!Array.isArray(requests) || requests.some(row => !row
    || ![row.windowStart, row.windowEnd, row.observedAt].every(utc)
    || row.windowStart >= row.windowEnd || row.windowEnd > row.observedAt
    || row.repository !== undefined && row.repository !== contract.repository)) throw new Error("Invalid Codex MCP measurement window/scope");
  const native = nativeCases();
  return requests.map(request => {
    const cases = request.windowStart >= native.adoption.adoptedAt && request.windowEnd <= contract.cutoff
      ? native.cases.filter(row => request.windowStart <= row.at && row.at < request.windowEnd) : [];
    const assessed = cases.some(row => row.status !== "unknown");
    return { evidence: { ...sample(cases), ...request,
      coverageStatus: assessed ? "selected-native-cohort" : "missing",
      fullGoal: null, workflowContribution: null, costs: null, keepDecision: "not rated",
      completeComparablePeriod: false,
      missingReason: assessed ? null : "No independently assessed native access in this cohort; absent original agent jobs are not zero delivery.",
    }, provenance: [
      { repository: contract.repository, kind: "immutable-workflow-source", ref: contract.revision },
      { repository: contract.repository, kind: "native-contract-sha256", ref: contractSha256 },
      { repository: contract.repository, kind: "native-instrument-lock-sha256", ref: lockSha256 },
    ], commit: contract.revision };
  });
}
