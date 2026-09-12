import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    cp(new URL("src", siteRoot), join(destinationPath, "src"), { recursive: true }),
  ]);

  const indexPath = join(destinationPath, "index.html");
  await writeFile(indexPath, configureSite(await readFile(indexPath, "utf8"), controlSettings));
  await cacheBustSiteImports(destinationPath);

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

async function cacheBustSiteImports(destinationPath) {
  const sourceRoot = join(destinationPath, "src");
  const sourceFiles = await listFiles(sourceRoot);
  const hashes = new Map();

  for (const sourceFile of sourceFiles) {
    const contents = await readFile(join(sourceRoot, sourceFile));
    hashes.set(sourceFile, createHash("sha256").update(contents).digest("hex"));
  }

  for (const sourceFile of sourceFiles.filter((file) => file.endsWith(".js"))) {
    const sourcePath = join(sourceRoot, sourceFile);
    const contents = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, rewriteLocalReferences(contents, sourcePath, sourceRoot, hashes));
  }

  const indexPath = join(destinationPath, "index.html");
  const index = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    index.replace(
      /(<script\b[^>]*\bsrc=["'])(\.\/src\/main\.js)(["'][^>]*>)/,
      `$1$2?sha=${hashes.get("main.js")}$3`,
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

function rewriteLocalReferences(source, sourcePath, sourceRoot, hashes) {
  const rewrite = (match, prefix, quote, specifier, suffix = "") => {
    const target = relative(sourceRoot, resolve(dirname(sourcePath), specifier));
    const hash = hashes.get(target);
    return hash ? `${prefix}${quote}${specifier}?sha=${hash}${quote}${suffix}` : match;
  };

  return source
    .replace(
      /^(\s*import\s+(?:[^"'()]*?\s+from\s+)?)(["'])(\.{1,2}\/[^"'?#]+)(?:\?[^"']*)?\2/gm,
      (match, prefix, quote, specifier) => rewrite(match, prefix, quote, specifier),
    )
    .replace(
      /^(\s*export\s+(?:\*|\{[^}]*\})\s+from\s+)(["'])(\.{1,2}\/[^"'?#]+)(?:\?[^"']*)?\2/gm,
      (match, prefix, quote, specifier) => rewrite(match, prefix, quote, specifier),
    )
    .replace(
      /(\b(?:import|new\s+URL)\s*\(\s*)(["'])(\.{1,2}\/[^"'?#]+)(?:\?[^"']*)?\2(\s*,?)/g,
      (match, prefix, quote, specifier, suffix, offset) => {
        const linePrefix = source.slice(source.lastIndexOf("\n", offset) + 1, offset);
        return /^\s*(?:\/\/|\/?\*)/.test(linePrefix)
          ? match
          : rewrite(match, prefix, quote, specifier, suffix);
      },
    );
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