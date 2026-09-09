import { deriveDataHealthSources } from "../../dashboard/site/src/data-health.js";
import { deriveOverviewSources } from "../../dashboard/site/src/overview-data.js";
import { deriveRepositorySources } from "../../dashboard/site/src/repository-data.js";
import { deriveRuntimeSources } from "../../dashboard/site/src/runtime-data.js";
import { deriveWorkflowSources } from "../../dashboard/site/src/workflow-data.js";

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
  const derivedSources = deriveRuntimeSources(deriveRepositorySources(deriveOverviewSources(deriveWorkflowSources(rawSources))));
  const dataHealthSources = deriveDataHealthSources(rawSources);
  return {
    ...derivedSources,
    ...Object.fromEntries(Object.entries(dataHealthSources).filter(([name]) => name.startsWith("data-health-"))),
  };
}

export function missingDashboardSources(pageDefinition, sources) {
  return [...declaredSourceNames(pageDefinition)]
    .filter((sourceName) => !Object.hasOwn(sources, sourceName) || sources[sourceName]?.metadata?.availability === "unavailable")
    .map((sourceName) => `${sourceName}: missing or unavailable`);
}
