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
import { runMode } from "./mode.mjs";
import { runOperationalValueCommand } from "./operational-value.mjs";
import { runPruneDashboard } from "./prune-dashboard.mjs";
import { runQuery } from "./query.mjs";
import { runSetupAuth } from "./setup-auth.mjs";
import { runUpdate } from "./update.mjs";

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
  ["mode", runMode],
  ["operational-value", runOperationalValueCommand],
  ["prune-dashboard", runPruneDashboard],
  ["query", runQuery],
  ["setup-auth", runSetupAuth],
  ["update", runUpdate],
]);
