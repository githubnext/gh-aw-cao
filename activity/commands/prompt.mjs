import { loadAgentDashboardDocument, parseNamedQueryParameters, runNamedDashboardQuery } from "../agent-catalog.mjs";
import { describeQuery } from "../../dashboard/site/src/agent/catalog.js";
import { resolveNamedQueryParameters } from "../../dashboard/site/src/agent/query-executor.js";
import { effectiveViewSemantics } from "../../dashboard/site/src/view-semantics.js";
import { semanticViewPrompt } from "../../dashboard/site/src/semantic-view-prompt.js";

export async function runPrompt({ options, positional, indexedDB, rejectUnknownOptions, UsageError }) {
  rejectUnknownOptions(options, ["dashboard", "database", "param"]);
  if (!positional) throw new UsageError("cao prompt requires a query identifier");
  const document = await loadAgentDashboardDocument(options.dashboard);
  const query = describeQuery(document, positional);
  if (!query) throw new UsageError(`Unknown dashboard query: ${positional}`);
  const queryParameters = parseNamedQueryParameters(options.param);
  resolveNamedQueryParameters(document, positional, queryParameters);
  const dependencies = effectiveViewSemantics({ data: { source: positional } }, document.dashboard.queries);
  const semantics = {
    queryIds: dependencies.queryIds,
    subject: query.subject,
    objective: query.objective ?? "",
    acceptance: query.acceptance ?? ""
  };
  const result = indexedDB
    ? await runNamedDashboardQuery({
        indexedDB, dashboardPath: options.dashboard, queryId: positional,
        parameters: queryParameters, limit: 9
      })
    : null;
  return semanticViewPrompt({
    queryId: positional,
    semantics,
    queryParameters,
    filters: {},
    scope: {},
    sources: result ? { [positional]: {
      rows: result.rows,
      metadata: result.metadata,
      continuationToken: result.metadata.completeness === "partial" ? "more" : undefined
    } } : {}
  });
}
