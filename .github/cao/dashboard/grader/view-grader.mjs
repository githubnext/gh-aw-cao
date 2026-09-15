#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REFERENCES = [
  {
    id: "shannon-1948",
    title: "A Mathematical Theory of Communication",
    url: "https://doi.org/10.1002/j.1538-7305.1948.tb01338.x",
    adaptation: "Normalized categorical entropy measures whether a visual channel carries a useful distribution of signal.",
  },
  {
    id: "cleveland-mcgill-1984",
    title: "Graphical Perception: Theory, Experimentation, and Application",
    url: "https://doi.org/10.1080/01621459.1984.10478080",
    adaptation: "Position and length encodings are favored for quantitative comparisons.",
  },
  {
    id: "mackinlay-1986",
    title: "Automating the Design of Graphical Presentations",
    url: "https://doi.org/10.1145/22949.22950",
    adaptation: "Encoding fields and types are checked for expressiveness and effectiveness.",
  },
  {
    id: "purchase-1997",
    title: "Which Aesthetic has the Greatest Effect on Human Understanding?",
    url: "https://doi.org/10.1007/3-540-63938-1_67",
    adaptation: "Observable overlap and crossing evidence lowers graphical readability.",
  },
  {
    id: "ngo-2003",
    title: "Modelling interface aesthetics",
    url: "https://doi.org/10.1016/S0141-9382(02)00004-2",
    adaptation: "Layout balance, density, and regularity provide limited structural proxies for aesthetics.",
  },
];

const WEIGHTS = {
  clarity: 0.3,
  "information-signal": 0.25,
  "cognitive-economy": 0.2,
  "visual-balance": 0.15,
  legibility: 0.1,
};
const MAX_ROWS_PER_SOURCE = 10_000;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function textPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedEntropy(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const counts = new Map();
  for (const value of values) {
    const key = value == null ? "__missing__" : String(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size < 2) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log2(probability);
  }
  return round(entropy / Math.log2(counts.size));
}

function viewSources(view, sources) {
  const names = [
    view?.data?.source,
    ...(Array.isArray(view?.data?.sources) ? view.data.sources : []),
  ].filter((name) => typeof name === "string");
  return names.map((name) => ({ name, ...sources?.[name] }));
}

function encodedFields(view) {
  return Object.entries(view?.encoding || {})
    .filter(([, definition]) => definition && typeof definition === "object")
    .map(([channel, definition]) => ({ channel, ...definition }));
}

function categoricalSignal(view, rows) {
  const encoding = encodedFields(view).find(({ type }) =>
    type === "nominal" || type === "ordinal");
  if (!encoding?.field || !rows.length) return { cardinality: null, entropy: null };
  const values = rows.map((row) => row?.[encoding.field]);
  return {
    field: encoding.field,
    cardinality: new Set(values.map(String)).size,
    entropy: normalizedEntropy(values),
  };
}

function screenshotScore(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    return { score: 0.75, status: "not-observed", viewports: 0 };
  }
  const valid = observations.filter(({ width, height }) =>
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0);
  if (valid.length === 0) return { score: 0.5, status: "invalid-observations", viewports: 0 };
  const defects = valid.reduce(
    (count, item) => count + Number(item.clipped === true) + Number(item.overlap === true),
    0,
  );
  return {
    score: clamp(1 - defects / (valid.length * 2)),
    status: defects === 0 ? "observed-clear" : "observed-defects",
    viewports: valid.length,
  };
}

function finding(metric, severity, evidence, action) {
  return { metric, severity, evidence, action };
}

export function gradeDashboardView(view, options = {}) {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    throw new TypeError("view must be an object");
  }
  const sourceRecords = viewSources(view, options.sources || {});
  const rows = sourceRecords.flatMap((source) =>
    Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS_PER_SOURCE) : []);
  const encodings = encodedFields(view);
  const categorical = categoricalSignal(view, rows);
  const screenshot = screenshotScore(options.screenshots);
  const findings = [];

  const contextParts = [
    textPresent(view.title),
    textPresent(view.description),
    sourceRecords.length > 0,
    textPresent(view.mark),
  ];
  const clarity = contextParts.filter(Boolean).length / contextParts.length;
  if (!textPresent(view.title)) {
    findings.push(finding("clarity", "high", "The view has no title.", "Add a short, decision-oriented title."));
  }
  if (!textPresent(view.description)) {
    findings.push(finding("clarity", "low", "The view has no explanatory description.", "Add one sentence stating the question this view answers."));
  }

  let informationSignal = sourceRecords.length > 0 ? 0.7 : 0.35;
  if (rows.length > 0) informationSignal += 0.15;
  if (encodings.length > 0 || view.mark === "element") informationSignal += 0.15;
  if (categorical.entropy != null) informationSignal = (informationSignal + categorical.entropy) / 2;
  informationSignal = clamp(informationSignal);
  if (categorical.cardinality != null && categorical.cardinality > 8) {
    findings.push(finding(
      "information-signal",
      "medium",
      `${categorical.field} uses ${categorical.cardinality} categories in one visual channel.`,
      "Group the least important categories or show only the highest-priority categories.",
    ));
  }

  const complexity = encodings.length
    + Number(view.mark === "table") * Math.max(0, (view.encoding?.columns?.length || 0) - 4)
    + (Array.isArray(view.controls) ? view.controls.length : 0);
  const cognitiveEconomy = clamp(1 - Math.max(0, complexity - 4) / 8);
  if (complexity > 8) {
    findings.push(finding(
      "cognitive-economy",
      "medium",
      `The view exposes ${complexity} simultaneous encoding, column, and control choices.`,
      "Move secondary fields into the existing detail disclosure or remove the least useful field.",
    ));
  }

  const width = { full: 1, half: 0.5, third: 1 / 3 }[view.layout] || 1;
  const density = clamp((encodings.length + Number(view.mark === "element")) / 6);
  const visualBalance = clamp(1 - Math.abs(0.55 - density) * 0.8 - (width < 1 && complexity > 6 ? 0.15 : 0));

  if (screenshot.status === "observed-defects") {
    findings.push(finding(
      "legibility",
      "high",
      "Screenshot observations report clipping or overlap.",
      "Fix the smallest local spacing, wrapping, or overflow rule that removes the verified defect.",
    ));
  }

  const scores = {
    clarity: round(clarity),
    "information-signal": round(informationSignal),
    "cognitive-economy": round(cognitiveEconomy),
    "visual-balance": round(visualBalance),
    legibility: round(screenshot.score),
  };
  const overall = round(Object.entries(WEIGHTS)
    .reduce((total, [metric, weight]) => total + scores[metric] * weight, 0) * 100, 1);

  return {
    view: String(view.id || view.title || "unnamed-view"),
    overall,
    scores,
    observations: {
      rows: rows.length,
      sources: sourceRecords.map(({ name, metadata }) => ({ name, metadata: metadata || null })),
      encodings: encodings.length,
      categorical,
      screenshot: { status: screenshot.status, viewports: screenshot.viewports },
    },
    findings: findings.toSorted((left, right) =>
      ["high", "medium", "low"].indexOf(left.severity)
      - ["high", "medium", "low"].indexOf(right.severity)),
  };
}

function pageViews(page) {
  return page?.kind === "built-in"
    ? page?.definition?.views || []
    : page?.views || [];
}

export function gradeDashboardDocument(document, options = {}) {
  const pages = document?.dashboard?.pages;
  if (!Array.isArray(pages)) throw new TypeError("dashboard.pages must be an array");
  const screenshots = options.screenshots || {};
  const results = pages.flatMap((page) =>
    pageViews(page).filter((view) => textPresent(view.title)).map((view) => ({
      page: String(page.id || page.title || "unnamed-page"),
      ...gradeDashboardView(view, {
        sources: options.sources,
        screenshots: screenshots[view.id],
      }),
    })));
  const findings = results.flatMap((result) =>
    result.findings.map((item) => ({ page: result.page, view: result.view, ...item })));
  return {
    schemaVersion: 1,
    summary: {
      views: results.length,
      average: results.length
        ? round(results.reduce((total, result) => total + result.overall, 0) / results.length, 1)
        : null,
      findings: findings.length,
      highPriorityFindings: findings.filter(({ severity }) => severity === "high").length,
    },
    views: results,
    findings,
    methodology: {
      purpose: "Decision-support heuristic for triaging small dashboard improvements; not a usability study or redesign mandate.",
      scoreRange: "0–100",
      weights: WEIGHTS,
      references: REFERENCES,
    },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const dashboardPath = argument("--dashboard");
  const outputPath = argument("--output");
  if (!dashboardPath || !outputPath) {
    throw new Error("Usage: view-grader.mjs --dashboard <dashboard.json> --output <report.json> [--sources <sources.json>] [--screenshots <observations.json>]");
  }
  const [document, sources, screenshots] = await Promise.all([
    readFile(dashboardPath, "utf8").then(JSON.parse),
    argument("--sources") ? readFile(argument("--sources"), "utf8").then(JSON.parse) : {},
    argument("--screenshots") ? readFile(argument("--screenshots"), "utf8").then(JSON.parse) : {},
  ]);
  const report = gradeDashboardDocument(document, { sources, screenshots });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
