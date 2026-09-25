#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const REPOSITORY = "githubnext/gh-aw-cao";
const DATA_URL = "https://githubnext.github.io/gh-aw-cao/cao/sources";
const DAY_MS = 86_400_000;

export const definition = {
  schemaVersion: 3,
  slug: "self-care-dashboard-data-schema",
  repository: REPOSITORY,
  workflowName: "SelfCare / Dashboard Data Schema",
  sourcePath: ".github/workflows/self-care-dashboard-data-schema.md",
  adoption: {
    commit: "c33a4c2de76ae12cd9beb9ec9f01f9bbf3359639",
    adoptedAt: "2026-09-08T14:58:45Z",
    baselineCommit: "be27b41d7dfc615b0a603c41a815dd1dfd528866",
    baselineAt: "2026-09-08T14:51:39Z",
  },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "dashboard-data-schema-synchronization",
    repositories: [REPOSITORY],
    opportunity: "Each valid JSON source advertised by the deployed dashboard data manifest during a daily observation.",
    filters: [
      "The manifest must advertise at most 500 unique source names matching the workflow's source-name allowlist.",
      "The manifest and every advertised source must be available and valid JSON.",
      "Schema inference samples at most 50 rows, six nested levels, and twelve displayed object properties.",
      "The checked-in specification is read from the last immutable repository commit at or before the observation cutoff.",
    ],
    collection: "Fetch one complete deployed Pages snapshot, infer its bounded pseudo schemas, and compare every generated source section with specs/dashboard-data.md at the immutable cutoff commit.",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    zeroRule: "A complete deployed snapshot with advertised sources and no matching checked-in source sections records zero.",
    missingRule: "An unavailable or malformed manifest, source, cutoff commit, or specification records missing rather than zero.",
  },
  model: {
    architecture: "Direct source-opportunity attainment with a whole-document synchronization diagnostic.",
    recommendation: "Use matching advertised source share as primary and retain exact whole-document synchronization as a strict diagnostic.",
    presentation: {
      label: "Dashboard schema synchronization",
      betterLabel: "More advertised sources documented exactly",
    },
  },
  summary: { nativeLabel: "Share of advertised dashboard sources with matching pseudo-schema sections" },
  metrics: [
    {
      id: "matching-source-share",
      name: "Matching source share",
      role: "primary",
      formula: "advertised source sections exactly matching inferred pseudo schemas / advertised sources",
      direction: "increase",
      presentation: { name: "Matching sources", legendLabel: "Matching sources", transform: "identity" },
    },
    {
      id: "document-synchronized",
      name: "Whole document synchronized",
      role: "diagnostic",
      formula: "1 when the checked-in specification exactly equals the generated pseudo-schema document; otherwise 0",
      direction: "increase",
      presentation: { name: "Document synchronized", legendLabel: "Exact document", transform: "identity" },
    },
  ],
  validationExamples: {
    targetAttained: { valid: true, opportunityCount: 2, matchingCount: 2, documentMatch: true },
    targetMissed: { valid: true, opportunityCount: 2, matchingCount: 0, documentMatch: false },
    missing: { valid: false, opportunityCount: 0 },
    malformed: { valid: true, opportunityCount: "two", matchingCount: 2, documentMatch: true },
  },
};

function boundedShare(numerator, denominator) {
  if (!Number.isInteger(denominator) || denominator < 1
      || !Number.isInteger(numerator) || numerator < 0 || numerator > denominator) return null;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

export function scoreMetric(id, evidence) {
  if (evidence?.valid !== true) return null;
  if (id === "matching-source-share") {
    return boundedShare(evidence.matchingCount, evidence.opportunityCount);
  }
  if (id === "document-synchronized") {
    if (!Number.isInteger(evidence.opportunityCount) || evidence.opportunityCount < 1
        || typeof evidence.documentMatch !== "boolean") return null;
    return evidence.documentMatch ? 1 : 0;
  }
  return null;
}

function api(endpoint, fields = []) {
  return JSON.parse(execFileSync("gh", [
    "api", "--method", "GET", endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: process.env }));
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Dashboard evidence request failed: ${response.status}`);
  return response.json();
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function inferShape(value, open = new Set(), depth = 0) {
  if (Array.isArray(value)) {
    if (open.has(value)) return { kind: "circular" };
    if (depth >= 6) return { kind: "primitive", type: "array" };
    open.add(value);
    try {
      const shapes = value.map((item) => inferShape(item, open, depth + 1));
      return { kind: "array", element: shapes.length ? mergeShapes(shapes) : { kind: "primitive", type: "unknown" } };
    } finally {
      open.delete(value);
    }
  }
  if (value !== null && typeof value === "object") {
    if (open.has(value)) return { kind: "circular" };
    if (depth >= 6) return { kind: "primitive", type: "object" };
    open.add(value);
    try {
      return {
        kind: "object",
        properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [
          key, { shape: inferShape(item, open, depth + 1), optional: false },
        ])),
      };
    } finally {
      open.delete(value);
    }
  }
  return { kind: "primitive", type: valueType(value) };
}

function formatShape(shape, depth = 0) {
  if (shape.kind === "circular") return "(circular)";
  if (shape.kind === "primitive") return shape.type;
  if (shape.kind === "union") return shape.options.map((item) => formatShape(item, depth)).join(" | ");
  if (shape.kind === "array") return `${formatShape(shape.element, depth + 1)}[]`;
  const keys = Object.keys(shape.properties).sort();
  if (!keys.length) return "{}";
  const visible = keys.slice(0, 12);
  const fields = visible.map((key) => {
    const property = shape.properties[key];
    return `${key}${property.optional ? "?" : ""}: ${formatShape(property.shape, depth + 1)}`;
  });
  if (keys.length > visible.length) fields.push(`… +${keys.length - visible.length} more`);
  return `{ ${fields.join(", ")} }`;
}

function mergeShapes(shapes) {
  if (!shapes.length) return { kind: "primitive", type: "unknown" };
  if (shapes.length === 1) return shapes[0];
  const kinds = new Set(shapes.map(({ kind }) => kind));
  if (kinds.size === 1 && kinds.has("circular")) return { kind: "circular" };
  if (kinds.size === 1 && kinds.has("primitive")) {
    const types = [...new Set(shapes.map(({ type }) => type))].sort();
    const known = types.filter((type) => type !== "unknown");
    return { kind: "primitive", type: (known.length ? known : types).join(" | ") };
  }
  if (kinds.size === 1 && kinds.has("array")) {
    return { kind: "array", element: mergeShapes(shapes.map(({ element }) => element)) };
  }
  if (kinds.size === 1 && kinds.has("object")) {
    const keys = [...new Set(shapes.flatMap(({ properties }) => Object.keys(properties)))].sort();
    return {
      kind: "object",
      properties: Object.fromEntries(keys.map((key) => {
        const observed = shapes.map(({ properties }) => properties[key]).filter(Boolean);
        return [key, {
          shape: mergeShapes(observed.map(({ shape }) => shape)),
          optional: observed.length < shapes.length || observed.some(({ optional }) => optional),
        }];
      })),
    };
  }
  const options = [];
  for (const shape of shapes) {
    if (!options.some((option) => formatShape(option) === formatShape(shape))) options.push(shape);
  }
  return options.length === 1 ? options[0] : { kind: "union", options };
}

function inferSchema(value) {
  const rows = value && typeof value === "object" && Array.isArray(value.rows)
    ? value.rows
    : (Array.isArray(value) ? value : [value]);
  const sample = rows.slice(0, 50);
  return sample.length ? formatShape(mergeShapes(sample.map((row) => inferShape(row)))) : "{}";
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderDocument(entries) {
  const sections = entries.map(([file, , schema]) => `## \`${file}\`\n\n<pre><code>${escapeHtml(schema)}</code></pre>`);
  return [
    "# Dashboard Data Schemas",
    "",
    `This specification records the pseudo schema of every JSON file advertised by the deployed dashboard data manifest at \`${DATA_URL}/manifest.json\`.`,
    "",
    "Schemas use the same bounded inference as the dashboard data diagnostics: at most 50 rows, six nested levels, and 12 displayed properties per object. A `?` marks a property absent from at least one sampled row.",
    "",
    ...sections,
    "",
  ].join("\n");
}

function sectionMap(document) {
  const sections = new Map();
  const pattern = /^## `([^`]+)`\n\n<pre><code>([\s\S]*?)<\/code><\/pre>(?=\n## `|\n*$)/gm;
  for (const match of document.matchAll(pattern)) sections.set(match[1], match[2]);
  return sections;
}

async function collectSnapshot() {
  const manifest = await getJson(`${DATA_URL}/manifest.json`);
  if (!Array.isArray(manifest?.sources) || manifest.sources.length > 500) {
    throw new TypeError("Dashboard manifest has an invalid sources list");
  }
  const names = [...new Set(manifest.sources)];
  if (names.length !== manifest.sources.length
      || names.some((name) => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) {
    throw new TypeError("Dashboard manifest contains an invalid source name");
  }
  const values = await Promise.all(names.sort().map((name) => getJson(`${DATA_URL}/${name}.json`)));
  return [
    ["sources/manifest.json", manifest, inferSchema(manifest)],
    ...names.map((name, index) => [`sources/${name}.json`, values[index], inferSchema(values[index])]),
  ];
}

function missingEvidence(request, reason) {
  return {
    evidence: {
      valid: false,
      key: definition.evidence.key,
      repositories: [request.repository ?? REPOSITORY],
      opportunity: definition.evidence.opportunity,
      filters: definition.evidence.filters,
      collection: definition.evidence.collection,
      window: definition.evidence.window,
      maturityStatus: Date.parse(request.observedAt) < Date.parse(definition.adoption.adoptedAt) + DAY_MS
        ? "interim" : "matured",
      dubious: true,
      reason,
    },
    provenance: [{ repository: REPOSITORY, kind: "workflow-adoption", ref: definition.adoption.commit }],
  };
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new TypeError("requests must be an array");
  const snapshotPromise = collectSnapshot().then(
    (entries) => ({ entries }),
    (error) => ({ error }),
  );
  return Promise.all(requests.map(async (request) => {
    if ((request.repository ?? REPOSITORY).toLowerCase() !== REPOSITORY) {
      return missingEvidence(request, "unsupported repository");
    }
    try {
      const commits = api(`repos/${REPOSITORY}/commits`, [["until", request.windowEnd], ["per_page", "1"]]);
      const commit = commits[0]?.sha;
      if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("No immutable cutoff commit");
      const content = api(`repos/${REPOSITORY}/contents/specs/dashboard-data.md`, [["ref", commit]]);
      if (typeof content.content !== "string" || content.encoding !== "base64") {
        throw new Error("Specification content is unavailable");
      }
      const specification = Buffer.from(content.content, "base64").toString("utf8");
      const snapshot = await snapshotPromise;
      if (snapshot.error) throw snapshot.error;
      const entries = snapshot.entries;
      const generated = renderDocument(entries);
      const actualSections = sectionMap(specification);
      const matchingCount = entries.filter(([file, , schema]) => actualSections.get(file) === escapeHtml(schema)).length;
      const interim = Date.parse(request.observedAt) < Date.parse(definition.adoption.adoptedAt) + DAY_MS;
      return {
        commit,
        evidence: {
          valid: true,
          key: definition.evidence.key,
          repositories: [REPOSITORY],
          opportunity: definition.evidence.opportunity,
          filters: definition.evidence.filters,
          collection: definition.evidence.collection,
          window: definition.evidence.window,
          opportunityCount: entries.length,
          matchingCount,
          documentMatch: specification === generated,
          maturityStatus: interim ? "interim" : "matured",
          dubious: interim,
        },
        provenance: [
          { repository: REPOSITORY, kind: "commit", ref: commit },
          { repository: REPOSITORY, kind: "deployed-snapshot", ref: `${DATA_URL}/manifest.json` },
        ],
      };
    } catch (error) {
      return missingEvidence(request, error instanceof Error ? error.message : String(error));
    }
  }));
}
