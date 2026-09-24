#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { escapeXml, fail, readJson, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 2, "render-timeline-svg.mjs <timeline.json> <timeline.svg>");
if (!existsSync(args[0])) fail(`timeline not found: ${args[0]}`);
const artifact = readJson(args[0]);
if (artifact.schemaVersion !== 2 || ![2, 3].includes(artifact.definitionSchemaVersion)
    || artifact.snapshots?.length < 2 || artifact.metricReview?.metrics?.length < 1) {
  fail("timeline does not satisfy the renderable artifact contract");
}

const mode = artifact.evaluationMode ?? "baseline-comparable";
const start = Date.parse(artifact.snapshots[0].observedAt);
const end = Date.parse(artifact.snapshots.at(-1).observedAt);
const span = Math.max(1, end - start);
const adoption = Date.parse(artifact.adoptionAt);
const showAdoption = adoption >= start && adoption <= end;
const x = (time) => 120 + ((Date.parse(time) - start) / span) * 1040;
const y = (value) => 460 - value * 350;
const colors = ["var(--data-blue)", "var(--data-green)", "var(--data-orange)", "var(--data-red)", "var(--data-cyan)", "var(--data-pink)"];
const dateLabel = (value) => new Intl.DateTimeFormat("en-US", {
  month: "short", day: "2-digit", timeZone: "UTC",
}).format(new Date(value));
const lastSnapshot = artifact.snapshots.length - 1;
const tickStep = Math.max(1, Math.ceil(lastSnapshot / 8));
const legendRows = Math.ceil(artifact.metricReview.metrics.length / 2);
const legendBottom = 540 + legendRows * 40;
const runsTitleY = legendBottom + 62;
const runsTop = runsTitleY + 18;
const runsBottom = runsTop + 46;
const runLegendY = runsBottom + 45;
const height = runLegendY + 29;
const lines = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title description">`,
  `<title id="title">${escapeXml(artifact.workflowName)} workflow ${mode === "attainment-only" ? "attainment" : "value"} timeline</title>`,
  `<desc id="description">Goal-oriented repository outcome metrics ${mode === "attainment-only" ? "after workflow adoption" : "before and after workflow adoption"}, with workflow run conclusions over time.</desc>`,
  "<style>:root{--fg:#1f2328;--muted:#59636e;--bg:#ffffff;--subtle:#f6f8fa;--border:#d1d9e0;--adoption:#8250df;--success:#1a7f37;--danger:#cf222e;--data-blue:#0969da;--data-green:#1a7f37;--data-orange:#bc4c00;--data-red:#cf222e;--data-cyan:#1b7c83;--data-pink:#bf3989}@media(prefers-color-scheme:dark){:root{--fg:#f0f6fc;--muted:#9198a1;--bg:#0d1117;--subtle:#151b23;--border:#3d444d;--adoption:#a371f7;--success:#3fb950;--danger:#f85149;--data-blue:#4493f8;--data-green:#3fb950;--data-orange:#d29922;--data-red:#ff7b72;--data-cyan:#39c5cf;--data-pink:#db61a2}}text{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:var(--fg);font-size:20px}.title{font-size:30px;font-weight:700}.section{font-size:20px;font-weight:600}.axis{font-size:17px}.muted{fill:var(--muted)}.grid{stroke:var(--border);stroke-width:1}.metric{fill:none;stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.point{stroke:var(--bg);stroke-width:2}.run-success{stroke:var(--success)}.run-failure{stroke:var(--danger)}.run-other{stroke:var(--muted)}</style>",
  `<rect width="1280" height="${height}" fill="var(--bg)"/>`,
  `<text x="120" y="48" class="title">${escapeXml(artifact.workflowName)} ${mode === "attainment-only" ? "attainment" : "value"} over time</text>`,
];
if (mode === "baseline-comparable" && showAdoption) {
  lines.push(`<rect x="120" y="78" width="${x(artifact.adoptionAt) - 120}" height="382" fill="var(--subtle)"/><text x="140" y="100" class="section muted">Pre-adoption baseline</text><text x="${x(artifact.adoptionAt) + 18}" y="100" class="section muted">Post-adoption history</text>`);
} else {
  lines.push(`<text x="120" y="100" class="section muted">${mode === "attainment-only" ? "Post-adoption attainment" : "Collected history"}</text>`);
}
for (let tick = 0; tick < 5; tick += 1) {
  const value = 1 - tick / 4;
  lines.push(`<line class="grid" x1="120" y1="${y(value)}" x2="1160" y2="${y(value)}"/><text x="102" y="${y(value) + 6}" text-anchor="end" class="axis muted">${value}</text>`);
}
artifact.snapshots.forEach((snapshot, index) => {
  if (index % tickStep === 0 || index === lastSnapshot) {
    lines.push(`<line class="grid" x1="${x(snapshot.observedAt)}" y1="110" x2="${x(snapshot.observedAt)}" y2="460"/><text x="${x(snapshot.observedAt)}" y="490" text-anchor="middle" class="axis muted">${dateLabel(snapshot.observedAt)}</text>`);
  }
});
lines.push('<text transform="translate(36 285) rotate(-90)" text-anchor="middle" class="axis">Goal measure</text>');
if (showAdoption) lines.push(`<line x1="${x(artifact.adoptionAt)}" y1="78" x2="${x(artifact.adoptionAt)}" y2="460" stroke="var(--adoption)" stroke-width="3" stroke-dasharray="5 6"/>`);
artifact.metricReview.metrics.forEach((metric, index) => {
  const presented = (value) => metric.presentation.transform === "complement" ? 1 - value : value;
  const points = artifact.snapshots
    .filter((snapshot) => snapshot.metrics[metric.id] != null)
    .map((snapshot) => ({ at: snapshot.observedAt, value: presented(snapshot.metrics[metric.id]) }));
  lines.push(`<polyline class="metric" stroke="${colors[index % colors.length]}" points="${points.map((point) => `${x(point.at)},${y(point.value)}`).join(" ")}"/>`);
  for (const point of points) lines.push(`<circle class="point" fill="${colors[index % colors.length]}" cx="${x(point.at)}" cy="${y(point.value)}" r="6"/>`);
  const legendX = 120 + (index % 2) * 520;
  const legendY = 540 + Math.floor(index / 2) * 40;
  lines.push(`<line x1="${legendX}" y1="${legendY}" x2="${legendX + 34}" y2="${legendY}" stroke="${colors[index % colors.length]}" stroke-width="4"/><text x="${legendX + 46}" y="${legendY + 7}">${escapeXml(metric.presentation.legendLabel)}</text>`);
});
if (showAdoption) lines.push(`<line x1="640" y1="${legendBottom - 20}" x2="674" y2="${legendBottom - 20}" stroke="var(--adoption)" stroke-width="3" stroke-dasharray="5 6"/><text x="686" y="${legendBottom - 13}">Workflow adopted</text>`);
lines.push(`<text x="120" y="${runsTitleY}" class="section">Workflow runs</text>`);
lines.push(`<rect x="120" y="${runsTop}" width="1040" height="46" fill="var(--subtle)"/>`);
for (const run of artifact.runs ?? []) {
  const time = Date.parse(run.createdAt);
  if (time < start || time > end) continue;
  const className = run.conclusion === "success"
    ? "run-success"
    : ["failure", "timed_out", "cancelled"].includes(run.conclusion) ? "run-failure" : "run-other";
  lines.push(`<line x1="${x(run.createdAt)}" y1="${runsTop}" x2="${x(run.createdAt)}" y2="${runsBottom}" stroke-width="3" class="${className}"/>`);
}
lines.push(`<circle cx="126" cy="${runLegendY}" r="6" fill="var(--success)"/><text x="142" y="${runLegendY + 7}" class="axis muted">Success</text><circle cx="292" cy="${runLegendY}" r="6" fill="var(--danger)"/><text x="308" y="${runLegendY + 7}" class="axis muted">Failure</text><circle cx="448" cy="${runLegendY}" r="6" fill="var(--muted)"/><text x="464" y="${runLegendY + 7}" class="axis muted">Other</text>`);
lines.push("</svg>");
writeFileSync(args[1], `${lines.join("\n")}\n`);
console.log(`wrote ${args[1]}`);
