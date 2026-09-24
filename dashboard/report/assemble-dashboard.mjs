import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const dashboardSourcesFileName = "dashboard.sources.json";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeKeys(value, source, keyPath = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeKeys(entry, source, `${keyPath}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${source} contains an unsupported key at ${keyPath}.${key}`);
    }
    assertSafeKeys(child, source, `${keyPath}.${key}`);
  }
}

function mergeValues(current, addition, source, keyPath = "$") {
  if (current === undefined) return addition;
  if (Array.isArray(current) && Array.isArray(addition)) return [...current, ...addition];
  if (isObject(current) && isObject(addition)) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(addition)) {
      merged[key] = mergeValues(merged[key], value, source, `${keyPath}.${key}`);
    }
    return merged;
  }
  throw new Error(`${source} conflicts with an earlier dashboard source at ${keyPath}`);
}

export async function dashboardSourcePaths(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  if (!isObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${absoluteManifestPath} must declare version 1 and a non-empty files array`);
  }

  const root = await realpath(path.dirname(absoluteManifestPath));
  const sources = [];
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file)) {
      throw new Error(`${absoluteManifestPath} contains an invalid dashboard source path`);
    }
    const requestedSource = path.resolve(root, file);
    const relative = path.relative(root, requestedSource);
    if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(requestedSource) !== ".json") {
      throw new Error(`${absoluteManifestPath} contains an invalid dashboard source path: ${file}`);
    }
    const source = await realpath(requestedSource);
    const realRelative = path.relative(root, source);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`${absoluteManifestPath} contains a dashboard source outside its directory: ${file}`);
    }
    if (seen.has(source)) throw new Error(`${absoluteManifestPath} contains a duplicate dashboard source: ${file}`);
    seen.add(source);
    sources.push(source);
  }
  return sources;
}

export async function assembleDashboardDocument(manifestPath) {
  let assembled = {};
  for (const source of await dashboardSourcePaths(manifestPath)) {
    const fragment = JSON.parse(await readFile(source, "utf8"));
    if (!isObject(fragment)) throw new Error(`${source} must contain a JSON object`);
    assertSafeKeys(fragment, source);
    assembled = mergeValues(assembled, fragment, source);
  }
  return assembled;
}

export async function loadDashboardDocument(dashboardPath) {
  const absoluteDashboardPath = path.resolve(dashboardPath);
  const manifestPath = path.join(path.dirname(absoluteDashboardPath), dashboardSourcesFileName);
  try {
    await access(manifestPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return JSON.parse(await readFile(absoluteDashboardPath, "utf8"));
  }
  return assembleDashboardDocument(manifestPath);
}

async function main([manifestPath, outputPath]) {
  if (!manifestPath || !outputPath) {
    throw new Error("usage: assemble-dashboard.mjs DASHBOARD_SOURCES OUTPUT_DASHBOARD");
  }
  const assembled = await assembleDashboardDocument(manifestPath);
  await writeFile(path.resolve(outputPath), `${JSON.stringify(assembled, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
