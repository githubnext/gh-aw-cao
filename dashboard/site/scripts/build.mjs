import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleDashboardFiles } from "../../report/bundle-dashboards.mjs";
import { configureSite } from "../../report/configure-site.mjs";
import { buildDashboardPageChunkPath, splitDashboardDocument } from "../src/dashboard-chunks.js";

const siteRoot = new URL("../", import.meta.url);

export async function buildDashboardSite({
  destination,
  controlSettings,
  commitSha,
  repositoryRoot = new URL("../../../", import.meta.url),
}) {
  if (!destination) throw new Error("dashboard destination is required");
  if (!controlSettings || typeof controlSettings !== "object" || Array.isArray(controlSettings)) {
    throw new Error("resolved control settings are required");
  }

  const destinationPath = destination instanceof URL ? fileURLToPath(destination) : resolve(destination);
  const repositoryPath = repositoryRoot instanceof URL ? fileURLToPath(repositoryRoot) : resolve(repositoryRoot);

  await rm(destinationPath, { force: true, recursive: true });
  await mkdir(destinationPath, { recursive: true });
  await Promise.all([
    cp(new URL("index.html", siteRoot), join(destinationPath, "index.html")),
    cp(new URL("favicon.svg", siteRoot), join(destinationPath, "favicon.svg")),
    cp(new URL("apple-touch-icon.png", siteRoot), join(destinationPath, "apple-touch-icon.png")),
    cp(new URL("icon-192.png", siteRoot), join(destinationPath, "icon-192.png")),
    cp(new URL("icon-512.png", siteRoot), join(destinationPath, "icon-512.png")),
    cp(new URL("icon-maskable-512.png", siteRoot), join(destinationPath, "icon-maskable-512.png")),
    cp(new URL("manifest.webmanifest", siteRoot), join(destinationPath, "manifest.webmanifest")),
    cp(new URL("service-worker.js", siteRoot), join(destinationPath, "service-worker.js")),
    cp(new URL("dashboard.json", siteRoot), join(destinationPath, "dashboard.json")),
    cp(new URL("src/smells.svg", siteRoot), join(destinationPath, "smells.svg")),
    cp(new URL("src", siteRoot), join(destinationPath, "src"), { recursive: true }),
  ]);

  const indexPath = join(destinationPath, "index.html");
  const configuredIndex = configureSite(await readFile(indexPath, "utf8"), controlSettings);
  await writeFile(indexPath, embedDashboardVersion(configuredIndex, commitSha));

  const campaignDashboards = await findCampaignDashboards(repositoryPath, controlSettings);

  const dashboardPath = join(destinationPath, "dashboard.json");
  await bundleDashboardFiles(dashboardPath, campaignDashboards);
  const dashboard = filterExperimentalDashboardViews(
    JSON.parse(await readFile(dashboardPath, "utf8")),
    controlSettings.web?.experimental === true,
  );
  const splitDashboard = splitDashboardDocument({
    languageVersion: dashboard["language-version"],
    dashboard: dashboard.dashboard,
  });
  await writeFile(dashboardPath, `${JSON.stringify(splitDashboard.core)}\n`);
  await writeDashboardPageChunks(destinationPath, splitDashboard.pageChunks);
  await bundleSiteJavascript(destinationPath);
  await cacheBustSiteImports(destinationPath);

  for (const page of splitDashboard.core.dashboard?.pages ?? []) {
    if (typeof page?.id !== "string" || !page.id || requiresHashQueryParameter(page)) continue;
    const routeDirectory = join(destinationPath, page.id);
    await mkdir(routeDirectory, { recursive: true });
    await writeFile(join(routeDirectory, "index.html"), redirectDocument(page.id));
  }

  async function writeDashboardPageChunks(destinationPath, pageChunks) {
    for (const [pageId, chunk] of pageChunks) {
      const relativeChunkPath = buildDashboardPageChunkPath(pageId);
      const absoluteChunkPath = join(destinationPath, relativeChunkPath);
      await mkdir(join(destinationPath, "dashboard-pages"), { recursive: true });
      await writeFile(absoluteChunkPath, `${JSON.stringify(chunk, null, 2)}\n`);
    }
  }
}

export function embedDashboardVersion(html, commitSha) {
  if (commitSha === undefined) return html;
  if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("dashboard commit SHA must be a 40-character lowercase hexadecimal string");
  }
  const declaration = '<meta name="dashboard-version" content="development">';
  if (!html.includes(declaration)) throw new Error("dashboard version declaration is missing");
  return html.replace(declaration, `<meta name="dashboard-version" content="${commitSha}">`);
}

export function filterExperimentalDashboardViews(document, enabled = false) {
  if (enabled || !Array.isArray(document.dashboard?.navigation)) return document;
  const experimentalPageIds = new Set(
    document.dashboard.navigation
      .filter((section) => section?.experimental === true)
      .flatMap((section) => Array.isArray(section.pages) ? section.pages : []),
  );
  if (experimentalPageIds.size === 0) return document;
  return {
    ...document,
    dashboard: {
      ...document.dashboard,
      pages: document.dashboard.pages.filter((page) => !experimentalPageIds.has(page.id)),
      navigation: document.dashboard.navigation.filter((section) => section?.experimental !== true),
      ...(Array.isArray(document.dashboard.callouts) ? {
        callouts: document.dashboard.callouts.filter((callout) => !experimentalPageIds.has(callout?.["navigation-page"])),
      } : {}),
    },
  };
}

async function findCampaignDashboards(repositoryPath, controlSettings) {
  const installedDashboardsPath = join(repositoryPath, "dashboards");
  try {
    return (await readdir(installedDashboardsPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(installedDashboardsPath, entry.name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const campaignDashboards = [];
  for (const campaignName of Object.keys(controlSettings.campaigns ?? {}).toSorted()) {
    const source = join(repositoryPath, campaignName, "dashboard.json");
    await access(source).then(() => campaignDashboards.push(source)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return campaignDashboards;
}

async function bundleSiteJavascript(destinationPath) {
  const bundlePath = join(destinationPath, ".bundle");
  try {
    await build({
      absWorkingDir: destinationPath,
      bundle: true,
      entryPoints: {
        main: "src/main.js",
        "data-worker": "src/data-worker.js",
      },
      entryNames: "[name]",
      format: "esm",
      legalComments: "none",
      minify: true,
      outdir: bundlePath,
      platform: "browser",
      sourcemap: true,
      target: "es2022",
    });

    for (const sourceFile of (await listFiles(join(destinationPath, "src")))
      .filter((file) => file.endsWith(".js"))) {
      await rm(join(destinationPath, "src", sourceFile));
    }
    await Promise.all([
      cp(join(bundlePath, "main.js"), join(destinationPath, "src", "main.js")),
      cp(join(bundlePath, "main.js.map"), join(destinationPath, "src", "main.js.map")),
      cp(join(bundlePath, "data-worker.js"), join(destinationPath, "src", "data-worker.js")),
      cp(join(bundlePath, "data-worker.js.map"), join(destinationPath, "src", "data-worker.js.map")),
    ]);
  } finally {
    await rm(bundlePath, { force: true, recursive: true });
  }
}

async function cacheBustSiteImports(destinationPath) {
  const siteFiles = await listFiles(destinationPath);
  const siteHash = createHash("sha256");

  for (const siteFile of siteFiles.toSorted()) {
    siteHash.update(siteFile).update("\0");
    siteHash.update(await readFile(join(destinationPath, siteFile))).update("\0");
  }
  const sha = siteHash.digest("hex");

  const indexPath = join(destinationPath, "index.html");
  const serviceWorkerPath = join(destinationPath, "service-worker.js");
  const index = await readFile(indexPath, "utf8");
  const serviceWorker = await readFile(serviceWorkerPath, "utf8");
  await Promise.all([
    writeFile(indexPath, index.replace(
      /(<script\b[^>]*\bsrc=["'])(\.\/src\/main\.js)(["'][^>]*>)/,
      `$1$2?sha=${sha}$3`,
    )),
    writeFile(
      serviceWorkerPath,
      serviceWorker.replace("const VERSION = 'development';", `const VERSION = '${sha}';`),
    ),
  ]);
}

async function listFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, root));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files;
}

function requiresHashQueryParameter(page) {
  const route = page.route;
  return typeof route === "object" && route !== null && typeof route["hash-query-parameter"] === "string";
}

function redirectDocument(pageId) {
  const hash = `#page-${encodeURIComponent(pageId)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=../${hash}" />
    <link rel="canonical" href="../" />
    <title>Central Agentic Ops Dashboard</title>
    <script>window.location.replace("../${hash}");</script>
  </head>
  <body>
    <p>Redirecting to the <a href="../${hash}">dashboard</a>.</p>
  </body>
</html>
`;
}

async function main([destination, settingsPath, commitSha]) {
  const controlSettings = settingsPath
    ? JSON.parse(await readFile(resolve(settingsPath), "utf8"))
    : {};
  await buildDashboardSite({
    destination: destination ?? new URL("dist/", siteRoot),
    controlSettings,
    commitSha,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}