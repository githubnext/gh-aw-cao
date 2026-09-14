import { deriveDataHealthSources } from "../../dashboard/site/src/data-health.js";
import { readFileSync } from "node:fs";
import { processDataRequest } from "../../dashboard/site/src/data-worker.js";

const dashboard = JSON.parse(readFileSync(
  new URL("../../dashboard/site/dashboard.json", import.meta.url),
)).dashboard;

function declaredSourceNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) declaredSourceNames(item, names);
  } else if (value && typeof value === "object") {
    if (typeof value.source === "string") names.add(value.source);
    for (const item of Object.values(value)) declaredSourceNames(item, names);
  }
  return names;
}

export function effectiveDashboardSources(rawSources) {
  const derivedSources = processDataRequest({
    operation: "execute-dashboard-queries",
    queries: dashboard.queries,
    sources: rawSources,
    sourceNames: dashboard.queries.map((query) => query.name),
  });
  const dataHealthSources = deriveDataHealthSources(rawSources);
  return {
    ...derivedSources,
    ...Object.fromEntries(
      Object.entries(dataHealthSources).filter(([name]) => name.startsWith("data-health-")),
    ),
  };
}

export function missingDashboardSources(pageDefinition, sources) {
  return [...declaredSourceNames(pageDefinition)]
    .filter((sourceName) =>
      !Object.hasOwn(sources, sourceName)
      || sources[sourceName]?.metadata?.availability === "unavailable"
    )
    .map((sourceName) => `${sourceName}: missing or unavailable`);
}
