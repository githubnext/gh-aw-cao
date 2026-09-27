import { runActivityStats } from "./activity-stats.mjs";
import { runAdd } from "./add.mjs";
import { runAuditJsonl } from "./audit-jsonl.mjs";
import { runClusterProblems } from "./cluster-problems.mjs";
import { runCompactJsonl } from "./compact-jsonl.mjs";
import { runComputation } from "./computation.mjs";
import { runDashboardComplexity } from "./dashboard-complexity.mjs";
import { runDisable } from "./disable.mjs";
import { runDiscoverWorkflows } from "./discover-workflows.mjs";
import { runDoctor } from "./doctor.mjs";
import { runDownload } from "./download.mjs";
import { runEnable } from "./enable.mjs";
import { runGh } from "./gh.mjs";
import { runHashPayloads } from "./hash-payloads.mjs";
import { runIngestJsonl } from "./ingest-jsonl.mjs";
import { runIngest } from "./ingest.mjs";
import { runInit } from "./init.mjs";
import { runIssueStatus } from "./issue-status.mjs";
import { runMcp } from "./mcp.mjs";
import { runMode } from "./mode.mjs";
import { runOperationalValueCommand } from "./operational-value.mjs";
import { runPages } from "./pages.mjs";
import { runPruneDashboard } from "./prune-dashboard.mjs";
import { runQueries } from "./queries.mjs";
import { runQueryInfo } from "./query-info.mjs";
import { runQuery } from "./query.mjs";
import { runSetup } from "./setup.mjs";
import { runSetupAuth } from "./setup-auth.mjs";
import { runUpdate } from "./update.mjs";
import { runUpgradeGhAw } from "./upgrade-gh-aw.mjs";
import { runValidateActivityData } from "./validate-activity-data.mjs";

export const commandHandlers = new Map([
  ["activity-stats", runActivityStats],
  ["add", runAdd],
  ["audit-jsonl", runAuditJsonl],
  ["cluster-problems", runClusterProblems],
  ["compact-jsonl", runCompactJsonl],
  ["computation", runComputation],
  ["dashboard-complexity", runDashboardComplexity],
  ["disable", runDisable],
  ["discover-workflows", runDiscoverWorkflows],
  ["doctor", runDoctor],
  ["download", runDownload],
  ["enable", runEnable],
  ["gh", runGh],
  ["hash-payloads", runHashPayloads],
  ["ingest", runIngest],
  ["ingest-jsonl", runIngestJsonl],
  ["init", runInit],
  ["issue-status", runIssueStatus],
  ["mcp", runMcp],
  ["mode", runMode],
  ["operational-value", runOperationalValueCommand],
  ["pages", runPages],
  ["prune-dashboard", runPruneDashboard],
  ["queries", runQueries],
  ["query", runQuery],
  ["query-info", runQueryInfo],
  ["setup", runSetup],
  ["setup-auth", runSetupAuth],
  ["update", runUpdate],
  ["upgrade-gh-aw", runUpgradeGhAw],
  ["validate-activity-data", runValidateActivityData],
]);
