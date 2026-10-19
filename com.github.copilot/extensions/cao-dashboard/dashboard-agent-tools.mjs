import { readFile } from "node:fs/promises";
import { resolveBundledResource } from "./bundled-resources.mjs";
import { callOperator } from "./operator.mjs";

const maximumSpecificationLines = 400;

export async function executeDashboardQueryRequest({
  queries,
  sources,
  requested,
}) {
  return callOperator(["dashboard", "evaluate"], JSON.stringify({ queries, sources, requested }));
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
