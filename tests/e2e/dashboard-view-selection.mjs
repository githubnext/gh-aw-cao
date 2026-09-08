import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { composeDashboardDocuments } from "../../dashboard/report/compose-dashboard-documents.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const primaryDashboardPath = "dashboard/site/dashboard.json";

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

function pagesUsingElement(dashboard, element) {
  return dashboard.dashboard.pages
    .filter((page) => JSON.stringify(page).includes(`"element":"${element}"`))
    .map((page) => page.id);
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
  const allPageIds = dashboard.dashboard.pages.map((page) => page.id);
  const selected = new Set();

  for (const path of changedFiles) {
    if (path.endsWith("/dashboard.json") || path === primaryDashboardPath) {
      const current = readDashboard(path);
      const previous = readDashboard(path, baseRef);
      if (sharedDashboardConfigurationChanged(current, previous)) return allPageIds;
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
      || path === "playwright.dashboard-views.config.mjs"
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
      return allPageIds;
    }
  }
  return allPageIds.filter((pageId) => selected.has(pageId));
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
