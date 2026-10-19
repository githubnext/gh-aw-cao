import { escapeXml } from "../.github/skills/add-operational-value/scripts/common.mjs";

const signals = {
  worsening: ["Worsening", "bad", 0], stalled: ["Stalled", "bad", 1],
  stale: ["Stale report", "warning", 2], improving: ["Improving", "good", 3],
  steady: ["Steady", "neutral", 4], "no-opportunity": ["No opportunity", "neutral", 5],
  "insufficient-evidence": ["Insufficient evidence", "warning", 6],
  "not-evaluated": ["Not evaluated", "muted", 7],
};
const stages = {
  measured: ["Native evaluated", 0],
  "evidence-unavailable": ["Evidence unavailable", 2],
  "evaluation-in-progress": ["In progress", 3],
  "instrumentation-needed": ["Needs instrument", 4],
  "outcome-contract-needed": ["Needs contract", 5],
  "intent-review-needed": ["Source review", 6],
};
const finite = value => typeof value === "number" && Number.isFinite(value);
const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const date = value => value?.slice(0, 10) ?? "Not available";
const text = value => escapeXml(String(value));

export function portfolioTableModel(workflows) {
  const rows = workflows.map((workflow, index) => {
    const measurement = workflow.measurement;
    const model = measurement.model;
    const metric = model?.metrics.find(row => row.id === model.selectedMetricId);
    const points = metric?.kind === "events" ? metric.weekly.map(point => ({
      at: point.endAt, value: point.value,
    })) : (metric?.series ?? []).map(point => ({ at: point.at, value: point.value }));
    const current = metric?.signal.current ?? null;
    if (metric?.kind !== "events" && finite(current) && points.length) {
      points[points.length - 1] = { ...points.at(-1), value: current };
    }
    const known = points.filter(point => finite(point.value));
    const latest = known.at(-1);
    const stale = measurement.fresh === false;
    const signal = !model ? "not-evaluated" : stale ? "stale" : measurement.signal.status;
    if (!signals[signal] || !stages[measurement.status]) throw new Error("Unknown portfolio presentation status");
    const review = measurement.attention === "review" && !stale;
    const [signalLabel, tone, signalRank] = signals[signal];
    const progress = measurement.progress;
    const stage = model ? "Native evaluated" : progress?.reportAvailable ? "Gap report"
      : progress?.functionReady ? "Function only" : stages[measurement.status][0];
    const coverageRank = model ? 0 : progress?.reportAvailable ? 1 : stages[measurement.status][1];
    const freshness = !model ? "not-evaluated" : stale ? "stale"
      : !finite(current) ? latest ? "historical" : "unknown" : "current";
    const freshnessLabels = {
      current: "Current report", stale: "Stale report", historical: "Historical value only",
      unknown: "Latest value unknown", "not-evaluated": "Not evaluated",
    };
    return { index, id: workflow.id, signal, signalLabel, tone, review,
      signalRank: review ? -1 : signalRank, stage, coverageRank,
      known: known.length, total: points.length, ratio: points.length ? known.length / points.length : 0,
      limited: progress?.partial === true, freshness, freshnessLabel: freshnessLabels[freshness],
      cutoff: model?.window.endAt ?? null, lastKnownAt: latest?.at ?? null,
      current: finite(current) ? current : null, lastKnown: latest?.value ?? null,
      unit: metric?.kind === "events" ? `${metric.unit}/week` : metric?.unit ?? null,
      lastKnownUnit: metric?.unit ?? null, basis: measurement.signal?.basis ?? null,
      reason: measurement.signal?.reason ?? measurement.limitation,
      hasReport: Boolean(model || progress?.reportAvailable),
    };
  });
  const ordered = compare => [...rows].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id, "en"))
    .map(row => row.index);
  const orders = {
    workflow: ordered(() => 0),
    signal: ordered((a, b) => a.signalRank - b.signalRank),
    coverage: ordered((a, b) => a.coverageRank - b.coverageRank || b.ratio - a.ratio),
    freshness: ordered((a, b) => ["stale", "historical", "unknown", "current", "not-evaluated"].indexOf(a.freshness)
      - ["stale", "historical", "unknown", "current", "not-evaluated"].indexOf(b.freshness)),
  };
  const group = (id, label, predicate) => ({ id, label, rows: rows.filter(predicate).map(row => row.index) });
  const groups = [
    group("all", "All workflows", () => true),
    group("review", "Needs review", row => row.review),
    ...Object.entries(signals).map(([id, [label]]) => group(id, label, row => row.signal === id)),
    group("native", "Has native evaluation", row => row.coverageRank === 0),
    group("limited", "Explicitly limited native scope", row => row.limited),
    group("gaps", "Has evidence-gap report", row => row.stage === "Gap report"),
    group("historical", "Historical native value only", row => row.freshness === "historical"),
  ];
  return { rows, orders, groups };
}

export function mountPortfolioTable(document) {
  const root = document.querySelector("[data-portfolio]");
  const plan = JSON.parse(root.querySelector("[data-table-plan]").textContent);
  const body = root.querySelector("tbody");
  const rows = Array.from(body.rows);
  const sort = root.querySelector("[name=sort]");
  const show = root.querySelector("[name=show]");
  const status = root.querySelector("[role=status]");
  const empty = root.querySelector("[data-empty]");
  const headers = root.querySelectorAll("th[data-sort]");
  let direction = "ascending";
  const update = () => {
    const selected = plan.groups[show.value];
    const visible = new Set(selected);
    const order = direction === "ascending" ? plan.orders[sort.value] : plan.orders[sort.value].toReversed();
    for (const index of order) {
      rows[index].hidden = !visible.has(index);
      body.append(rows[index]);
    }
    for (const header of headers) {
      header.setAttribute("aria-sort", header.dataset.sort === sort.value ? direction : "none");
      const button = header.querySelector("button");
      button.textContent = `${button.dataset.label}${header.dataset.sort === sort.value ? direction === "ascending" ? " ↑" : " ↓" : " ↕"}`;
    }
    status.textContent = `${selected.length} of ${rows.length} workflows shown`;
    empty.hidden = selected.length !== 0;
  };
  sort.addEventListener("change", () => { direction = "ascending"; update(); });
  show.addEventListener("change", update);
  for (const header of headers) header.querySelector("button").addEventListener("click", () => {
    direction = sort.value === header.dataset.sort && direction === "ascending" ? "descending" : "ascending";
    sort.value = header.dataset.sort;
    update();
  });
  update();
}

export function renderPortfolioTable(workflows, links) {
  const model = portfolioTableModel(workflows);
  const badge = (label, tone) => `<span class="badge ${tone}">${text(label)}</span>`;
  const rows = model.rows.map(row => `<tr>
<th scope="row"><a href="${text(links.get(row.id))}">${text(row.id)}</a>${row.hasReport
    ? `<small><a href="${text(row.id)}-pulse.html">Evidence &amp; plot</a></small>` : ""}</th>
<td>${badge(row.signalLabel, row.tone)}${row.review ? badge("Review", "bad") : ""}
<small>${text(row.basis?.replaceAll("-", " ") ?? "No measured signal")}</small></td>
<td>${badge(row.stage, row.coverageRank === 0 ? "neutral" : "muted")}${row.limited ? "<small>Limited scope; open history</small>" : ""}
${row.total ? `<small>${row.known} / ${row.total} periods with values</small><meter min="0" max="${row.total}" value="${row.known}" aria-label="${row.known} of ${row.total} periods have native values"></meter>` : ""}</td>
<td>${row.current !== null ? `${row.freshness === "stale" ? "Historical: " : ""}<strong>${text(number(row.current))}</strong><small>${text(row.unit)}</small>`
    : `<span class="muted">Latest unknown</span>${row.lastKnown !== null ? `<small>Last known: ${text(number(row.lastKnown))} ${text(row.lastKnownUnit)}</small>` : ""}`}</td>
<td>${badge(row.freshnessLabel, row.freshness === "current" ? "neutral" : "muted")}
${row.cutoff ? `<small>Report: <time datetime="${text(row.cutoff)}">${date(row.cutoff)}</time></small>` : ""}
${row.lastKnownAt ? `<small>Native value: ${date(row.lastKnownAt)}</small>` : ""}</td></tr>`).join("\n");
  const plan = { orders: model.orders, groups: Object.fromEntries(model.groups.map(group => [group.id, group.rows])) };
  const evaluated = model.rows.filter(row => row.coverageRank === 0).length;
  const percentage = workflows.length ? (100 * evaluated / workflows.length).toFixed(1) : "0.0";
  return `<section data-portfolio aria-label="Workflow coverage">
<div class="report-stats"><div><strong>${percentage}%</strong><span>Native evaluated</span>
<small>${evaluated} / ${workflows.length} workflows; ${workflows.length - evaluated} remaining</small>
<progress max="${workflows.length || 1}" value="${evaluated}" aria-label="Native evaluation coverage">${percentage}%</progress></div>${[
    ["Needs review", model.rows.filter(row => row.review).length],
    ["Improving", model.rows.filter(row => row.signal === "improving").length],
    ["Stale reports", model.rows.filter(row => row.freshness === "stale").length],
  ].map(([label, count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join("")}</div>
<div class="table-controls"><label>Show <select name="show">${model.groups.map(group =>
    `<option value="${group.id}">${group.label} (${group.rows.length})</option>`).join("")}</select></label>
<label>Sort <select name="sort"><option value="signal">Signal: attention first</option><option value="coverage">Coverage: most evaluated first</option>
<option value="freshness">Freshness: stale first</option><option value="workflow">Workflow: A–Z</option></select></label>
<span role="status" aria-live="polite">${workflows.length} workflows</span></div>
<p class="table-legend">Improving / worsening describes comparable native movement, not a keep/retire verdict.
Zero is not automatically bad. Unknown is not failure. Period counts show available native values, not full-goal acceptance.
Freshness is relative to this report's frozen cutoff, not today's date.</p>
<div class="coverage-scroll" tabindex="0" role="region" aria-label="Sortable workflow coverage">
<table class="coverage-table"><caption>Workflow signals and evaluation coverage. Select a column heading to reverse its order.</caption>
<thead><tr>${[["workflow", "Workflow"], ["signal", "Signal"], ["coverage", "Evaluation coverage"]].map(([id, label]) =>
    `<th scope="col" data-sort="${id}" aria-sort="none"><button type="button" data-label="${label}">${label} ↕</button></th>`).join("")}
<th scope="col">Native value</th><th scope="col" data-sort="freshness" aria-sort="none"><button type="button" data-label="Evidence freshness">Evidence freshness ↕</button></th>
</tr></thead><tbody>${rows}</tbody></table></div>
<p data-empty hidden>No workflows match this status in the frozen inventory.</p>
<noscript>All workflows are shown. Sorting and status selection require JavaScript; evidence links work without it.</noscript>
<script type="application/json" data-table-plan>${JSON.stringify(plan).replaceAll("<", "\\u003c")}</script>
<script>(${mountPortfolioTable.toString()})(document);</script></section>`;
}
