import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveBundledResource } from "./bundled-resources.mjs";

const maximumSpecificationLines = 400;
const maximumToolResultBytes = 1_000_000;

export async function executeDashboardQueryRequest({
  queries,
  sources,
  requested,
}) {
  const queryEnginePath = await resolveBundledResource("queryEngine");
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
  const specificationPath = await resolveBundledResource("dataSpecification");
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
