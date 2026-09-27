import { describeAgentQueries } from "../agent-catalog.mjs";

export function runQueries({ options, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["dashboard", "json"]);
  return describeAgentQueries({
    dashboardPath: options.dashboard,
    json: options.json === "true",
  });
}
