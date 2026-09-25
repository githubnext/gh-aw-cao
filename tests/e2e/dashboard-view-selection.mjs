import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { composeDashboardDocuments } from "../../dashboard/report/compose-dashboard-documents.mjs";
import { withoutIgnoredDashboardPageIds } from "./dashboard-view-assessment.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const primaryDashboardPath = "dashboard/site/dashboard.json";
// PR assessments are informational and run live-data browser checks; five pages
// keeps the job fast while still sampling the most relevant affected surfaces.
export const maximumSelectedDashboardPageCount = 5;
// Cache descriptors per parsed dashboard object. Re-reading or re-parsing the
// same file intentionally creates a fresh cache entry.
const pageSelectionDescriptorsByDashboard = new WeakMap();
const pageSelectionWeights = Object.freeze({
  pathIncludesPageId: 100,
  pageIdTerm: 30,
  titleTerm: 15,
  pageBodyTerm: 3,
});

const selectionStopWords = new Set([
  "component",
  "components",
  "dashboard",
  "data",
  "e2e",
  "json",
  "site",
  "src",
  "test",
  "tests",
  "unit",
  "view",
  "views",
]);

function identifierTerms(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !selectionStopWords.has(term));
}

function dashboardPaths() {
  return [
    primaryDashboardPath,
    ...readdirSync(repositoryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${entry.name}/dashboard.json`)
      .filter((path) => {
        try {
          readFileSync(join(repositoryRoot, path));
          return true;
        } catch {
          return false;
        }
      })
      .toSorted(),
  ];
}

function readDashboard(path, ref) {
  try {
    const content = ref
      ? execFileSync("git", ["show", `${ref}:${path}`], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : readFileSync(join(repositoryRoot, path), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function composedDashboard(paths) {
  const [primary, ...additions] = paths.map((path) => readDashboard(path)).filter(Boolean);
  return composeDashboardDocuments(primary, additions);
}

export function changedDashboardPageIds(current, previous) {
  const previousPages = new Map(
    (previous?.dashboard?.pages || []).map((page) => [page.id, JSON.stringify(page)]),
  );
  return (current?.dashboard?.pages || [])
    .filter((page) => previousPages.get(page.id) !== JSON.stringify(page))
    .map((page) => page.id);
}

export function sharedDashboardConfigurationChanged(current, previous) {
  if (!current || !previous) return true;
  const shared = (document) => {
    const { pages: _pages, navigation: _navigation, ...dashboard } = document.dashboard || {};
    const { dashboard: _dashboard, ...topLevel } = document;
    return { ...topLevel, dashboard };
  };
  return JSON.stringify(shared(current)) !== JSON.stringify(shared(previous));
}

function identifierKey(value) {
  return identifierTerms(value).join("-");
}

function pageSelectionDescriptor(page, index) {
  const pageId = String(page.id ?? "");
  const pageJson = JSON.stringify(page);
  const searchableBody = {
    description: page.description,
    definitionViews: page.definition?.views,
    views: page.views,
  };
  return {
    index,
    pageId,
    pageIdKey: identifierKey(pageId),
    pageJson,
    pageTerms: new Set(identifierTerms(pageId)),
    titleTerms: new Set(identifierTerms(page.title)),
    pageBodyTerms: new Set(identifierTerms(JSON.stringify(searchableBody))),
  };
}

function pageSelectionDescriptors(dashboard) {
  const cached = pageSelectionDescriptorsByDashboard.get(dashboard);
  if (cached) return cached;
  const descriptors = dashboard.dashboard.pages.map((page, index) =>
    pageSelectionDescriptor(page, index)
  );
  pageSelectionDescriptorsByDashboard.set(dashboard, descriptors);
  return descriptors;
}

function pageSelectionScore(page, changedFiles) {
  let score = 0;

  for (const { pathSegmentKeys, terms } of changedFiles) {
    if (page.pageIdKey && pathSegmentKeys.has(page.pageIdKey)) {
      score += pageSelectionWeights.pathIncludesPageId;
    }
    for (const term of terms) {
      if (page.pageTerms.has(term)) {
        score += pageSelectionWeights.pageIdTerm;
      } else if (page.titleTerms.has(term)) {
        score += pageSelectionWeights.titleTerm;
      } else if (page.pageBodyTerms.has(term)) {
        score += pageSelectionWeights.pageBodyTerm;
      }
    }
  }
  return score;
}

/**
 * Rank candidate dashboard page IDs for PR assessment. Broad candidates,
 * including shared dashboard configuration changes, are intentionally capped:
 * the workflow assesses the highest-scoring views instead of every page.
 * The result drops ignored assessment pages, deduplicates candidates, sorts by
 * changed-file relevance with dashboard order as the stable tie-breaker, and
 * truncates to the requested limit.
 */
export function rankDashboardPageIds({
  dashboard,
  pageIds,
  changedFiles,
  limit = maximumSelectedDashboardPageCount,
}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Dashboard page selection limit must be a positive integer.");
  }
  const pagesById = new Map(pageSelectionDescriptors(dashboard).map((page) => [page.pageId, page]));
  const changedFileDescriptors = changedFiles.map((path) => ({
    pathSegmentKeys: new Set(path.split(/[\\/]+/).map(identifierKey).filter(Boolean)),
    terms: new Set(identifierTerms(path)),
  }));
  return withoutIgnoredDashboardPageIds([...new Set(pageIds)])
    .map((pageId) => pagesById.get(pageId))
    .filter(Boolean)
    .map((page) => ({
      pageId: page.pageId,
      index: page.index,
      score: pageSelectionScore(page, changedFileDescriptors),
    }))
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.pageId);
}

function pagesUsingElement(dashboard, element) {
  return pageSelectionDescriptors(dashboard)
    .filter((page) => page.pageJson.includes(`"element":"${element}"`))
    .map((page) => page.pageId);
}

function canScopeComponent(path) {
  const absolutePath = join(repositoryRoot, path);
  let source;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch {
    return false;
  }
  const exports = [
    ...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g),
  ];
  if (exports.length !== 1) return false;

  const sourceRoot = join(repositoryRoot, "dashboard/site/src");
  const candidates = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name));
  const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
  for (const candidate of candidates) {
    if (candidate === absolutePath) continue;
    const importsTarget = [...readFileSync(candidate, "utf8").matchAll(importPattern)]
      .some((match) => resolve(dirname(candidate), match[1]) === absolutePath);
    if (importsTarget && candidate !== join(sourceRoot, "components/ui-elements.js")) return false;
  }
  return true;
}

export function selectAffectedPageIds({ dashboard, changedFiles, baseRef }) {
  const allPageIds = withoutIgnoredDashboardPageIds(
    dashboard.dashboard.pages.map((page) => page.id),
  );
  const selected = new Set();
  const ranked = (pageIds, options = {}) =>
    rankDashboardPageIds({ dashboard, pageIds, changedFiles, ...options });

  for (const path of changedFiles) {
    if (path.endsWith("/dashboard.json") || path === primaryDashboardPath) {
      const current = readDashboard(path);
      const previous = readDashboard(path, baseRef);
      // Shared configuration can affect any page, but PR assessment remains
      // bounded to the top-ranked sample to keep the live-data browser job fast.
      if (sharedDashboardConfigurationChanged(current, previous)) return ranked(allPageIds);
      for (const pageId of changedDashboardPageIds(current, previous)) selected.add(pageId);
      continue;
    }
    if (path.startsWith("dashboard/site/src/components/") && path.endsWith(".js")) {
      const element = basename(path, ".js");
      const matchingPages = pagesUsingElement(dashboard, element);
      if (matchingPages.length > 0 && canScopeComponent(path)) {
        for (const pageId of matchingPages) selected.add(pageId);
        continue;
      }
    }
    if (
      path === ".github/workflows/dashboard-views.yml"
      || path === "tests/playwright/configs/dashboard-views.config.mjs"
      || path === "tests/e2e/dashboard-view-data.mjs"
      || path === "tests/e2e/dashboard-view-sources.mjs"
      || path === "tests/e2e/dashboard-views-live.spec.mjs"
      || path === "tests/e2e/dashboard-view-selection.mjs"
      || path === "package.json"
      || path === "package-lock.json"
      || path === "dashboard/site/package.json"
      || path === "dashboard/site/package-lock.json"
      || path === "dashboard/local-server.mjs"
      || path === "dashboard/report/compose-dashboard-documents.mjs"
      || path === "dashboard/report/bundle-dashboards.mjs"
      || path === "dashboard/site/index.html"
      || path.startsWith("dashboard/site/src/")
      || path.startsWith("dashboard/report/")
    ) {
      return ranked(allPageIds);
    }
  }
  return withoutIgnoredDashboardPageIds(allPageIds.filter((pageId) => selected.has(pageId)));
}

function main() {
  const [baseRef, headRef = "HEAD"] = process.argv.slice(2);
  if (!baseRef) throw new Error("usage: dashboard-view-selection.mjs BASE_REF [HEAD_REF]");
  const paths = dashboardPaths();
  const dashboard = composedDashboard(paths);
  const changedFiles = execFileSync("git", ["diff", "--name-only", `${baseRef}...${headRef}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const pageIds = selectAffectedPageIds({ dashboard, changedFiles, baseRef });
  process.stdout.write(`page-ids=${pageIds.join(",")}\n`);
  process.stdout.write(`page-count=${pageIds.length}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
