export function mountPulse(document, model) {
  const node = (tag, text, parent, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    parent.append(element);
    return element;
  };
  const svgNode = (tag, attributes, parent, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text != null) element.textContent = text;
    parent.append(element);
    return element;
  };
  const format = value => value == null ? "Unknown" : new Intl.NumberFormat("en-US",
    { maximumFractionDigits: 2 }).format(value);
  const date = value => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC",
    year: "numeric", month: "short", day: "numeric" });
  const disclosure = (title, parent, className) => {
    const details = node("details", null, parent, className);
    node("summary", title, details);
    return details;
  };
  const link = (ref, parent) => {
    const element = node("a", ref.label, parent);
    element.href = ref.url;
    element.target = "_blank";
    element.rel = "noopener noreferrer";
    return element;
  };
  const reveal = id => {
    let target = document.getElementById(id);
    if (!target) {
      const metricId = observationMetrics.get(id);
      if (metricId) {
        select.value = metricId;
        draw();
        target = document.getElementById(id);
      }
    }
    if (!target) return;
    for (let ancestor = target; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DETAILS") ancestor.open = true;
    }
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  };
  const internalLink = (element, id) => {
    element.setAttribute("href", `#${id}`);
    element.addEventListener("click", event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (document.defaultView.location.hash !== `#${id}`) document.defaultView.history.pushState(null, "", `#${id}`);
      reveal(id);
    });
    return element;
  };
  const icons = [
    "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z",
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
    "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  ];
  const main = document.querySelector("main");
  const identity = node("p", null, main, "eyebrow");
  const repositoryUrl = `https://github.com/${model.repository}`;
  const workflowUrl = `${repositoryUrl}/blob/HEAD/${model.sourcePath.split("/").map(encodeURIComponent).join("/")}`;
  link({ label: model.repository, url: repositoryUrl }, identity);
  node("span", "/", identity);
  link({ label: `${model.workflowSlug} source (current)`, url: workflowUrl }, identity);
  node("h1", model.workflowName, main);
  if (typeof model.intent?.goal === "string" && model.intent.goal) {
    node("p", `Goal: ${model.intent.goal}`, main, "goal");
  } else node("p", "Goal not recorded in this report. Inspect the workflow Markdown before judging its purpose.", main, "notice");
  node("p", `As of ${date(model.window.endAt)}${model.observedAt ? `; evidence captured ${date(model.observedAt)}` : ""}. Saved report, not live.`, main, "muted");
  const label = node("label", "Explore a measure ", main, "metric-picker");
  label.hidden = model.metrics.length === 1;
  const select = node("select", null, label);
  select.setAttribute("aria-label", "Native measure");
  for (const metric of model.metrics) {
    const option = node("option", metric.name, select);
    option.value = metric.id;
  }
  select.value = model.selectedMetricId;
  const observationMetrics = new Map();
  for (const metric of model.metrics) {
    if (metric.kind === "events") continue;
    observationMetrics.set(`observations-${metric.id}`, metric.id);
    metric.series.forEach((_, index) => observationMetrics.set(`observation-${metric.id}-${index}`, metric.id));
  }
  const content = node("section", null, main);
  const draw = () => {
    content.replaceChildren();
    const metric = model.metrics.find(item => item.id === select.value);
    const events = metric.kind === "events";
    const status = metric.signal;
    const contribution = metric.basis === "workflow-contribution";
    const heading = node("div", null, content, `signal ${status.attention}`);
    node("h2", metric.reader.title, heading);
    const facts = node("dl", null, content, "facts");
    const fact = (name, value, unit, detail, destination) => {
      const row = node("div", null, facts);
      const label = node("dt", null, row);
      const icon = svgNode("svg", { viewBox: "0 0 16 16", class: "fact-icon",
        "aria-hidden": "true", focusable: "false" }, label);
      svgNode("path", { d: icons[facts.children.length - 1] }, icon);
      node("span", name, label);
      const description = node("dd", null, row);
      const amount = node("strong", destination ? null : value, description);
      if (destination) {
        const anchor = internalLink(node("a", value, amount), destination);
        anchor.setAttribute("aria-label", `${name}: ${value}${unit ? ` ${unit}` : ""}. Explore evidence.`);
      }
      if (unit) node("span", ` ${unit}`, description, "fact-unit");
      node("span", detail, description, "fact-detail muted");
    };
    const state = model.repositoryState;
    const firstState = state?.observations[0], lastState = state?.observations.at(-1);
    const primary = model.metrics.find(item => item.basis === "repository-outcome");
    fact(events ? `Last ${metric.shortDays} days` : "Recent change", events
      ? format(metric.currentTotal) : format(status.directionAwareGain), metric.unit,
    events ? `${format(metric.previousTotal)} in the previous ${metric.shortDays} days; net measured change.`
      : "Direction-aware change; unknown is not zero.", events ? "recent-results" : "measurement-rules");
    fact(events ? contribution ? "Linked contribution" : "Measured outcomes" : "Latest measure", events
      ? format(metric.completeTotal ?? metric.observedTotal) : format(status.current), metric.unit,
    events ? `${metric.completeTotal == null ? "Known subtotal only; coverage is incomplete. " : ""}${metric.name} since ${date(model.window.startAt)}; not the number remaining today.`
      : `${metric.name}. ${status.status === "insufficient-evidence" ? "Recent comparison is not verified." : ""}`,
    events ? "accepted-results" : `observations-${metric.id}`);
    fact("Repository state", state
      ? format(lastState.value) : primary ? format(primary.signal.current) : "Not measured here",
    state?.metric.unit ?? primary?.unit ?? null,
    state ? `${state.metric.name} on ${date(lastState.at)}; ${format(firstState.value)} at the first snapshot. ${state.metric.direction === "decrease" ? "Lower" : "Higher"} is better. Includes everyone's work.`
      : primary ? `${primary.name}. Includes everyone's work.` : "Linked contribution does not establish overall repository health.",
    state ? `snapshot-${state.observations.length - 1}` : primary ? `observations-${primary.id}` : null);
    const unknownChecks = model.checks?.filter(check => check.status !== "verified") ?? [];
    node("p", unknownChecks.length
      ? `Not verified: ${unknownChecks.map(check => check.name).join("; ")}.`
      : model.checks?.length ? "Only the named checks are verified; see the evidence for their scope."
        : "Whole-goal acceptance is not verified here.", content, "notice");
    if (status.status === "insufficient-evidence") node("p", status.reason, content, "notice");
    const evidence = disclosure("Explore evidence", content, "evidence");
    node("span", "Linked changes, checks and measurement rules", evidence.querySelector("summary"), "disclosure-hint");
    node("p", metric.reader.caution, evidence, "muted");
    const eventPositions = new Map(metric.events.map((event, index) => [event.id, index]));
    const eventLinks = (ids, parent) => {
      const list = node("ul", null, parent);
      for (const id of ids) {
        const index = eventPositions.get(id);
        const event = metric.events[index];
        internalLink(node("a", `${date(event.at)}: ${event.title ?? event.label} (${format(event.value)} ${metric.unit})`,
          node("li", null, list)), `result-${index}`);
      }
    };
    if (events) {
      const recent = disclosure("Recent results", evidence);
      recent.id = "recent-results";
      for (const [name, window, total, ids] of [
        ["Latest period", metric.currentWindow, metric.currentTotal, metric.currentEventIds],
        ["Previous period", metric.previousWindow, metric.previousTotal, metric.previousEventIds],
      ]) {
        const period = node("section", null, recent);
        period.dataset.period = name === "Latest period" ? "current" : "previous";
        node("h3", name, period);
        node("p", `${window.startAt} to ${window.endAt} (UTC, end exclusive).`, period, "muted");
        node("p", total == null ? "Coverage is incomplete. These retained events do not establish a complete total."
          : `Net measured change: ${format(total)} ${metric.unit}.`, period);
        eventLinks(ids, period);
        if (!ids.length) node("p", "No accepted implementation events retained in this period. This does not establish an absence of workflow activity.", period);
      }
      const accepted = disclosure("Accepted implementations", evidence);
      accepted.id = "accepted-results";
      const list = node("ul", null, accepted, "result-list");
      metric.events.forEach((event, index) => {
        const result = disclosure(`${date(event.at)}: ${event.title ?? event.label} (${format(event.value)} ${metric.unit})`,
          node("li", null, list));
        result.id = `result-${index}`;
        node("p", event.summary ?? event.detail, result);
        node("p", `Acceptance: ${event.acceptance.at}. Attribution: ${event.attribution}.`, result, "muted");
        const sources = node("p", null, result, "evidence-links");
        for (const ref of event.evidence) link(ref, sources);
      });
      if (!metric.events.length) node("p", "No accepted implementation events retained; inspect coverage before interpreting zero.", accepted);
    }
    if (events) node("p", metric.daysSincePositive == null
      ? "No positive contribution observed; this is not proof that none occurred."
      : `Last positive contribution: ${date(metric.lastPositiveAt)}, about ${Math.round(metric.daysSincePositive)} days before this report's cutoff.`, evidence);
    node("h2", "What to investigate", evidence);
    node("p", metric.reader.next, evidence);
    node("h2", "Goal checks", evidence);
    if (model.checks?.length) {
      const checks = node("ul", null, evidence, "checks");
      for (const check of model.checks) {
        const item = node("li", null, checks);
        node("strong", `${check.status === "verified" ? "Verified" : "Not verified"}: ${check.name}. `, item);
        node("span", check.detail, item);
      }
    } else node("p", "Not verified here. This report does not establish that every acceptance requirement passed.", evidence);
    node("p", status.status === "no-opportunity"
      ? "No eligible work was observed; that does not establish workflow failure."
      : "The reason for a quiet or weaker period is unknown from these measurements alone.", evidence, "muted");
    const start = Date.parse(model.window.startAt), end = Date.parse(model.window.endAt);
    const x = at => 66 + (Date.parse(at) - start) / (end - start) * 990;
    const chart = (title, caption, values, height = 235, parent = content, chartTicks = model.ticks, width = 1100) => {
      node("h2", title, parent);
      node("p", caption, parent, "muted");
      const wrap = node("div", null, parent, "chart");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", title);
      const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height + 45}`, role: "group", "aria-label": title }, wrap);
      svgNode("title", {}, svg, title);
      const position = at => 66 + (Date.parse(at) - start) / (end - start) * (width - 110);
      const { low, high } = values.reduce((range, value) => value == null ? range
        : { low: Math.min(range.low, value), high: Math.max(range.high, value) }, { low: 0, high: 1 });
      const y = value => 16 + (high - value) / (high - low) * (height - 38);
      for (let i = 0; i <= 4; i++) {
        const native = low + (high - low) * i / 4;
        const value = width < 1100 && Number.isInteger(low) && Number.isInteger(high) && high - low >= 4
          ? Math.round(native) : native;
        svgNode("line", { x1: 66, x2: width - 44, y1: y(value), y2: y(value), class: "grid" }, svg);
        svgNode("text", { x: 58, y: y(value) + 4, "text-anchor": "end", class: "axis" }, svg, format(value));
      }
      for (const tick of chartTicks) {
        svgNode("line", { x1: position(tick.at), x2: position(tick.at), y1: 16, y2: height - 22, class: "grid" }, svg);
        svgNode("text", { x: position(tick.at), y: height + 4,
          "text-anchor": width < 1100 && tick === chartTicks.at(-1) ? "end" : "middle", class: "axis" }, svg, tick.label);
      }
      return { svg, y, height, x: position };
    };
    if (state) {
      const panel = document.createElement("section");
      panel.className = "snapshot-chart";
      content.insertBefore(panel, evidence);
      const plot = chart(state.metric.name, "Select a point to inspect its measured items. Changes between snapshots are unknown.",
        state.observations.map(row => row.value), 190, panel,
        [{ at: firstState.at, label: date(firstState.at) }, { at: lastState.at, label: date(lastState.at) }], 500);
      for (const [index, row] of state.observations.entries()) {
        const source = internalLink(svgNode("a", {
          "aria-label": `${date(row.at)}: ${format(row.value)} ${state.metric.unit}. Inspect measured items.`,
          "data-snapshot": row.ref }, plot.svg), `snapshot-${index}`);
        svgNode("title", {}, source, `${date(row.at)}: ${format(row.value)} ${state.metric.unit}. Inspect measured items.`);
        svgNode("circle", { cx: plot.x(row.at), cy: plot.y(row.value), r: 5,
          class: row === lastState ? "point latest" : "point" }, source);
        if (row === firstState || row === lastState) svgNode("text", {
          x: plot.x(row.at) + (row === lastState ? -12 : 12),
          y: Math.max(30, plot.y(row.value) - 12),
          "text-anchor": row === lastState ? "end" : "start", class: "snapshot-value",
        }, source, format(row.value));
      }
      const snapshots = disclosure("Inspect the repository snapshots", evidence);
      snapshots.id = "repository-snapshots";
      const list = node("ul", null, snapshots, "snapshot-list");
      for (const [index, row] of state.observations.entries()) {
        const item = disclosure(`${date(row.at)}: ${format(row.value)} ${state.metric.unit}`, node("li", null, list));
        item.id = `snapshot-${index}`;
        if (row.items !== undefined) {
          const sources = node("ul", null, item, "snapshot-items");
          for (const ref of row.items) link(ref, node("li", null, sources));
          if (!row.items.length) node("p", "The retained item list is empty.", item);
        } else node("p", "Item-level evidence was not retained for this snapshot. The revision alone does not identify the measured items.", item, "notice");
        link({ label: "Full repository at this revision (context)", url: row.url }, node("p", null, item, "muted"));
      }
    }
    const history = disclosure("Measurements over time", evidence, "history");
    node("p", "Scroll detailed charts horizontally on smaller screens.", history, "muted mobile-help");
    const path = (points, field, plot, className, step = false) => {
      let d = "", connected = false;
      for (const point of points) {
        if (point[field] == null) { connected = false; continue; }
        d += !connected ? `M${x(point.at)},${plot.y(point[field])}`
          : step ? `H${x(point.at)}V${plot.y(point[field])}` : `L${x(point.at)},${plot.y(point[field])}`;
        connected = true;
      }
      if (!d) return;
      const source = internalLink(svgNode("a", {
        "aria-label": step ? "Inspect accepted implementations" : "Inspect the measurement rules and comparison periods",
      }, plot.svg), step ? "accepted-results" : "measurement-rules");
      svgNode("path", { d, class: className }, source);
    };
    const top = chart(events ? `${metric.basis === "workflow-contribution" ? "Delivery" : "Outcome"} pulse (${metric.unit}/week)` : `${metric.name} (${metric.unit})`,
      events ? "Calendar-week bars; solid: trailing 28 days; dashed: trailing 91 days. Faded bars are partial weeks. Blank rates mean insufficient coverage."
        : "Native observations, not cumulative delivery. Gaps remain unknown; overlapping intervals are not added.",
      [...metric.series.flatMap(point => [point.value, point.baseline]), ...metric.weekly.map(point => point.rate)], 235, history);
    for (const [index, bucket] of metric.weekly.entries()) {
      if (bucket.rate == null) continue;
      const source = internalLink(svgNode("a", {
        "aria-label": `${date(bucket.startAt)} to ${date(bucket.endAt)}: ${format(bucket.value)} ${metric.unit}. Inspect this week's evidence.`,
      }, top.svg), `week-${index}`);
      const bar = svgNode("rect", { x: x(bucket.startAt) + 1, width: Math.max(1, x(bucket.endAt) - x(bucket.startAt) - 2),
        y: Math.min(top.y(0), top.y(bucket.rate)), height: Math.max(1, Math.abs(top.y(0) - top.y(bucket.rate))),
        class: bucket.partial ? "bar partial" : "bar" }, source);
      svgNode("title", {}, bar,
        `${date(bucket.startAt)} - ${date(bucket.endAt)}: ${format(bucket.value)} ${metric.unit}; ${format(bucket.rate)}/week${bucket.partial ? " (partial week, actual exposure)" : ""}`);
    }
    path(metric.series, "baseline", top, "baseline");
    path(metric.series, "value", top, "primary");
    if (!events) {
      const observations = disclosure("Retained observations", evidence);
      observations.id = `observations-${metric.id}`;
      const list = node("ul", null, observations);
      for (const [index, point] of metric.series.entries()) {
        const item = node("li", `${date(point.at)}: ${format(point.value)} ${metric.unit}; ${point.status}. Evidence observed ${point.observedAt}.`, list);
        item.id = `observation-${metric.id}-${index}`;
        if (point.value == null) continue;
        const source = internalLink(svgNode("a", {
          "aria-label": `${date(point.at)}: ${format(point.value)} ${metric.unit}. Inspect retained observation.`,
        }, top.svg), item.id);
        const circle = svgNode("circle", { cx: x(point.at), cy: top.y(point.value), r: 3, class: "point" }, source);
        svgNode("title", {}, circle, `${date(point.at)}: ${format(point.value)} ${metric.unit}; ${point.status}`);
      }
    }
    if (events) {
      const contribution = metric.basis === "workflow-contribution";
      const bottom = chart(`Cumulative ${contribution ? "historical delivery" : "observed outcome"} (${metric.unit})`,
        contribution
          ? `Solid: all demonstrated contribution. Dotted: receipt-backed subset (${format(metric.receiptTotal)}); corroborated: ${format(metric.observedTotal - metric.receiptTotal)}. Click or focus an event to inspect evidence.`
          : "Actor-independent native outcomes, not workflow credit. Click or focus an event to inspect evidence.",
        metric.cumulative.flatMap(point => [point.value, point.receipt]), 190, history);
      bottom.svg.setAttribute("role", "group");
      path(metric.cumulative, "value", bottom, "primary", true);
      if (contribution) path(metric.cumulative, "receipt", bottom, "receipt", true);
      const detail = node("aside", null, evidence, "event-detail");
      detail.setAttribute("aria-live", "polite");
      const show = event => {
        detail.replaceChildren();
        node("h3", event.title ?? event.label, detail);
        node("p", `${date(event.at)} - ${event.label}. Net measured change (${metric.unit}): ${format(event.value)}.`, detail);
        node("p", event.summary ?? "Inspect the linked output and accepted implementation to understand this measured result.", detail);
        const links = node("p", null, detail, "evidence-links");
        for (const ref of event.evidence) link(ref, links);
        const technical = disclosure("Inspect this result's technical evidence", detail);
        node("p", event.detail, technical);
        node("p", `Acceptance: ${event.acceptance.at}; reference ${event.acceptance.ref}.`, technical, "muted");
        node("p", event.attribution === "receipt-verified"
          ? "An applied safe-output receipt confirms creation of a linked output. This does not verify every quality requirement."
          : event.attribution === "corroborated"
            ? "Retained relationships support this contribution; an applied output-creation receipt is not established here."
            : "This is an actor-independent outcome, not workflow credit.", technical);
        for (const edge of event.lineage ?? []) {
          node("p", `Lineage: ${edge.outputId} ${edge.relation} ${edge.implementationId} at ${edge.at}.`, technical, "muted");
        }
      };
      metric.events.forEach((event, index) => {
        const mark = internalLink(svgNode("a", {
          "aria-label": `${event.label}: ${format(event.value)} ${metric.unit}, ${date(event.at)}`,
          "data-event": index }, bottom.svg), `result-${index}`);
        svgNode("circle", { cx: x(event.at), cy: bottom.height + 24,
          r: event.value === 0 ? 3 : 4,
          class: event.attribution === "receipt-verified" ? "event receipt-event" : "event",
        }, mark);
        svgNode("title", {}, mark, `${event.label}: ${format(event.value)} ${metric.unit}`);
        mark.addEventListener("click", () => show(event));
        mark.addEventListener("focus", () => show(event));
      });
      const latest = metric.events.at(-1);
      if (latest) show(latest);
      else node("p", "No delivery events observed; inspect coverage before interpreting zero.", detail);
      const weeks = disclosure("Weekly results", history);
      const list = node("ul", null, weeks);
      for (const [index, bucket] of metric.weekly.entries()) {
        const item = node("li", null, list);
        item.id = `week-${index}`;
        node("p", `${bucket.startAt} to ${bucket.endAt} (UTC, end exclusive): ${format(bucket.value)} ${metric.unit}; ${bucket.partial ? "partial calendar week" : "full calendar week"}.`, item);
        if (bucket.value == null) node("p", "Coverage is incomplete; unknown is not zero.", item, "muted");
        eventLinks(bucket.eventIds, item);
      }
    }
    evidence.append(history);
    const rules = disclosure("Measurement rules and evidence limits", evidence);
    rules.id = "measurement-rules";
    link({ label: `Workflow source (current): ${model.sourcePath}`, url: workflowUrl }, node("p", null, rules));
    node("p", "The current Markdown may have changed. This saved measurement uses its fixed rule and retained revisions, not the current source.", rules, "muted");
    if (typeof model.intent?.acceptance === "string" && model.intent.acceptance) node("p", `Acceptance: ${model.intent.acceptance}`, rules);
    node("p", `Measured movement: ${status.status.replaceAll("-", " ")}. Attention: ${status.attention.replaceAll("-", " ")}.`, rules);
    node("p", status.reason, rules);
    node("p", `Basis: ${metric.basis}. Better: ${metric.direction}${metric.target == null ? "" : ` toward ${metric.target}`}.`, rules);
    if (metric.formula) node("p", `Fixed rule (${metric.version}): ${metric.formula}`, rules);
    if (state) node("p", `Repository-state rule (${state.metric.version}): ${state.metric.formula}`, rules);
    if (state) node("p", state.limitation, rules);
    if (metric.currentWindow && metric.previousWindow) node("p",
      `Comparing ${date(metric.currentWindow.startAt)} - ${date(metric.currentWindow.endAt)} with ${date(metric.previousWindow.startAt)} - ${date(metric.previousWindow.endAt)} (UTC, end exclusive).`, rules);
    if (events) node("p", `Recent rate: ${format(status.current)} ${metric.unit}/week; previous ${format(status.previous)}. Overlapping ${metric.baselineDays}-day context: ${format(metric.baselineRate)} ${metric.unit}/week, not an independent comparison.`, rules);
    const notes = node("ul", null, rules);
    for (const note of metric.notes) node("li", note, notes);
    node("p", `Decision: ${model.decision.status}. Costs: ${model.cost.status}. ${model.limitation}`, rules, "muted");
    node("p", "Improving/worsening describes measured movement, not statistical significance. Attention means inspect, not disable. A saved report must be regenerated to monitor new work.", rules, "muted");
  };
  select.addEventListener("change", draw);
  draw();
  document.defaultView.addEventListener("hashchange", () => reveal(document.defaultView.location.hash.slice(1)));
  if (document.defaultView.location.hash) reveal(document.defaultView.location.hash.slice(1));
}
