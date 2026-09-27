import { describeAgentQueries } from "../agent-catalog.mjs";

export function runQueryInfo({ options, positional, rejectUnknownOptions, UsageError }) {
  rejectUnknownOptions(options, ["dashboard", "json"]);
  if (!positional) throw new UsageError("cao query-info requires a query identifier");
  return describeAgentQueries({
    dashboardPath: options.dashboard,
    queryId: positional,
    json: options.json === "true",
  });
}
