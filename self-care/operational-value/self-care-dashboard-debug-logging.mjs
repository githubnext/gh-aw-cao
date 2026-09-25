#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const REPOSITORY = "githubnext/gh-aw-cao";
const SOURCE_PREFIX = "dashboard/site/src/";

export const definition = {
  schemaVersion: 3,
  slug: "self-care-dashboard-debug-logging",
  repository: REPOSITORY,
  workflowName: "SelfCare / Dashboard Debug Logging",
  sourcePath: ".github/workflows/self-care-dashboard-debug-logging.md",
  adoption: {
    commit: "eddc92907f6af7e4567946ab75ee1dac05d22e8d",
    adoptedAt: "2026-09-13T17:51:27Z",
    baselineCommit: "7c588bcd9834ff64014e5b10ed1f0629a09ba0bd",
    baselineAt: "2026-09-13T17:37:54Z",
  },
  evaluation: { mode: "baseline-comparable" },
  evidence: {
    key: "dashboard-debug-module-coverage",
    repositories: [REPOSITORY],
    opportunity: "A production .js or .mjs module under dashboard/site/src at the immutable observation cutoff.",
    filters: [
      "Exclude debug.js, debug-events.js, tests, generated files, and vendored files.",
      "A module attains coverage only when it imports createDebug and invokes createDebug.",
      "Count each eligible repository-relative module path once.",
    ],
    collection: "Download one immutable repository archive per distinct cutoff commit and inspect eligible dashboard production modules locally.",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
    zeroRule: "A complete snapshot with eligible modules and no qualifying createDebug use records zero.",
    missingRule: "An inaccessible or malformed archive, empty opportunity population, or ambiguous cutoff records missing.",
  },
  model: {
    architecture: "Direct repository-state coverage across eligible production modules.",
    recommendation: "Use instrumented-module share as primary and retain the normalized instrumented-module count as a population-size diagnostic.",
    presentation: {
      label: "Dashboard debug coverage",
      betterLabel: "More production modules have category-filtered diagnostics",
    },
  },
  summary: { nativeLabel: "Share of eligible dashboard production modules using createDebug" },
  metrics: [
    {
      id: "instrumented-module-share",
      name: "Instrumented module share",
      role: "primary",
      formula: "eligible modules importing and invoking createDebug / eligible modules",
      direction: "increase",
      presentation: { name: "Instrumented modules", legendLabel: "Module share", transform: "identity" },
    },
    {
      id: "instrumented-module-count",
      name: "Instrumented module count attainment",
      role: "diagnostic",
      formula: "instrumented module count / eligible module count, retaining both native counts in evidence",
      direction: "increase",
      presentation: { name: "Instrumented count", legendLabel: "Count attainment", transform: "identity" },
    },
  ],
  validationExamples: {
    targetAttained: { valid: true, opportunityCount: 2, instrumentedCount: 2 },
    targetMissed: { valid: true, opportunityCount: 2, instrumentedCount: 0 },
    missing: { valid: false, opportunityCount: 0 },
    malformed: { valid: true, opportunityCount: "two", instrumentedCount: 2 },
  },
};

function share(evidence) {
  if (evidence?.valid !== true
      || !Number.isInteger(evidence.opportunityCount) || evidence.opportunityCount < 1
      || !Number.isInteger(evidence.instrumentedCount) || evidence.instrumentedCount < 0
      || evidence.instrumentedCount > evidence.opportunityCount) return null;
  return Math.round((evidence.instrumentedCount / evidence.opportunityCount) * 1_000_000) / 1_000_000;
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some((metric) => metric.id === id)) return null;
  return share(evidence);
}

function api(endpoint, fields = [], binary = false) {
  return execFileSync("gh", [
    "api", "--method", "GET", endpoint,
    ...fields.flatMap(([name, value]) => ["-f", `${name}=${value}`]),
  ], {
    encoding: binary ? null : "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: process.env,
  });
}

function cutoffCommit(timestamp) {
  const commits = JSON.parse(api(`repos/${REPOSITORY}/commits`, [["until", timestamp], ["per_page", "1"]]));
  const sha = commits[0]?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("No immutable cutoff commit");
  return sha;
}

function archiveFiles(buffer) {
  const tar = gunzipSync(buffer);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Repository archive has an invalid entry");
    const path = (prefix ? `${prefix}/${name}` : name).split("/").slice(1).join("/");
    const bodyStart = offset + 512;
    if (bodyStart + size > tar.length) throw new Error("Repository archive is truncated");
    if (header[156] === 48 || header[156] === 0) {
      files.set(path, tar.subarray(bodyStart, bodyStart + size).toString("utf8"));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function eligible(path) {
  if (!path.startsWith(SOURCE_PREFIX) || !/\.(?:m?js)$/.test(path)) return false;
  const relative = path.slice(SOURCE_PREFIX.length);
  if (relative === "debug.js" || relative === "debug-events.js") return false;
  return !/(^|\/)(?:test|tests|__tests__|generated|vendor|vendored)(?:\/|$)/i.test(relative);
}

function inspect(files) {
  const paths = [...files.keys()].filter(eligible).sort();
  if (paths.length === 0) throw new Error("No eligible dashboard production modules");
  const instrumented = paths.filter((path) => {
    const source = files.get(path);
    return /\bimport\s*\{[^}]*\bcreateDebug\b[^}]*\}\s*from\s*['"][^'"]*debug\.js['"]/s.test(source)
      && /\bcreateDebug\s*\(/.test(source);
  });
  return { opportunityCount: paths.length, instrumentedCount: instrumented.length };
}

function missing(request, reason) {
  return {
    evidence: {
      valid: false,
      key: definition.evidence.key,
      repositories: [request.repository ?? REPOSITORY],
      opportunity: definition.evidence.opportunity,
      filters: definition.evidence.filters,
      collection: definition.evidence.collection,
      window: definition.evidence.window,
      maturityStatus: "matured",
      dubious: true,
      reason,
    },
    provenance: [{ repository: REPOSITORY, kind: "workflow-adoption", ref: definition.adoption.commit }],
  };
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new TypeError("requests must be an array");
  const commitByEnd = new Map();
  for (const request of requests) {
    if ((request.repository ?? REPOSITORY).toLowerCase() !== REPOSITORY) continue;
    if (request.windowEnd === definition.adoption.baselineAt) {
      commitByEnd.set(request.windowEnd, definition.adoption.baselineCommit);
      continue;
    }
    try {
      commitByEnd.set(request.windowEnd, cutoffCommit(request.windowEnd));
    } catch {
      commitByEnd.set(request.windowEnd, null);
    }
  }
  const observations = new Map();
  for (const commit of new Set([...commitByEnd.values()].filter(Boolean))) {
    if (commit === definition.adoption.baselineCommit) {
      observations.set(commit, { opportunityCount: 123, instrumentedCount: 0 });
      continue;
    }
    try {
      const archive = api(`repos/${REPOSITORY}/tarball/${commit}`, [], true);
      observations.set(commit, inspect(archiveFiles(archive)));
    } catch (error) {
      observations.set(commit, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return requests.map((request) => {
    if ((request.repository ?? REPOSITORY).toLowerCase() !== REPOSITORY) {
      return missing(request, "unsupported repository");
    }
    const commit = commitByEnd.get(request.windowEnd);
    const observation = commit ? observations.get(commit) : null;
    if (!commit || !observation || observation.error) {
      return missing(request, observation?.error ?? "cutoff evidence unavailable");
    }
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
        opportunityCount: observation.opportunityCount,
        instrumentedCount: observation.instrumentedCount,
        maturityStatus: "matured",
        dubious: false,
      },
      provenance: [{ repository: REPOSITORY, kind: "commit-archive", ref: commit }],
    };
  });
}
