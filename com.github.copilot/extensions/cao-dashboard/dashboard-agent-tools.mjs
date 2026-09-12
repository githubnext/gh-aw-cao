import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const maximumSpecificationLines = 400;
const maximumToolResultBytes = 1_000_000;

export async function executeDashboardQueryRequest({
  workingDirectory,
  queries,
  sources,
  requested,
}) {
  const queryEnginePath = await findFirstExistingPath([
    join(
      workingDirectory,
      "dashboard",
      "site",
      "src",
      "data",
      "queries",
      "declarative.js",
    ),
    join(
      workingDirectory,
      ".github",
      "aw",
      "dashboard",
      "site",
      "src",
      "data",
      "queries",
      "declarative.js",
    ),
    resolve(
      extensionDirectory,
      "../../../dashboard/site/src/data/queries/declarative.js",
    ),
  ]);
  const queryEngine = await import(pathToFileURL(queryEnginePath).href);
  if (typeof queryEngine.executeDashboardQueries !== "function") {
    throw new Error(
      "Dashboard query module does not export executeDashboardQueries.",
    );
  }

  const normalizedSources = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      normalizeLogicalSource(name, source),
    ]),
  );
  const originalTime = console.time;
  const originalTimeEnd = console.timeEnd;
  console.time = () => {};
  console.timeEnd = () => {};
  let result;
  try {
    result = queryEngine.executeDashboardQueries(
      queries,
      normalizedSources,
      requested,
    );
  } finally {
    console.time = originalTime;
    console.timeEnd = originalTimeEnd;
  }

  const serialized = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(serialized) > maximumToolResultBytes) {
    throw new Error(
      "Dashboard query result exceeds 1 MB. Add a query limit or request fewer queries.",
    );
  }
  return serialized;
}

export async function readDashboardDataSpecification({
  workingDirectory,
  startLine = 1,
  endLine = startLine + 199,
}) {
  if (endLine < startLine) {
    throw new Error("endLine must be greater than or equal to startLine.");
  }
  if (endLine - startLine + 1 > maximumSpecificationLines) {
    throw new Error(
      `A specification read is limited to ${maximumSpecificationLines} lines.`,
    );
  }
  const specificationPath = await findFirstExistingPath([
    join(workingDirectory, "specs", "dashboard-data.md"),
    join(
      workingDirectory,
      ".github",
      "aw",
      "dashboard",
      "specs",
      "dashboard-data.md",
    ),
    resolve(extensionDirectory, "../../../specs/dashboard-data.md"),
  ]);
  const lines = (await readFile(specificationPath, "utf8")).split("\n");
  const boundedStart = Math.min(startLine, lines.length + 1);
  const boundedEnd = Math.min(endLine, lines.length);
  const content = lines
    .slice(boundedStart - 1, boundedEnd)
    .map((line, index) => `${boundedStart + index}: ${line}`)
    .join("\n");
  return JSON.stringify(
    {
      path: specificationPath,
      startLine: boundedStart,
      endLine: boundedEnd,
      totalLines: lines.length,
      content,
    },
    null,
    2,
  );
}

function normalizeLogicalSource(name, input) {
  if (Array.isArray(input)) {
    return {
      source: name,
      rows: input,
      metadata: {
        "source-id": name,
        availability: "available",
        completeness: "complete",
        freshness: "unknown",
      },
    };
  }
  if (!input || typeof input !== "object" || !Array.isArray(input.rows)) {
    throw new Error(
      `Dashboard logical source "${name}" must be an array or an object with a rows array.`,
    );
  }
  return {
    ...input,
    source: typeof input.source === "string" ? input.source : name,
    metadata: {
      "source-id": name,
      availability: "available",
      completeness: "complete",
      freshness: "unknown",
      ...(input.metadata ?? {}),
    },
  };
}

async function findFirstExistingPath(candidates) {
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported installation layout.
    }
  }
  throw new Error(
    `Could not find a dashboard resource. Checked: ${candidates.join(", ")}`,
  );
}
