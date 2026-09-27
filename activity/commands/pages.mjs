import { describeAgentPages } from "../agent-catalog.mjs";

export function runPages({ options, positional, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["dashboard", "json"]);
  return describeAgentPages({
    dashboardPath: options.dashboard,
    pageId: positional,
    json: options.json === "true",
  });
}
