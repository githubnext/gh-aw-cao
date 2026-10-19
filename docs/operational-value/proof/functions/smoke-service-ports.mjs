import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  acceptance, cutoff, hash, jsonHash, parseSession, repository, revision,
  sourceBlob, sourcePath, verifyProtectedRedis,
} from "../../../../scripts/native-smoke-service-ports.mjs";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = new URL("../smoke-service-ports/", import.meta.url);
const packetDigest = "bb779976b982c1b5bcde3c43b41d2a4aeab1b69bfc8df5fbb1bd09d426d8bb8a";
const contractDigest = hash(readFileSync(new URL("contract.json", directory)));
const contract = readJsonArchive(fileURLToPath(new URL("contract.json", directory)));
if (jsonHash({ ...contract, frozenAt: null, designBasis: null })
  !== jsonHash({ ...acceptance, frozenAt: null, designBasis: null })) {
  throw new Error("Frozen source-defined acceptance changed");
}

const respRequest = (...args) => Buffer.from(`*${args.length}\r\n${args.map(arg => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`).toString("base64");
const bulk = value => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
const exchange = (id, sequence, args, response) => ({ id, sequence,
  request: respRequest(...args), response: Buffer.from(response).toString("base64") });
const exampleSession = (complete) => ({
  id: "synthetic-validation-session",
  exchanges: [
    exchange("ping", 1, ["PING"], "+PONG\r\n"),
    exchange("set", 2, ["SET", "smoke_test", "service-ports-ok"], "+OK\r\n"),
    exchange("get", 3, ["GET", "smoke_test"], bulk(complete ? "service-ports-ok" : "wrong-value")),
    exchange("info", 4, ["INFO", "server"], bulk(complete ? "# Server\r\nredis_version:7.2.0\r\n" : "")),
  ],
});
const example = complete => ({
  purpose: "synthetic-validation-only", contractDigest,
  sessions: [exampleSession(complete)],
  boundaryFixture: complete,
  contributionFixture: complete,
  neverNativeAdmission: true,
});
const targetAttained = example(true), targetMissed = example(false);
const exampleHashes = new Set([jsonHash(targetAttained), jsonHash(targetMissed)]);
const metric = (id, name, role, formula, unit, legendLabel) => ({
  id, name, role, formula, direction: "increase", unit,
  presentation: { name, legendLabel, transform: "identity" },
});

export const definition = {
  schemaVersion: 3, slug: "smoke-service-ports", repository,
  workflowName: "Smoke Service Ports", sourcePath,
  intent: {
    goal: acceptance.goal, acceptance: acceptance.fullAcceptance,
    temporalAnchor: "contract-activation",
  },
  adoption: {
    commit: revision, adoptedAt: "2026-10-19T11:13:09Z", baselineCommit: null, baselineAt: null,
  },
  activationRevisionMeaning: "Pinned immutable intent-source revision, not a workflow adoption or a claim that the new contract was committed there.",
  historicalApplicability: {
    status: "unresolved-adoption; partially-readable-contemporaneous-sources",
    apparentAddition: "74416d9a3f78063a065c03f3cc327f248e0d6e51",
    parent: "e1a597da8baa3f8fbd7682a8134659d8a3e93244",
    missingIntroductionBlob: "b0e303b917071aef8a80acbf35ec75d5a70dc6e3",
    establishedEarlierRules: {
      revision: "296262211b372a13b451ca9400369ac152db75d6",
      blob: "f5b6d2661d7e2ba04ad346f2e9c50d6552630ce7",
      meaning: "Same three host-endpoint Redis cases in readable April 2 source; not proof of operation or complete historical applicability.",
    },
    antecedent: "pre-existing-but-not-reconstructed",
    phenomenon: "Redis client/server PING, SET/GET and INFO can be attained by a person or another automation without this workflow.",
    evidenceGap: "The actual Oct17 run has independently corroborated native operations and the same intent-source blob. Introduction/adoption and complete historical population remain unknown; missing Git contents do not exhaust history.",
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "redis-source-defined-session-cases-v1",
    repositories: [repository],
    opportunity: acceptance.population,
    filters: [
      "Count each source-defined case at most once per service lifetime/session.",
      "Use actual completed-operation timestamps in inclusive-start/exclusive-end disjoint event cohorts.",
      "An independently proven partial protocol case does not require all broader safeguards.",
      "Do not accept workflow success, editable issue lineage, agent summaries, digest-shaped flags or declared service health as end-to-end Redis proof.",
      "No restart durability requirement; a GET without an observed preceding successful SET is not a round-trip.",
    ],
    collection: "Offline original run/attempt jobs and protected execution logs corroborate exact provider-digest-verified artifact tool calls. Recompute byte-framed PONG, SET/GET and projected INFO from those original payloads; caller flags cannot admit operations.",
    measurementKind: "interval",
    window: acceptance.window,
  },
  model: {
    architecture: "Parse native byte-framed Redis exchanges separately from independent receipt admission, endpoint proof and workflow contribution.",
    recommendation: "Retain partial proven operations; request only the exact missing run/attempt/service/client receipt endpoints. Do not infer zero or a keep decision.",
    presentation: { label: "Verified Redis cases", betterLabel: "More independently proven cases" },
  },
  summary: { nativeLabel: "Independently verified Redis cases per two-day event cohort" },
  metrics: [
    metric("verified-redis-cases", "Verified Redis cases", "primary",
      "sum over distinct sessions of independently authenticated PONG, SET/GET round-trip and INFO server cases", "cases", "Verified Redis cases"),
    metric("host-bound-sessions", "Full host-bound integration sessions", "diagnostic",
      "count distinct sessions with all three cases plus independently demonstrated sandbox-to-host.docker.internal:6379 binding", "sessions", "Host-bound sessions"),
    metric("workflow-contribution", "Receipt-linked workflow contributions", "diagnostic",
      "count accepted Redis cases with an independent matching workflow run/head/attempt/client/service receipt", "cases", "Workflow contributions"),
  ],
  validationExamples: {
    targetAttained, targetMissed,
    missing: { purpose: "native-observation", missingReason: "Native service/client receipts absent" },
    malformed: { purpose: "native-observation", accepted: true, verifiedCases: 3 },
  },
  validationLimitation: "Synthetic parser examples test arithmetic and protocol handling only. Their purpose and complete content are allowlisted; native collection never imports them or accepts their flags as authority.",
  rejectedMetrics: [
    "Green jobs, reports, issue closure and comments are mechanism/activity signals, not Redis outcomes.",
    "Declared Redis health PING proves neither agent reachability nor SET/GET nor INFO.",
    "TCP connectivity alone is not an application response.",
    "Restart/disk durability would expand the source-defined acceptance and is not measured.",
  ],
};

function readBoundPacket() {
  const file = new URL("native-input.json.gz", directory), bytes = readFileSync(file);
  if (hash(bytes) !== packetDigest) throw new Error("Frozen native input packet changed");
  const packet = readJsonArchive(fileURLToPath(file));
  if (packet.contractSha256 !== contractDigest || packet.repository !== repository
    || packet.revision !== revision || packet.cutoff !== cutoff || packet.repositoryId !== 1036865607) {
    throw new Error("Native packet source/contract identity mismatch");
  }
  for (const [name, digest] of [["sources.json.gz", packet.sourcesSha256], ["discovery.json.gz", packet.discoverySha256]]) {
    if (hash(readFileSync(new URL(name, directory))) !== digest) throw new Error("Native source/custody binding mismatch");
    readJsonArchive(fileURLToPath(new URL(name, directory)));
  }
  if (hash(readFileSync(new URL("../../../../scripts/native-smoke-service-ports.mjs", import.meta.url))) !== packet.checkerSha256) {
    throw new Error("Raw native parser version changed");
  }
  if (packet.candidateSha256
    && hash(readFileSync(new URL("candidate-receipts.json.gz", directory))) !== packet.candidateSha256) {
    throw new Error("Candidate artifact/source custody changed");
  }
  if (packet.candidateSha256) readJsonArchive(fileURLToPath(new URL("candidate-receipts.json.gz", directory)));
  if (!packet.protectedSha256
    || hash(readFileSync(new URL("protected-receipts.json.gz", directory))) !== packet.protectedSha256) {
    throw new Error("Independent protected original custody unavailable or changed");
  }
  const sources = readJsonArchive(fileURLToPath(new URL("sources.json.gz", directory)));
  if (!sources.runHeadBindings.includes(`${sourceBlob}\t${sourcePath}\n`)
    || !sources.runHeadBindings.includes(`47ce50ac9931c8d9960f2fae8b88dae6e00c2ecf\t${sourcePath.replace(".md", ".lock.yml")}\n`)) {
    throw new Error("Actual run-head source applicability changed");
  }
  const native = verifyProtectedRedis(
    readJsonArchive(fileURLToPath(new URL("candidate-receipts.json.gz", directory))),
    readJsonArchive(fileURLToPath(new URL("protected-receipts.json.gz", directory))),
  );
  if (jsonHash(native) !== jsonHash(packet.nativeReceipts)) throw new Error("Native receipt recomputation differs");
  return { ...packet, nativeReceipts: native };
}

function boundedRequest(request) {
  if (!request || !["windowStart", "windowEnd", "observedAt"].every(key =>
    typeof request[key] === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(request[key])
      && Number.isFinite(Date.parse(request[key])))
    || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
    || Date.parse(request.observedAt) < Date.parse(request.windowEnd)
    || request.repository && request.repository !== repository) throw new Error("Invalid bounded Redis observation request");
}

function cohort(packet, request) {
  const timestamp = value => value.replace(/(?:\.(\d+))?Z$/, (_, fraction = "") => `.${fraction.padEnd(7, "0")}Z`);
  return [...new Map(packet.nativeReceipts.filter(row =>
    timestamp(row.completedAt) >= timestamp(request.windowStart)
    && timestamp(row.completedAt) < timestamp(request.windowEnd)).map(row => [row.id, row])).values()];
}

function quantities(events) {
  const cases = name => events.length ? events.reduce((sum, event) => sum + Number(event.deliveredCases[name] === true), 0) : null;
  const total = events.length ? ["ping", "roundTrip", "info"].reduce((sum, name) => sum + cases(name), 0) : null;
  return {
    nativeProtocolCases: total, ping: cases("ping"), roundTrip: cases("roundTrip"), info: cases("info"),
    serviceStartup: events.length && events.every(row => row.serviceStartup === true) ? true : null,
    tcpReachability: events.length && events.some(row => row.tcpReachability === true) ? true : null,
    fullIntegration: events.length && events.every(row => row.integrationDelivered !== null)
      ? events.filter(row => row.integrationDelivered).length : null,
    workflowContribution: events.length ? events.reduce((sum, event) =>
      sum + (event.workflowContribution ? Object.values(event.deliveredCases).filter(value => value === true).length : 0), 0) : null,
  };
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new Error("Redis collector requires a request array");
  requests.forEach(boundedRequest);
  const packet = readBoundPacket();
  return requests.map(request => {
    const events = cohort(packet, request);
    return {
    commit: revision,
    evidence: {
      ...definition.evidence,
      purpose: "native-observation",
      contractDigest, packetDigest,
      windowStart: request.windowStart, windowEnd: request.windowEnd, observedAt: request.observedAt,
      coverageStatus: events.length ? "partial" : "missing", maturityStatus: events.length ? "matured" : "unavailable",
      eligibleCount: null, populationDigest: null,
      directCandidates: packet.directCandidates, relatedClosure: packet.relatedClosure,
      candidateProtocolStatus: "Actual independently protected job execution corroborates original PONG, SET/GET and INFO tool frames.",
      ...quantities(events),
      nativeEvents: events, eventCohort: "inclusive-start/exclusive-end",
      populationMeaning: "Observed-event lower bound, not an exhaustive repository opportunity count or attainment rate.",
      retrospectivelyAcquired: true,
      safeguards: { tokenTelemetry: null, sessionArtifact: null },
      costs: packet.costs, keep: packet.keep,
      historicalApplicability: definition.historicalApplicability,
      missingReason: events.length ? null : "No authenticated event in this cohort; incomplete population is not an observed zero.",
      limitations: packet.endpointGaps,
    },
    provenance: [
      { repository, kind: "immutable-workflow-intent", ref: `git:${revision}:${sourcePath}:${sourceBlob}` },
      { repository, kind: "preserved-native-input-custody", ref: `sha256:${packetDigest}` },
      { repository, kind: "frozen-acceptance", ref: `sha256:${contractDigest}` },
    ],
  };
  });
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) return null;
  if (!evidence || typeof evidence !== "object") return null;
  if (evidence.purpose === "synthetic-validation-only" && exampleHashes.has(jsonHash(evidence))) {
    const sessions = evidence.sessions.map(parseSession);
    const count = sessions.reduce((sum, session) => sum + session.protocolCases, 0);
    if (id === "verified-redis-cases") return count;
    if (id === "host-bound-sessions") return evidence.boundaryFixture ? sessions.filter(row => row.allProtocolCases).length : 0;
    return evidence.contributionFixture ? count : 0;
  }
  // Counts, accepted flags and digest-shaped strings supplied by a caller are
  // never independently authenticated service/client observations.
  if (evidence.purpose !== "native-observation" || evidence.contractDigest !== contractDigest
    || evidence.packetDigest !== packetDigest) return null;
  boundedRequest(evidence);
  const actual = quantities(cohort(readBoundPacket(), evidence));
  if (id === "verified-redis-cases") return actual.nativeProtocolCases;
  if (id === "host-bound-sessions") return actual.fullIntegration;
  return actual.workflowContribution;
}
