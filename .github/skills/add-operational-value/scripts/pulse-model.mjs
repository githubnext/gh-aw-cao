import { isRepository, isSlug } from "./common.mjs";
import { reviewValue } from "./review-value.mjs";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const finite = value => typeof value === "number" && Number.isFinite(value);
const time = value => typeof value === "string" ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const gain = (metric, before, after) => {
  const delta = metric.direction === "increase" ? after - before
    : metric.direction === "decrease" ? before - after
      : Math.abs(before - metric.target) - Math.abs(after - metric.target);
  // Ignore floating-point roundoff, not a domain-specific materiality threshold.
  const roundoff = Number.EPSILON * (Math.abs(before) + Math.abs(after)) * 4;
  return Math.abs(delta) <= roundoff ? 0 : delta;
};
const headline = metric => ({ ...metric.signal, metricId: metric.id, basis: metric.basis,
  unit: metric.kind === "events" ? `${metric.unit}/week` : metric.unit });

export function readerSummary(metric) {
  const status = metric.signal;
  const contribution = metric.basis === "workflow-contribution";
  const subject = contribution ? "Linked contribution" : metric.basis === "repository-outcome"
    ? "The repository measure" : "The diagnostic measure";
  const ready = status.status !== "insufficient-evidence";
  const title = !ready ? "Not enough evidence to compare recent results"
    : status.status === "no-opportunity" ? "No eligible work observed"
      : metric.kind === "events" && status.current === 0
        ? `No net improvement in the last ${metric.shortDays} days`
        : status.status === "stalled" ? "No recent measured contribution"
          : status.status === "improving" ? `${subject} is improving`
            : status.status === "worsening" ? contribution && gain(metric, 0, status.current) > 0
              ? "Recent measured contribution has slowed" : `${subject} has worsened`
              : `${subject} is unchanged between comparable periods`;
  return {
    title,
    caution: contribution
      ? "Linked changes show a measured contribution, not exclusive workflow credit or proof that every quality requirement passed."
      : "Repository movement includes everyone's work; it does not establish this workflow's causal impact.",
    next: !ready || status.attention === "evidence-needed"
      ? "Check missing coverage, evidence freshness and eligible work before judging the workflow."
      : status.status === "no-opportunity"
        ? "Check whether the workflow had suitable work to do; a quiet period alone is not failure."
        : contribution
          ? "Inspect recent proposals and their acceptance state. This view alone cannot distinguish no proposals, waiting for acceptance or ineffective changes."
          : "Inspect the repository changes and linked implementations behind this movement before changing the workflow.",
  };
}

export function signalPolicy(definition) {
  const primary = definition.metrics.find(metric => metric.role === "primary");
  const policy = definition.signal ?? (definition.review
    ? { metricId: definition.review.metricId, basis: definition.review.basis }
    : { metricId: primary.id, basis: "repository-outcome" });
  const metric = definition.metrics.find(metric => metric.id === policy?.metricId);
  if (!policy || Object.keys(policy).some(key => !["metricId", "basis"].includes(key))
    || !metric || !["repository-outcome", "workflow-contribution"].includes(policy.basis)
    || (definition.review?.metricId === policy.metricId && definition.review.basis !== policy.basis)
    || (policy.basis === "workflow-contribution" && metric.role !== "diagnostic")) {
    throw new Error("Invalid signal policy: select an existing metric and explicit outcome/contribution basis");
  }
  return policy;
}

function signal(metric, { current, previous, ready, reason, opportunities, basis, missedBar = false }) {
  const movement = ready ? gain(metric, previous, current) : null;
  const noOpportunity = ready && basis === "workflow-contribution" && opportunities === 0;
  const stalled = ready && basis === "workflow-contribution" && metric.direction === "increase"
    && current === 0 && previous === 0 && opportunities > 0;
  const unexplainedZero = ready && basis === "workflow-contribution"
    && current === 0 && previous === 0 && opportunities == null;
  const status = !ready ? "insufficient-evidence" : noOpportunity ? "no-opportunity"
    : stalled ? "stalled" : movement > 0 ? "improving" : movement < 0 ? "worsening" : "steady";
  const attention = !ready || unexplainedZero ? "evidence-needed"
    : missedBar || stalled || (!noOpportunity && movement < 0) ? "review" : "not-indicated";
  return { status, attention, current, previous, directionAwareGain: movement,
    reason: !ready ? reason : noOpportunity ? "No eligible opportunities were observed."
      : stalled ? "No delivery in either comparable period despite known opportunities."
        : unexplainedZero ? "No delivery observed; opportunity evidence is needed before judging the workflow."
        : missedBar ? "The agreed native review bar was missed; inspect the evidence."
          : "Direction-aware comparison of comparable periods at arithmetic precision; descriptive, not statistical or causal.",
    opportunities: opportunities ?? null };
}

function ticks(start, end) {
  const result = [];
  const date = new Date(start);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  while (date.getTime() <= end) {
    if (date.getTime() >= start) result.push({ at: date.toISOString(),
      label: date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" }) });
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return result;
}

export function timelinePulse(timeline) {
  const definition = timeline.valueFunction.definition;
  const policy = signalPolicy(definition);
  const review = reviewValue(timeline);
  const kind = definition.evidence.measurementKind;
  if (!["interval", "snapshot"].includes(kind)
    || definition.metrics.some(metric => !["increase", "decrease", "maintain", "target"].includes(metric.direction)
      || (["maintain", "target"].includes(metric.direction) && !finite(metric.target)))) {
    throw new Error("Invalid pulse metric: declare the measurement kind, direction and any required target");
  }
  const cadence = definition.evidence.window.cadenceDays * DAY;
  const metrics = definition.metrics.map(metric => {
    const basis = metric.id === policy.metricId ? policy.basis
      : metric.id === definition.review?.metricId ? definition.review.basis
      : metric.role === "primary" ? "repository-outcome" : "diagnostic";
    const latest = review.periods.at(-1);
    const previous = review.periods.findLast(period => period !== latest && (kind === "interval"
      ? time(period.window?.endAt) === time(latest?.window?.startAt)
      : time(latest?.window?.endAt) - time(period.window?.endAt) === cadence));
    const current = latest?.metrics[metric.id] ?? null;
    const prior = previous?.metrics[metric.id] ?? null;
    const postAdoption = basis !== "workflow-contribution" || (kind === "interval"
      && time(previous?.window?.startAt) >= time(definition.adoption.adoptedAt));
    const ready = !review.current.stale && latest?.status === "complete" && previous?.status === "complete"
      && finite(current) && finite(prior) && postAdoption;
    return {
      ...metric, basis, kind,
      signal: signal(metric, { current, previous: prior, ready, basis,
        opportunities: latest?.eligibleCount,
        missedBar: definition.review?.metricId === metric.id
          && ["goal-missed", "change-or-retire-candidate"].includes(review.decision.status),
        reason: "Need fresh complete mature comparable periods; missing evidence is not zero value." }),
      currentWindow: latest?.window ?? null,
      previousWindow: previous?.window ?? null,
      series: review.periods.map(period => ({ at: period.window?.endAt ?? period.observedAt,
        value: ["complete", "incomplete-evidence"].includes(period.status) ? period.metrics[metric.id] : null,
        status: period.status, observedAt: period.observedAt })),
      weekly: [], cumulative: [], events: [],
      notes: [
        "Snapshots and overlapping interval aggregates are never summed into lifetime delivery.",
        basis === "repository-outcome" ? "Repository movement is not this workflow's causal impact."
          : basis === "workflow-contribution" ? "Shared workflow-enabled contribution, not exclusive authorship."
            : "Diagnostic movement is not a workflow keep/retire recommendation.",
      ],
    };
  });
  for (const metric of metrics) metric.reader = readerSummary(metric);
  return { schemaVersion: 1, repository: timeline.repository, workflowSlug: definition.slug,
    workflowName: definition.workflowName, sourcePath: definition.sourcePath,
    intent: definition.intent ?? null,
    valueFunctionSha256: timeline.valueFunction.sha256 ?? null,
    window: timeline.window, ticks: ticks(time(timeline.window.startAt), time(timeline.window.endAt)),
    selectedMetricId: policy.metricId, signal: headline(metrics.find(metric => metric.id === policy.metricId)),
    metrics, decision: review.decision,
    cost: review.cost, limitation: review.limitation };
}

function reportContext(ledger) {
  const checks = ledger.checks ?? [];
  if (!Array.isArray(checks) || checks.some(check => !check || !check.name || !check.detail
    || typeof check.name !== "string" || typeof check.detail !== "string"
    || !["verified", "not-verified"].includes(check.status))) {
    throw new Error("Invalid report checks: verification must be explicit");
  }
  const state = ledger.repositoryState;
  if (state !== undefined) {
    if (!state || !state.metric || ["id", "name", "unit", "version", "formula"].some(key =>
      typeof state.metric[key] !== "string" || !state.metric[key])
      || !["increase", "decrease"].includes(state.metric.direction)
      || typeof state.limitation !== "string" || !state.limitation
      || !Array.isArray(state.observations) || !state.observations.length) {
      throw new Error("Invalid repository-state report context");
    }
    let previous = -Infinity;
    for (const row of state.observations) {
      const url = typeof row?.url === "string" && URL.canParse(row.url) ? new URL(row.url) : null;
      if (!row || !finite(time(row.at)) || time(row.at) <= previous
        || time(row.at) < time(ledger.window.startAt) || time(row.at) > time(ledger.window.endAt)
        || time(row.at) > time(ledger.observedAt)
        || !finite(row.value) || typeof row.ref !== "string" || !row.ref
        || !url || url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Invalid repository-state observation or immutable evidence reference");
      }
      previous = time(row.at);
    }
  }
  return { checks, repositoryState: state ?? null };
}

function validateLedger(ledger) {
  const metric = ledger.metric;
  const start = time(ledger.window?.startAt);
  const end = time(ledger.window?.endAt);
  if (ledger.schemaVersion !== 1 || ledger.kind !== "operational-value-events"
    || !isRepository(ledger.repository) || !isSlug(ledger.workflowSlug)
    || typeof ledger.workflowName !== "string" || !ledger.workflowName
    || typeof ledger.sourcePath !== "string" || !ledger.sourcePath
    || !finite(start) || !finite(end) || start >= end || !finite(time(ledger.observedAt))
    || !finite(ledger.cadenceDays) || ledger.cadenceDays <= 0
    || (ledger.maturationDays !== undefined
      && (!Number.isSafeInteger(ledger.maturationDays) || ledger.maturationDays < 0))
    || !metric || ["id", "name", "unit", "version", "formula"].some(key => typeof metric[key] !== "string" || !metric[key])
    || !ledger.intent || ["goal", "acceptance"].some(key =>
      typeof ledger.intent[key] !== "string" || !ledger.intent[key])
    || !["increase", "decrease"].includes(metric.direction)
    || !["repository-outcome", "workflow-contribution"].includes(ledger.basis)
    || !Array.isArray(ledger.events) || !Array.isArray(ledger.coverage) || !ledger.coverage.length
    || !Array.isArray(ledger.limitations) || ledger.limitations.some(item => typeof item !== "string")
    || !(ledger.opportunities == null || (Number.isSafeInteger(ledger.opportunities) && ledger.opportunities >= 0))) {
    throw new Error("Invalid operational-value event ledger: explicit metric/version, windows, coverage and provenance are required");
  }
  let previousEnd = start;
  for (const interval of ledger.coverage) {
    const left = time(interval.startAt), right = time(interval.endAt);
    if (!finite(left) || !finite(right) || left < previousEnd || right <= left || left < start || right > end
      || (interval.status === "complete" && right > time(ledger.observedAt))
      || !["complete", "partial", "missing", "unknown"].includes(interval.status)) {
      throw new Error("Invalid or overlapping event-coverage intervals");
    }
    previousEnd = right;
  }
  const unique = new Map();
  for (const event of ledger.events) {
    const observed = time(event.observedAt ?? ledger.observedAt);
    if (typeof event.id !== "string" || !event.id || !finite(event.value)
      || !finite(time(event.at)) || time(event.at) < start || time(event.at) >= end
      || !finite(observed) || observed < time(event.at) || observed > time(ledger.observedAt)
      || event.acceptance?.state !== "accepted"
      || time(event.acceptance.at) !== time(event.at)
      || typeof event.acceptance.ref !== "string" || !event.acceptance.ref
      || observed < time(event.at) + (ledger.maturationDays ?? 0) * DAY
      || (event.lineage !== undefined && (!Array.isArray(event.lineage) || event.lineage.some(edge =>
        typeof edge.outputId !== "string" || !edge.outputId || edge.implementationId !== event.id
        || !["connected", "referenced-by", "closed-by"].includes(edge.relation)
        || !finite(time(edge.at)) || time(edge.at) > observed
        || (edge.relation === "closed-by" ? time(edge.at) < time(event.at) : time(edge.at) > time(event.at)))))
      || (event.unit !== undefined && event.unit !== metric.unit)
      || (event.metricId !== undefined && event.metricId !== metric.id)
      || (event.metricVersion !== undefined && event.metricVersion !== metric.version)
      || !["receipt-verified", "corroborated", "not-applicable"].includes(event.attribution)
      || (ledger.basis === "workflow-contribution" && event.attribution === "not-applicable")
      || typeof event.label !== "string" || typeof event.detail !== "string"
      || (event.title !== undefined && (typeof event.title !== "string" || !event.title))
      || (event.summary !== undefined && (typeof event.summary !== "string" || !event.summary))
      || !Array.isArray(event.evidence) || !event.evidence.length
      || event.evidence.some(ref => {
        try {
          const url = new URL(ref.url);
          return !ref.label || url.protocol !== "https:" || !!url.username || !!url.password;
        } catch { return true; }
      })) throw new Error(`Invalid event or incompatible metric boundary: ${event.id}`);
    const prior = unique.get(event.id);
    if (prior && (time(prior.at) !== time(event.at) || prior.value !== event.value
      || prior.acceptance.ref !== event.acceptance.ref)) {
      throw new Error(`Conflicting native facts for event: ${event.id}`);
    }
    if (prior && observed === time(prior.observedAt ?? ledger.observedAt)
      && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error(`Conflicting event observation: ${event.id}`);
    if (!prior || observed > time(prior.observedAt ?? ledger.observedAt)) unique.set(event.id, event);
  }
  return [...unique.values()].sort((left, right) => time(left.at) - time(right.at) || left.id.localeCompare(right.id));
}

export function eventPulse(ledger) {
  const events = validateLedger(ledger);
  const context = reportContext(ledger);
  const start = time(ledger.window.startAt), end = time(ledger.window.endAt);
  const complete = (left, right) => {
    if (left < start || right > end || left >= right) return false;
    let cursor = left;
    for (const interval of ledger.coverage) {
      if (time(interval.endAt) <= cursor) continue;
      if (time(interval.startAt) > cursor || interval.status !== "complete") return false;
      cursor = time(interval.endAt);
      if (cursor >= right) return true;
    }
    return false;
  };
  const times = events.map(event => time(event.at));
  const prefix = [0];
  for (const event of events) prefix.push(prefix.at(-1) + event.value);
  const index = at => {
    let left = 0, right = times.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (times[middle] < at) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  const total = (left, right) => prefix[index(right)] - prefix[index(left)];
  const rate = (at, days) => complete(at - days * DAY, at)
    ? total(at - days * DAY, at) * 7 / days : null;
  const shortDays = 28, baselineDays = 91;
  const current = rate(end, shortDays), previous = rate(end - shortDays * DAY, shortDays);
  const fresh = end - time(ledger.observedAt) < ledger.cadenceDays * DAY;
  const series = [];
  for (let at = start; at < end; at = Math.min(end, at + DAY)) {
    series.push({ at: iso(at), value: rate(at, shortDays), baseline: rate(at, baselineDays) });
  }
  series.push({ at: iso(end), value: current, baseline: rate(end, baselineDays) });
  const weekly = [];
  const firstMonday = new Date(start);
  firstMonday.setUTCHours(0, 0, 0, 0);
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (8 - firstMonday.getUTCDay()) % 7);
  if (firstMonday.getTime() <= start) firstMonday.setUTCDate(firstMonday.getUTCDate() + 7);
  for (let left = start, right = Math.min(end, firstMonday.getTime()); left < end;
    left = right, right = Math.min(end, right + WEEK)) {
    weekly.push({ startAt: iso(left), endAt: iso(right), partial: right - left !== WEEK,
      value: complete(left, right) ? total(left, right) : null,
      rate: complete(left, right) ? total(left, right) * WEEK / (right - left) : null });
  }
  let sum = 0, receipt = 0;
  const cumulative = [{ at: iso(start), value: 0, receipt: 0 }];
  for (const event of events) {
    sum += event.value;
    if (event.attribution === "receipt-verified") receipt += event.value;
    const known = complete(start, time(event.at) + 1);
    cumulative.push({ at: event.at, value: known ? sum : null, receipt: known ? receipt : null });
  }
  cumulative.push({ at: iso(end), value: complete(start, end) ? sum : null,
    receipt: complete(start, end) ? receipt : null });
  const latestPositive = events.findLast(event => gain(ledger.metric, 0, event.value) > 0);
  const metric = { ...ledger.metric, kind: "events", basis: ledger.basis,
    signal: signal(ledger.metric, { current, previous, basis: ledger.basis,
      ready: fresh && finite(current) && finite(previous), opportunities: ledger.opportunities,
      reason: fresh ? "Need two complete non-overlapping 28-day windows; coverage gaps and cold starts are unknown."
        : "Evidence is stale relative to the report endpoint." }),
    currentWindow: { startAt: iso(end - shortDays * DAY), endAt: iso(end) },
    previousWindow: { startAt: iso(end - 2 * shortDays * DAY), endAt: iso(end - shortDays * DAY) },
    series, weekly, cumulative, events, shortDays, baselineDays,
    currentTotal: finite(current) ? total(end - shortDays * DAY, end) : null,
    previousTotal: finite(previous) ? total(end - 2 * shortDays * DAY, end - shortDays * DAY) : null,
    observedTotal: sum, completeTotal: complete(start, end) ? sum : null,
    receiptTotal: receipt, baselineRate: rate(end, baselineDays),
    lastPositiveAt: latestPositive?.at ?? null,
    daysSincePositive: latestPositive ? (end - time(latestPositive.at)) / DAY : null,
    notes: [
      ...ledger.limitations,
      "Cumulative historical delivery is not surviving repository health or exclusive causal credit.",
      "Recent movement compares adjacent 28-day rates; the overlapping 91-day curve is context, not a pre-adoption baseline.",
      "Partial calendar weeks use their actual exposure; gaps are not zero. No significance or keep threshold is invented.",
    ] };
  metric.reader = readerSummary(metric);
  return { schemaVersion: 1, repository: ledger.repository, workflowSlug: ledger.workflowSlug,
    workflowName: ledger.workflowName, sourcePath: ledger.sourcePath, observedAt: ledger.observedAt,
    intent: ledger.intent, provenance: ledger.provenance ?? [], ...context,
    valueFunctionSha256: ledger.valueFunctionSha256 ?? null,
    window: ledger.window, ticks: ticks(start, end), selectedMetricId: metric.id,
    signal: headline(metric), metrics: [metric],
    decision: { status: "not-rated", reason: "No agreed native keep/retire bar." },
    cost: { status: "not-measured", total: null, unit: null },
    limitation: "Attention requests human inspection, never automatic retirement or broader workflow authority." };
}
