#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { escapeXml, readJson, requireArgs, run, scriptDir, writeJson } from "./common.mjs";
import { eventPulse, timelinePulse } from "./pulse-model.mjs";
import { mountPulse } from "./pulse-view.mjs";

export function renderPulse(model) {
  const data = JSON.stringify(model).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const css = readFileSync(new URL("./pulse.css", import.meta.url), "utf8");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(model.workflowName)} - operational value</title><style>${css}</style></head>
<body><main></main><noscript>This interactive report requires JavaScript. The adjacent pulse JSON contains the same computed facts.</noscript>
<script type="module">(${mountPulse.toString()})(document,${data});</script></body></html>\n`;
}

export function writePulse(input, output) {
  if (path.extname(output) !== ".html") throw new Error("Pulse output must end in .html");
  const model = input.kind === "operational-value-events" ? eventPulse(input) : timelinePulse(input);
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, renderPulse(model));
  writeFileSync(output.replace(/\.html$/, ".json"), writeJson(model));
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  requireArgs(args, 2, 2, "render-pulse.mjs <timeline-or-events.json> <pulse.html>");
  const input = readJson(args[0]);
  if (input.kind !== "operational-value-events") {
    run(path.join(scriptDir, "validate-report-artifacts.mjs"), [args[0]]);
  }
  const model = writePulse(input, args[1]);
  const selected = model.metrics.find(metric => metric.id === model.selectedMetricId);
  console.log(`${args[1]}: ${selected.signal.status}; attention=${selected.signal.attention}`);
}
