import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleDashboardFiles } from "../../report/bundle-dashboards.mjs";
import { configureSite } from "../../report/configure-site.mjs";

const siteRoot = new URL("../", import.meta.url);

export async function buildDashboardSite({
  destination,
  controlSettings,
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
    cp(new URL("manifest.webmanifest", siteRoot), join(destinationPath, "manifest.webmanifest")),
    cp(new URL("service-worker.js", siteRoot), join(destinationPath, "service-worker.js")),
    cp(new URL("dashboard.json", siteRoot), join(destinationPath, "dashboard.json")),
    cp(new URL("src/smells.svg", siteRoot), join(destinationPath, "smells.svg")),
    cp(new URL("src", siteRoot), join(destinationPath, "src"), { recursive: true }),
  ]);

  const indexPath = join(destinationPath, "index.html");
  await writeFile(indexPath, configureSite(await readFile(indexPath, "utf8"), controlSettings));

  const packageDashboards = await findPackageDashboards(repositoryPath, controlSettings);

  const dashboardPath = join(destinationPath, "dashboard.json");
  await bundleDashboardFiles(dashboardPath, packageDashboards);
  await bundleSiteJavascript(destinationPath);
  await cacheBustSiteImports(destinationPath);
  const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));

  for (const page of dashboard.dashboard?.pages ?? []) {
    if (typeof page?.id !== "string" || !page.id || requiresHashQueryParameter(page)) continue;
    const routeDirectory = join(destinationPath, page.id);
    await mkdir(routeDirectory, { recursive: true });
    await writeFile(join(routeDirectory, "index.html"), redirectDocument(page.id));
  }
}

async function findPackageDashboards(repositoryPath, controlSettings) {
  const installedDashboardsPath = join(repositoryPath, "dashboards");
  try {
    return (await readdir(installedDashboardsPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(installedDashboardsPath, entry.name));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const packageDashboards = [];
  for (const packageName of Object.keys(controlSettings.packages ?? {}).toSorted()) {
    const source = join(repositoryPath, packageName, "dashboard.json");
    await access(source).then(() => packageDashboards.push(source)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return packageDashboards;
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
  const index = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    index.replace(
      /(<script\b[^>]*\bsrc=["'])(\.\/src\/main\.js)(["'][^>]*>)/,
      `$1$2?sha=${sha}$3`,
    ),
  );
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

async function main([destination, settingsPath]) {
  const controlSettings = settingsPath
    ? JSON.parse(await readFile(resolve(settingsPath), "utf8"))
    : {};
  await buildDashboardSite({ destination: destination ?? new URL("dist/", siteRoot), controlSettings });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}