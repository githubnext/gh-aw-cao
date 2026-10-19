import { readFileSync } from "node:fs";
import { contract, hash, nativeCases } from "../mcp-auth-native/native.mjs";

const dependencies = [
  ["../mcp-auth-native/native.mjs", "4c959f1e7f858c0c4f9aaf8516e7b6efcd192c1998e80e41f27c30e4d6565baf"],
  ["../mcp-auth-native/contract.json", "678101b04ade2a4d1a66b8d6ef8fb2ac89d9f846b96f61c275e059a60da98964"],
  ["../mcp-auth-native/originals.json.gz", "32c2f2120684a1b10c34dc53936e75a33af1cd19fae01f59004b8ccca8074f94"],
  ["../../../../.github/skills/add-operational-value/scripts/json-archive.mjs", "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b"],
];
for (const [file, digest] of dependencies) {
  if (hash(readFileSync(new URL(file, import.meta.url))) !== digest) throw new Error(`Raw MCP instrument changed: ${file}`);
}
const contractSha256 = dependencies[1][1];
const sample = cases => ({ workflow: contract.workflow, contractSha256, cases });
export const definition = {
  schemaVersion: 3, slug: contract.workflow, repository: contract.repository, workflowName: contract.workflow,
  sourcePath: `.github/workflows/${contract.workflow}.md`,
  intent: { goal: contract.goal, acceptance: contract.nativeFacet, temporalAnchor: "workflow-adoption" },
  adoption: nativeCases().adoption, evaluation: { mode: "attainment-only" },
  evidence: { key: `${contract.workflow}-${contract.version}`, repositories: [contract.repository],
    opportunity: "Three fixed pre-cutoff raw-canary attempts, not the lifetime run population",
    filters: [...contract.acceptance, "Seven-day reporting is an explicit retrospective presentation choice, not a claim of ex-ante cadence or exhaustive weekly test coverage."],
    collection: "Offline original GitHub responses: public repository identity, exact run/attempt/jobs, executed source/compiled scripts and protected raw-step runtime witnesses.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
  model: { architecture: "One frozen source-defined transport predicate; acquisition is separate from model-free native verification and scoring.",
    recommendation: "Not rated; no keep threshold, monetary value or workflow repair attribution.",
    presentation: { label: "Verified raw MCP transport checks", betterLabel: "More independently verified sampled compatibility checks" } },
  summary: { nativeLabel: "Verified raw MCP transport checks" },
  metrics: [{ id: "native-transport", name: "Verified raw MCP transport checks", role: "primary", direction: "increase",
    formula: "Count distinct assessed run-attempt identities whose source-bound protected raw step independently witnesses the complete frozen transport predicate; null without an assessed selected cohort.",
    unit: contract.unit, presentation: { name: "Verified raw MCP transport checks", legendLabel: "Native transport", transform: "identity" } }],
  validationExamples: {
    targetAttained: sample([{ id: "fixture-accepted", status: "accepted" }]),
    targetMissed: sample([{ id: "fixture-rejected", status: "rejected" }]),
    missing: {}, malformed: sample([{ id: "fixture-malformed", status: "success" }]),
  },
  instrument: dependencies.map(([file, sha256]) => ({ file, sha256 })),
  limitations: { ...Object.fromEntries(["fullGoal", "agentUsability", "issueContent", "credentialClass",
    "workflowContribution", "safeguards", "costs", "exhaustiveRunPopulation"].map(key => [key, null])),
  keepDecision: "not rated", explanation: contract.limitations,
  authentication: "The executed source permits secret-token fallbacks before GITHUB_TOKEN. Masked logs do not identify the credential class." },
};

export function scoreMetric(id, evidence) {
  if (id !== "native-transport" || evidence?.workflow !== contract.workflow
    || evidence.contractSha256 !== contractSha256 || !Array.isArray(evidence.cases) || !evidence.cases.length
    || new Set(evidence.cases.map(row => row?.id)).size !== evidence.cases.length
    || evidence.cases.some(row => typeof row?.id !== "string" || !row.id
      || !["accepted", "rejected"].includes(row.status))) return null;
  return evidence.cases.filter(row => row.status === "accepted").length;
}

const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
export async function collectBatch(requests) {
  if (!Array.isArray(requests) || requests.some(request => !request
    || ![request.windowStart, request.windowEnd, request.observedAt].every(utc)
    || request.windowStart >= request.windowEnd || request.windowEnd > request.observedAt
    || request.repository !== undefined && request.repository !== contract.repository)) throw new Error("Invalid raw MCP measurement request");
  const native = nativeCases();
  return requests.map(request => {
    const cases = request.windowStart >= native.adoption.adoptedAt && request.windowEnd <= contract.cutoff
      ? native.cases.filter(row => request.windowStart <= row.at && row.at < request.windowEnd) : [];
    return { evidence: {
      ...sample(cases), windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
      coverageStatus: cases.length ? "selected-native-cohort" : "missing",
      fullGoal: null, agentUsability: null, exactIssueReadback: null, credentialClass: null,
      workflowContribution: null, safeguards: null, costs: null, keepDecision: "not rated",
      completeComparablePeriod: false,
      missingReason: cases.length ? null : "No selected native execution assessed in this interval; not zero delivery or failed authentication.",
    }, provenance: [
      { repository: contract.repository, kind: "immutable-workflow-source", ref: contract.revision },
      { repository: contract.repository, kind: "native-contract-sha256", ref: contractSha256 },
      { repository: contract.repository, kind: "protected-raw-job-originals-sha256", ref: dependencies[2][1] },
    ], commit: contract.revision };
  });
}
