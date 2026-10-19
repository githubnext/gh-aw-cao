import { deepEqual } from "./common.mjs";

const DAY = 86_400_000;
const finite = value => typeof value === "number" && Number.isFinite(value);
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;

export function validateReviewPolicy(definition) {
  const policy = definition.review;
  if (policy === undefined) return null;
  const allowed = ["metricId", "basis", "periods", "minimum", "maximum", "rationale"];
  if (!policy || Object.keys(policy).some(key => !allowed.includes(key))
    || !definition.metrics.some(metric => metric.id === policy.metricId)
    || (policy.basis === "workflow-contribution"
      && definition.metrics.find(metric => metric.id === policy.metricId)?.role !== "diagnostic")
    || !["repository-outcome", "workflow-contribution"].includes(policy.basis)
    || !Number.isSafeInteger(policy.periods) || policy.periods < 1
    || typeof policy.rationale !== "string" || !policy.rationale.trim()
    || (!Object.hasOwn(policy, "minimum") && !Object.hasOwn(policy, "maximum"))
    || (Object.hasOwn(policy, "minimum") && !finite(policy.minimum))
    || (Object.hasOwn(policy, "maximum") && !finite(policy.maximum))
    || (finite(policy.minimum) && finite(policy.maximum) && policy.minimum > policy.maximum)) {
    throw new Error("Invalid value-review policy: declare a metric, basis, periods, native bounds and rationale");
  }
  return policy;
}

function periodQuality(snapshot, definition, endpoint) {
  const evidence = snapshot.evidence;
  const window = definition.evidence.window;
  const start = timestamp(snapshot.window?.startAt);
  const end = timestamp(snapshot.window?.endAt);
  const observed = timestamp(snapshot.observedAt);
  if (![start, end, observed, endpoint].every(Number.isFinite) || end <= start) return "invalid-window";
  if (end - start !== window.durationDays * DAY) return "partial-window";
  if (observed > endpoint || end > observed) return "future-assessment";
  if (evidence.coverageStatus !== "complete") return "incomplete-evidence";
  if ((evidence.maturityStatus !== undefined && evidence.maturityStatus !== "matured") || evidence.dubious === true
    || observed < end + window.maturationDays * DAY) return "provisional";
  return "complete";
}

export function reviewValue(timeline) {
  const definition = timeline.valueFunction.definition;
  const policy = validateReviewPolicy(definition);
  const primary = definition.metrics.find(metric => metric.role === "primary");
  const endpoint = timestamp(timeline.window.endAt);
  const unique = new Map();
  for (const snapshot of timeline.snapshots) {
    const key = `${timestamp(snapshot.window?.startAt)}:${timestamp(snapshot.window?.endAt)}`;
    const prior = unique.get(key);
    if (!prior || timestamp(snapshot.observedAt) >= timestamp(prior.observedAt)) unique.set(key, snapshot);
  }
  const selected = [...unique.values()].sort((left, right) =>
    timestamp(left.window?.endAt) - timestamp(right.window?.endAt)
    || timestamp(left.observedAt) - timestamp(right.observedAt));
  const periods = selected.map(snapshot => ({
    window: snapshot.window ?? null,
    observedAt: snapshot.observedAt,
    status: periodQuality(snapshot, definition, endpoint),
    missingReason: snapshot.evidence.missingReason ?? null,
    eligibleCount: Number.isSafeInteger(snapshot.evidence.eligibleCount) && snapshot.evidence.eligibleCount >= 0
      ? snapshot.evidence.eligibleCount : null,
    metrics: Object.fromEntries(definition.metrics.map(metric =>
      [metric.id, finite(snapshot.metrics[metric.id]) ? snapshot.metrics[metric.id] : null])),
  }));
  const latest = periods.at(-1) ?? null;
  const latestAge = latest ? endpoint - timestamp(latest.observedAt) : NaN;
  const cutoffAge = latest ? endpoint - timestamp(latest.window?.endAt)
    - definition.evidence.window.maturationDays * DAY : NaN;
  const stale = !Number.isFinite(latestAge) || latestAge < 0 || latestAge >= definition.evidence.window.cadenceDays * DAY
    || !Number.isFinite(cutoffAge) || cutoffAge < 0 || cutoffAge >= definition.evidence.window.cadenceDays * DAY;
  const currentValue = latest?.metrics[primary.id] ?? null;
  const current = { value: currentValue, unit: primary.unit,
    status: currentValue === null ? "unavailable" : latest.status, window: latest?.window ?? null,
    eligibleCount: latest?.eligibleCount ?? null, stale };
  let decision = { status: "not-rated", reason: "No agreed native keep bar and review duration.", policy: null };
  if (policy) {
    const recent = [];
    let period = latest;
    while (period && recent.length < policy.periods) {
      recent.unshift(period);
      const current = period;
      period = periods.findLast(candidate => candidate !== current
        && (definition.evidence.measurementKind === "interval"
          ? timestamp(candidate.window?.endAt) === timestamp(current.window?.startAt)
          : timestamp(current.window?.endAt) - timestamp(candidate.window?.endAt)
            === definition.evidence.window.cadenceDays * DAY));
    }
    const adjacent = recent.every((period, index) => index === 0 || (
      definition.evidence.measurementKind === "interval"
        ? timestamp(recent[index - 1].window.endAt) === timestamp(period.window.startAt)
        : timestamp(period.window.endAt) - timestamp(recent[index - 1].window.endAt)
          === definition.evidence.window.cadenceDays * DAY
    ));
    const contributionIntervals = policy.basis !== "workflow-contribution" || definition.evidence.measurementKind === "interval";
    const ready = contributionIntervals && !stale && recent.length === policy.periods && adjacent
      && recent.every(period => period.status === "complete" && period.eligibleCount > 0
        && finite(period.metrics[primary.id]) && finite(period.metrics[policy.metricId])
        && (policy.basis !== "workflow-contribution"
          || timestamp(definition.evidence.measurementKind === "interval" ? period.window.startAt : period.window.endAt)
            >= timestamp(definition.adoption.adoptedAt)));
    if (!ready) {
      decision = { status: "insufficient-evidence", reason:
        contributionIntervals
          ? "Need fresh, complete, mature consecutive periods with known nonzero opportunities and the reviewed metric."
          : "Workflow keep/change needs accepted contributions in non-overlapping interval cohorts; snapshot states are not new deliveries.",
      policy };
    } else {
      const meets = recent.map(period => (!finite(policy.minimum) || period.metrics[policy.metricId] >= policy.minimum)
        && (!finite(policy.maximum) || period.metrics[policy.metricId] <= policy.maximum));
      const attained = meets.every(Boolean);
      decision = { status: attained ? policy.basis === "workflow-contribution" ? "keep-candidate" : "goal-met"
        : meets.every(value => !value) ? policy.basis === "workflow-contribution" ? "change-or-retire-candidate" : "goal-missed"
          : "mixed",
      reason: policy.basis === "repository-outcome"
        ? "Repository attainment does not establish this workflow's contribution or whether it is worth keeping."
        : attained ? "The declared workflow-contribution bar was met in every reviewed period."
          : meets.every(value => !value) ? "The declared workflow-contribution bar was missed in every reviewed period; inspect before changing or retiring."
            : "The declared workflow-contribution bar was met in some reviewed periods, not all.",
      policy };
    }
  }
  const recent = timeline.metricReview.metrics.find(metric => metric.id === primary.id).recentComparison;
  const comparable = !stale && latest?.status === "complete" && periods.at(-2)?.status === "complete"
    && finite(latest.metrics[primary.id]) && finite(periods.at(-2).metrics[primary.id]);
  return { schemaVersion: 1, primaryMetricId: primary.id, current, periods, decision,
    recentComparison: comparable ? recent : { ...recent, status: "unavailable",
      reason: "Fresh complete mature evidence is required for recent movement.", nativeDelta: null, directionAwareGain: null },
    cost: { status: "not-measured", total: null, unit: null, costPerAcceptedOutcome: null },
    limitation: "Native outcome evidence and declared contribution are not causal attribution or a monetary return." };
}

export function validateValueReview(timeline) {
  if (!deepEqual(timeline.valueReview, reviewValue(timeline))) throw new Error("Value review differs from its frozen evidence or policy");
}
