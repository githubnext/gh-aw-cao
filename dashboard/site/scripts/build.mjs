import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleDashboardFiles } from "../../report/bundle-dashboards.mjs";
import { configureSite } from "../../report/configure-site.mjs";

const siteRoot = new URL("../", import.meta.url);
const execFileAsync = promisify(execFile);
const localJavaScriptReference = /((?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+|new URL\(\s*)["'])(\.{1,2}\/[^"'?#]+\.js)(["'])/g;

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
  const sha = await resolveBuildSha(repositoryPath);

  await rm(destinationPath, { force: true, recursive: true });
  await mkdir(destinationPath, { recursive: true });
  await Promise.all([
    cp(new URL("index.html", siteRoot), join(destinationPath, "index.html")),
    cp(new URL("favicon.svg", siteRoot), join(destinationPath, "favicon.svg")),
    cp(new URL("manifest.webmanifest", siteRoot), join(destinationPath, "manifest.webmanifest")),
    cp(new URL("service-worker.js", siteRoot), join(destinationPath, "service-worker.js")),
    cp(new URL("dashboard.json", siteRoot), join(destinationPath, "dashboard.json")),
    cp(new URL("src", siteRoot), join(destinationPath, "src"), { recursive: true }),
  ]);

  const indexPath = join(destinationPath, "index.html");
  const configuredIndex = configureSite(await readFile(indexPath, "utf8"), controlSettings);
  await writeFile(indexPath, configuredIndex.replace("./src/main.js", `./src/main.js?sha=${encodeURIComponent(sha)}`));
  await stampJavaScriptModules(destinationPath, sha);

  const packageDashboards = [];
  for (const packageName of Object.keys(controlSettings.packages ?? {}).toSorted()) {
    const source = join(repositoryPath, packageName, "dashboard.json");
    await access(source).then(() => packageDashboards.push(source)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  const dashboardPath = join(destinationPath, "dashboard.json");
  await bundleDashboardFiles(dashboardPath, packageDashboards);
  const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));

  for (const page of dashboard.dashboard?.pages ?? []) {
    if (typeof page?.id !== "string" || !page.id || requiresHashQueryParameter(page)) continue;
    const routeDirectory = join(destinationPath, page.id);
    await mkdir(routeDirectory, { recursive: true });
    await writeFile(join(routeDirectory, "index.html"), redirectDocument(page.id));
  }
}

async function resolveBuildSha(repositoryPath) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
  return stdout.trim();
}

async function stampJavaScriptModules(directory, sha) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await stampJavaScriptModules(path, sha);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const source = await readFile(path, "utf8");
      await writeFile(path, source.replace(
        localJavaScriptReference,
        `$1$2?sha=${encodeURIComponent(sha)}$3`,
      ));
    }
  }
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
  if (!destination || !settingsPath) {
    throw new Error("usage: build.mjs <destination> <control-settings.json>");
  }
  const controlSettings = JSON.parse(await readFile(resolve(settingsPath), "utf8"));
  await buildDashboardSite({ destination, controlSettings });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}