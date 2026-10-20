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
  const main = document.querySelector("main");
  node("p", `${model.repository} / ${model.workflowSlug}`, main, "eyebrow");
  node("h1", model.workflowName, main);
  if (model.intent) {
    node("p", `Goal: ${model.intent.goal}`, main);
    node("p", `Acceptance: ${model.intent.acceptance}`, main, "muted");
  }
  node("p", `${date(model.window.startAt)} - ${date(model.window.endAt)}. Source: ${model.sourcePath}`, main, "muted");
  if (model.observedAt) node("p", `Evidence captured ${date(model.observedAt)}; this is a saved report, not a live monitor.`, main, "muted");
  const label = node("label", "Native measure ", main, "metric-picker");
  const select = node("select", null, label);
  select.setAttribute("aria-label", "Native measure");
  for (const metric of model.metrics) {
    const option = node("option", metric.name, select);
    option.value = metric.id;
  }
  select.value = model.selectedMetricId;
  const content = node("section", null, main);
  const draw = () => {
    content.replaceChildren();
    const metric = model.metrics.find(item => item.id === select.value);
    const events = metric.kind === "events";
    const status = metric.signal;
    const heading = node("div", null, content, `signal ${status.attention}`);
    node("strong", status.status.replaceAll("-", " "), heading);
    node("span", `Attention: ${status.attention.replaceAll("-", " ")}`, heading);
    node("p", status.reason, content);
    node("p", `Basis: ${metric.basis}. Better: ${metric.direction}${metric.target == null ? "" : ` toward ${metric.target}`}.`, content, "muted");
    if (metric.formula) node("p", `Fixed rule (${metric.version}): ${metric.formula}`, content, "muted");
    if (metric.currentWindow && metric.previousWindow) node("p",
      `Comparing ${date(metric.currentWindow.startAt)} - ${date(metric.currentWindow.endAt)} with ${date(metric.previousWindow.startAt)} - ${date(metric.previousWindow.endAt)} (UTC, end exclusive).`, content, "muted");
    const cards = node("div", null, content, "cards");
    const card = (name, value, detail) => {
      const element = node("div", null, cards, "card");
      node("span", name, element, "muted");
      node("strong", value, element);
      node("small", detail, element);
    };
    card(events ? metric.basis === "workflow-contribution" ? "Observed delivery" : "Observed outcome" : "Latest native value",
      format(events ? metric.completeTotal : status.current),
      `${metric.unit}${events && metric.completeTotal == null ? `; observed subtotal ${format(metric.observedTotal)}` : ""}`);
    card(events ? "Last 28 days" : "Current period", format(status.current),
      `${metric.unit}${events ? "/week" : ""}; previous ${format(status.previous)}`);
    card(events ? "91-day context" : "Direction-aware change",
      format(events ? metric.baselineRate : status.directionAwareGain),
      events ? `${metric.unit}/week; context, not an independent comparison` : `${metric.unit}; not a causal effect`);
    card(events ? "Since last positive delivery" : "Agreed decision",
      events ? metric.daysSincePositive == null ? "Unknown" : `${format(metric.daysSincePositive)} days`
        : model.decision.status,
      events ? metric.lastPositiveAt ? date(metric.lastPositiveAt) : "No positive event observed" : model.decision.reason);
    const start = Date.parse(model.window.startAt), end = Date.parse(model.window.endAt);
    const x = at => 66 + (Date.parse(at) - start) / (end - start) * 990;
    const chart = (title, caption, values, height = 235) => {
      node("h2", title, content);
      node("p", caption, content, "muted");
      const wrap = node("div", null, content, "chart");
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", title);
      const svg = svgNode("svg", { viewBox: `0 0 1100 ${height + 45}`, role: "img", "aria-label": title }, wrap);
      svgNode("title", {}, svg, `${title}: ${metric.name}`);
      const { low, high } = values.reduce((range, value) => value == null ? range
        : { low: Math.min(range.low, value), high: Math.max(range.high, value) }, { low: 0, high: 1 });
      const y = value => 16 + (high - value) / (high - low) * (height - 38);
      for (let i = 0; i <= 4; i++) {
        const value = low + (high - low) * i / 4;
        svgNode("line", { x1: 66, x2: 1056, y1: y(value), y2: y(value), class: "grid" }, svg);
        svgNode("text", { x: 58, y: y(value) + 4, "text-anchor": "end", class: "axis" }, svg, format(value));
      }
      for (const tick of model.ticks) {
        svgNode("line", { x1: x(tick.at), x2: x(tick.at), y1: 16, y2: height - 22, class: "grid" }, svg);
        svgNode("text", { x: x(tick.at), y: height + 4, "text-anchor": "middle", class: "axis" }, svg, tick.label);
      }
      return { svg, y, height };
    };
    node("p", "Scroll charts horizontally on smaller screens to inspect the full history.", content, "muted mobile-help");
    const path = (points, field, plot, className, step = false) => {
      let d = "", connected = false;
      for (const point of points) {
        if (point[field] == null) { connected = false; continue; }
        d += !connected ? `M${x(point.at)},${plot.y(point[field])}`
          : step ? `H${x(point.at)}V${plot.y(point[field])}` : `L${x(point.at)},${plot.y(point[field])}`;
        connected = true;
      }
      svgNode("path", { d, class: className }, plot.svg);
    };
    const top = chart(events ? `${metric.basis === "workflow-contribution" ? "Delivery" : "Outcome"} pulse (${metric.unit}/week)` : `${metric.name} (${metric.unit})`,
      events ? "Calendar-week bars; solid: trailing 28 days; dashed: trailing 91 days. Faded bars are partial weeks. Blank rates mean insufficient coverage."
        : "Native observations, not cumulative delivery. Gaps remain unknown; overlapping intervals are not added.",
      [...metric.series.flatMap(point => [point.value, point.baseline]), ...metric.weekly.map(point => point.rate)]);
    for (const bucket of metric.weekly) {
      if (bucket.rate == null) continue;
      const bar = svgNode("rect", { x: x(bucket.startAt) + 1, width: Math.max(1, x(bucket.endAt) - x(bucket.startAt) - 2),
        y: Math.min(top.y(0), top.y(bucket.rate)), height: Math.max(1, Math.abs(top.y(0) - top.y(bucket.rate))),
        class: bucket.partial ? "bar partial" : "bar" }, top.svg);
      svgNode("title", {}, bar,
        `${date(bucket.startAt)} - ${date(bucket.endAt)}: ${format(bucket.value)} ${metric.unit}; ${format(bucket.rate)}/week${bucket.partial ? " (partial week, actual exposure)" : ""}`);
    }
    path(metric.series, "baseline", top, "baseline");
    path(metric.series, "value", top, "primary");
    if (!events) {
      for (const point of metric.series) {
        if (point.value == null) continue;
        const circle = svgNode("circle", { cx: x(point.at), cy: top.y(point.value), r: 3, class: "point" }, top.svg);
        svgNode("title", {}, circle, `${date(point.at)}: ${format(point.value)} ${metric.unit}; ${point.status}`);
      }
    }
    if (events) {
      const contribution = metric.basis === "workflow-contribution";
      const bottom = chart(`Cumulative ${contribution ? "historical delivery" : "observed outcome"} (${metric.unit})`,
        contribution
          ? `Solid: all demonstrated contribution. Dotted: receipt-backed subset (${format(metric.receiptTotal)}); corroborated: ${format(metric.observedTotal - metric.receiptTotal)}. Click or focus an event to inspect evidence.`
          : "Actor-independent native outcomes, not workflow credit. Click or focus an event to inspect evidence.",
        metric.cumulative.flatMap(point => [point.value, point.receipt]), 190);
      bottom.svg.setAttribute("role", "group");
      path(metric.cumulative, "value", bottom, "primary", true);
      if (contribution) path(metric.cumulative, "receipt", bottom, "receipt", true);
      const detail = node("aside", null, content, "event-detail");
      detail.setAttribute("aria-live", "polite");
      const show = event => {
        detail.replaceChildren();
        node("h3", `${date(event.at)}: ${event.label}`, detail);
        node("p", `${format(event.value)} ${metric.unit}; ${event.attribution}.`, detail);
        node("p", `Acceptance: ${date(event.acceptance.at)}; reference ${event.acceptance.ref}.`, detail, "muted");
        for (const edge of event.lineage ?? []) {
          node("p", `Lineage: ${edge.outputId} ${edge.relation} ${edge.implementationId} at ${edge.at}.`, detail, "muted");
        }
        node("p", event.detail, detail);
        const links = node("p", null, detail, "evidence-links");
        for (const ref of event.evidence) {
          const link = node("a", ref.label, links);
          link.href = ref.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
      };
      metric.events.forEach((event, index) => {
        const mark = svgNode("circle", { cx: x(event.at), cy: bottom.height + 24,
          r: event.value === 0 ? 3 : 4, tabindex: 0, role: "button",
          "aria-label": `${event.label}: ${format(event.value)} ${metric.unit}, ${date(event.at)}`,
          class: event.attribution === "receipt-verified" ? "event receipt-event" : "event",
          "data-event": index }, bottom.svg);
        svgNode("title", {}, mark, `${event.label}: ${format(event.value)} ${metric.unit}`);
        mark.addEventListener("click", () => show(event));
        mark.addEventListener("focus", () => show(event));
        mark.addEventListener("keydown", key => {
          if (key.key === "Enter" || key.key === " ") { key.preventDefault(); show(event); }
        });
      });
      const latest = metric.events.at(-1);
      if (latest) show(latest);
      else node("p", "No delivery events observed; inspect coverage before interpreting zero.", detail);
    }
    node("h2", "Interpretation and limits", content);
    const notes = node("ul", null, content);
    for (const note of metric.notes) node("li", note, notes);
    node("p", `Decision: ${model.decision.status}. Costs: ${model.cost.status}. ${model.limitation}`, content, "muted");
    node("p", "Improving/worsening describes measured movement, not statistical significance. Attention means inspect, not disable. A saved report must be regenerated to monitor new work.", content, "muted");
  };
  select.addEventListener("change", draw);
  draw();
}
