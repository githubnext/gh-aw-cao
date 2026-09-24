import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 86_400_000;
const ACTIVITY_CLI = fileURLToPath(new URL("../../activity/cao.mjs", import.meta.url));
const COMPARISON_TYPES = new Set([
  "optimization.comparison.observed",
  "token_efficiency.comparison",
]);

export const definition = {
  schemaVersion: 3,
  slug: "optimization-token-optimizer",
  sourcePath: ".github/workflows/optimization-token-optimizer.md",
  repository: "githubnext/gh-aw-cao",
  workflowName: "Optimization / Token Optimizer",
  adoption: {
    commit: "dc1e91886790cdac1bcfba3e8984186ad7f4a5e7",
    adoptedAt: "2026-09-15T23:30:36Z",
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "matured-token-efficiency-opportunity-cohort",
    repositories: [
      "github/gh-aw",
      "github/gh-aw-actions",
      "github/gh-aw-firewall",
      "github/gh-aw-mcpg",
      "github/gh-aw-threat-detection",
      "githubnext/gh-aw-cao",
    ],
    opportunity: "An evidence-complete frozen token-efficiency assignment for an authorized target repository and workflow using one of the nine adoption-time opportunity kinds.",
    filters: [
      "Include only immutable token-efficiency opportunities whose evidence state is complete.",
      "Match interventions and comparisons by stable opportunity and intervention identities.",
      "Use invocation-grain authoritative AI Credit and never combine it with run-aggregate AI Credit.",
      "Require the same frozen experiment, workload comparison key, acceptance rule, and outcome-quality evaluator for control and optimized variants.",
      "Treat an opportunity as attained only when net AI Credit per accepted outcome decreases, completed-run failure rate does not increase, outcome quality does not decrease, and the recommendation is applied.",
      "Mature each opportunity for fourteen days after assignment before scoring it.",
    ],
    collection: "Read canonical token-efficiency opportunity, intervention, and comparison audits from the CAO Activity database once, derive every requested repository cohort locally, and retain a SHA-256 digest of the database as provenance. Before the first cohort matures, and whenever a matured cohort still has unresolved outcome evidence, emit a clearly marked interim lower bound for dashboard visibility. A matured complete non-improvement or authoritative non-applied disposition is zero; inaccessible or incomparable source evidence remains missing.",
    window: { durationDays: 14, cadenceDays: 14, maturationDays: 14 },
  },
  model: {
    architecture: "Direct verified-attainment primary with separate uptake and guarded net-gain diagnostics.",
    recommendation: "Use verified opportunity attainment as the primary measure. Retain recommendation acceptance and guarded net-gain magnitude as diagnostics because uptake, coverage, and realized efficiency can disagree.",
    presentation: {
      label: "Verified token-efficiency attainment",
      betterLabel: "Higher means more matured opportunities produced verified net AI Credit gains without reliability or outcome-quality regression.",
    },
  },
  summary: { nativeLabel: "Share of matured token-efficiency opportunities with verified net gain" },
  metrics: [
    {
      id: "verified-opportunity-share",
      name: "Verified opportunity share",
      role: "primary",
      formula: "verifiedOpportunityCount / eligibleOpportunityCount when every matured eligible opportunity has complete outcome evidence",
      direction: "increase",
      presentation: { name: "Verified opportunity share", legendLabel: "Verified opportunities", transform: "identity" },
    },
    {
      id: "recommendation-acceptance-share",
      name: "Recommendation acceptance share",
      role: "diagnostic",
      formula: "acceptedRecommendationCount / eligibleOpportunityCount when every matured eligible opportunity has an authoritative disposition",
      direction: "increase",
      presentation: { name: "Recommendation acceptance share", legendLabel: "Accepted recommendations", transform: "identity" },
    },
    {
      id: "guarded-net-gain-magnitude",
      name: "Guarded net-gain magnitude",
      role: "diagnostic",
      formula: "sum of clamped verified net gain ratios, with complete misses contributing zero, divided by eligibleOpportunityCount when every matured eligible opportunity has complete outcome evidence",
      direction: "increase",
      presentation: { name: "Guarded net-gain magnitude", legendLabel: "Net-gain magnitude", transform: "identity" },
    },
  ],
  validationExamples: {
    targetAttained: {
      eligibleOpportunityCount: 2,
      verifiedOpportunityCount: 2,
      acceptedRecommendationCount: 2,
      outcomeUnknownCount: 0,
      dispositionUnknownCount: 0,
      guardedNetGainRatioSum: 0.5,
    },
    targetMissed: {
      eligibleOpportunityCount: 2,
      verifiedOpportunityCount: 0,
      acceptedRecommendationCount: 0,
      outcomeUnknownCount: 0,
      dispositionUnknownCount: 0,
      guardedNetGainRatioSum: 0,
    },
    missing: {
      eligibleOpportunityCount: 0,
      verifiedOpportunityCount: 0,
      acceptedRecommendationCount: 0,
      outcomeUnknownCount: 0,
      dispositionUnknownCount: 0,
      guardedNetGainRatioSum: 0,
    },
    malformed: {
      eligibleOpportunityCount: "two",
      verifiedOpportunityCount: -1,
      acceptedRecommendationCount: null,
      outcomeUnknownCount: "unknown",
      dispositionUnknownCount: -1,
      guardedNetGainRatioSum: "large",
    },
  },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) fail(String(result.stderr || `${command} failed`).trim());
  return result.stdout;
}

function round(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function validCount(value) {
  return Number.isInteger(value) && value >= 0;
}

export function scoreMetric(metricId, evidence) {
  const eligible = evidence?.eligibleOpportunityCount;
  if (!validCount(eligible)) return null;
  if (eligible === 0) return evidence?.maturityStatus === "interim" ? 0 : null;

  if (metricId === "verified-opportunity-share") {
    if (!validCount(evidence.verifiedOpportunityCount)
        || evidence.verifiedOpportunityCount > eligible
        || !validCount(evidence.outcomeUnknownCount)
        || evidence.outcomeUnknownCount > eligible) return null;
    return round(evidence.verifiedOpportunityCount / eligible);
  }
  if (metricId === "recommendation-acceptance-share") {
    if (!validCount(evidence.acceptedRecommendationCount)
        || evidence.acceptedRecommendationCount > eligible
        || !validCount(evidence.dispositionUnknownCount)
        || evidence.dispositionUnknownCount > eligible) return null;
    return round(evidence.acceptedRecommendationCount / eligible);
  }
  if (metricId === "guarded-net-gain-magnitude") {
    if (typeof evidence.guardedNetGainRatioSum !== "number"
        || !Number.isFinite(evidence.guardedNetGainRatioSum)
        || evidence.guardedNetGainRatioSum < 0
        || evidence.guardedNetGainRatioSum > eligible
        || !validCount(evidence.outcomeUnknownCount)
        || evidence.outcomeUnknownCount > eligible) return null;
    return round(evidence.guardedNetGainRatioSum / eligible);
  }
  fail(`unknown metric: ${metricId}`);
}

function latestBy(records, key) {
  const latest = new Map();
  for (const record of records) {
    const id = record?.[key];
    if (typeof id !== "string" || id.length === 0) continue;
    const prior = latest.get(id);
    if (!prior || String(record.timestamp ?? "") > String(prior.timestamp ?? "")) latest.set(id, record);
  }
  return latest;
}

function completeComparison(record, intervention) {
  if (!record || record.evidenceState !== "complete"
      || intervention?.recommendationDisposition !== "applied") return false;
  return typeof record.verifiedNetGain === "number"
    && Number.isFinite(record.verifiedNetGain)
    && typeof record.baselineFailureRate === "number"
    && typeof record.optimizedFailureRate === "number"
    && record.optimizedFailureRate <= record.baselineFailureRate
    && record.outcomeQualityPreserved === true;
}

export function buildEvidence(records, request) {
  const firstMatureAt = Date.parse(definition.adoption.adoptedAt)
    + (definition.evidence.window.durationDays + definition.evidence.window.maturationDays) * DAY_MS;
  if (Date.parse(request.observedAt) < firstMatureAt) {
    return {
      maturityStatus: "interim",
      dubious: true,
      eligibleOpportunityCount: 0,
      verifiedOpportunityCount: 0,
      acceptedRecommendationCount: 0,
      outcomeUnknownCount: 0,
      dispositionUnknownCount: 0,
      guardedNetGainRatioSum: 0,
    };
  }
  const repository = request.repository?.toLowerCase();
  const supportedRepositories = new Set(
    definition.evidence.repositories.map((value) => value.toLowerCase()),
  );
  const inRepository = (record) => {
    const target = String(record?.targetRepo ?? "").toLowerCase();
    return repository ? target === repository : supportedRepositories.has(target);
  };
  const availableAtObservation = (record) =>
    String(record?.timestamp ?? "") <= request.observedAt;
  const opportunities = [...latestBy(records.filter((record) =>
    record?.type === "token_efficiency.opportunity"
    && record.evidenceState === "complete"
    && inRepository(record)
    && String(record.timestamp) >= request.windowStart
    && String(record.timestamp) < request.windowEnd), "opportunityId").values()];
  const interventionsById = latestBy(records.filter((record) =>
    record?.type === "token_efficiency.intervention"
    && inRepository(record)
    && availableAtObservation(record)), "interventionId");
  const comparisons = records.filter((record) =>
    COMPARISON_TYPES.has(record?.type)
    && inRepository(record)
    && availableAtObservation(record));

  let verifiedOpportunityCount = 0;
  let acceptedRecommendationCount = 0;
  let outcomeUnknownCount = 0;
  let dispositionUnknownCount = 0;
  let guardedNetGainRatioSum = 0;

  for (const opportunity of opportunities) {
    const interventions = [...interventionsById.values()]
      .filter((record) => record.opportunityId === opportunity.opportunityId)
      .toSorted((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
    const intervention = interventions.find((record) =>
      record.recommendationDisposition !== "superseded") ?? interventions[0];
    if (!intervention) {
      dispositionUnknownCount += 1;
      outcomeUnknownCount += 1;
      continue;
    }

    if (intervention.recommendationDisposition === "applied") {
      acceptedRecommendationCount += 1;
    } else if (typeof intervention.recommendationDisposition !== "string") {
      dispositionUnknownCount += 1;
    }

    const comparison = comparisons
      .filter((record) => record.opportunityId === opportunity.opportunityId
        && (!intervention.interventionId || record.interventionId === intervention.interventionId))
      .toSorted((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)))[0];
    if (completeComparison(comparison, intervention)) {
      const ratio = Math.max(0, Math.min(1, comparison.verifiedNetGain));
      guardedNetGainRatioSum += ratio;
      if (ratio > 0 && intervention.interventionState === "verified") {
        verifiedOpportunityCount += 1;
      }
      continue;
    }

    const disposition = intervention.recommendationDisposition;
    const terminalMiss = ["rejected", "failed-start", "outdated", "duplicate", "unapplied"]
      .includes(disposition)
      || ["regressed", "inconclusive", "rejected"].includes(intervention.interventionState);
    if (!terminalMiss) outcomeUnknownCount += 1;
  }

  return {
    maturityStatus: outcomeUnknownCount > 0 || dispositionUnknownCount > 0 ? "interim" : "matured",
    dubious: outcomeUnknownCount > 0 || dispositionUnknownCount > 0,
    eligibleOpportunityCount: opportunities.length,
    verifiedOpportunityCount,
    acceptedRecommendationCount,
    outcomeUnknownCount,
    dispositionUnknownCount,
    guardedNetGainRatioSum: round(guardedNetGainRatioSum),
  };
}

function queryAudits(database) {
  const types = [
    "token_efficiency.opportunity",
    "token_efficiency.intervention",
    ...COMPARISON_TYPES,
  ];
  return types.flatMap((type) => {
    const output = run(process.execPath, [
      ACTIVITY_CLI,
      "query",
      "--database",
      database,
      "--collection",
      "audits",
      "--where",
      `type=${type}`,
      "--limit",
      "10000",
    ]);
    const records = JSON.parse(output);
    if (!Array.isArray(records)) fail(`Activity query returned invalid ${type} evidence`);
    if (records.length === 10_000) fail(`Activity query exceeded the ${type} evidence limit`);
    return records;
  });
}

export async function collectBatch(requests, context = {}) {
  const valid = Array.isArray(requests) && requests.length > 0
    && requests.every((request) => ["windowStart", "windowEnd", "observedAt"]
      .every((key) => typeof request[key] === "string" && !Number.isNaN(Date.parse(request[key])))
      && (!request.repository || definition.evidence.repositories
        .some((repository) => repository.toLowerCase() === request.repository.toLowerCase()))
      && Date.parse(request.windowEnd) - Date.parse(request.windowStart) === 14 * DAY_MS
      && Date.parse(request.observedAt) - Date.parse(request.windowEnd) >= 14 * DAY_MS);
  if (!valid) fail("invalid batch collection request");
  if (!existsSync(ACTIVITY_CLI)) fail("CAO Activity CLI is unavailable");

  let temporary;
  let database = context.database;
  try {
    if (!database) {
      temporary = mkdtempSync(path.join(process.cwd(), ".aw-value-optimization-token-optimizer."));
      run(process.execPath, [ACTIVITY_CLI, "download", "--output", temporary]);
      database = path.join(temporary, "gh-aw-logs.sqlite");
    }
    if (!existsSync(database)) {
      return requests.map(() => ({
        evidence: {
          key: definition.evidence.key,
          maturityStatus: "unavailable",
          unavailableReason: "cao-activity-database-missing",
        },
        provenance: [],
      }));
    }
    const records = queryAudits(database);
    const digest = createHash("sha256").update(readFileSync(database)).digest("hex");
    return requests.map((request) => ({
      evidence: {
        key: definition.evidence.key,
        repositories: request.repository
          ? [request.repository]
          : definition.evidence.repositories,
        opportunity: definition.evidence.opportunity,
        filters: definition.evidence.filters,
        collection: definition.evidence.collection,
        window: {
          start: request.windowStart,
          end: request.windowEnd,
          observedAt: request.observedAt,
          ...definition.evidence.window,
        },
        ...buildEvidence(records, request),
      },
      provenance: [{
        repository: definition.repository,
        kind: "cao-activity-sqlite-sha256",
        ref: digest,
      }],
    }));
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
