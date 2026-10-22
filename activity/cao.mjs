#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { formatSetupAuthenticationSummary } from './authentication.mjs';
import { runCli } from './cli/run.mjs';

export { setupCaoControlPlane } from './setup.mjs';
export { formatSetupAuthenticationSummary } from './authentication.mjs';
export { initializeCaoPolicy } from './cli/policy.mjs';
export { addCaoRepository } from './cli/repositories.mjs';
export { ensureGhAwMinimumVersion, upgradeGhAw } from './cli/gh-aw.mjs';
export { fineGrainedTokenSetups, setupCaoAuthentication } from './cli/authentication.mjs';
export { addCaoCampaign, updateCaoCampaigns, setCaoCampaignMode, setCaoCampaignWorkflowsEnabled } from './cli/campaigns.mjs';
export { compactJsonlShards } from './cli/jsonl.mjs';
export { downloadDeployedDashboardData } from './cli/download.mjs';
export { ingestGhAwLogDirectory } from './cli/ingestion.mjs';
export { activityWorkflowStats } from './cli/activity-stats.mjs';
export { queryCanonicalData, queryGhData } from './cli/queries.mjs';
export { issueStatusQuery, updateIssueStatuses } from './cli/issue-status.mjs';
export { discoverWorkflows, pruneDashboardFile, analyzeDashboardComplexityFile } from './cli/dashboard.mjs';
export { runCli } from './cli/run.mjs';

async function main() {
  const arguments_ = process.argv.slice(2);
  const controller = new AbortController();
  let terminationSignal;
  const terminate = (signal) => {
    terminationSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  const onSigint = () => terminate('SIGINT');
  const onSigterm = () => terminate('SIGTERM');
  if (arguments_[0] === 'operational-value' || arguments_[0] === 'cluster-problems') {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  try {
    const output = await runCli(arguments_, process.stdin, { signal: controller.signal });
    if (typeof output === 'object' && output?.command === 'validate') {
      process.stdout.write(`${output.output}\n`);
      process.exitCode = output.exitCode;
      return;
    }
    if (typeof output === 'object'
      && output?.command === 'setup-auth'
      && !arguments_.includes('--dry-run')) {
      process.stdout.write(`${formatSetupAuthenticationSummary(output)}\n`);
      return;
    }
    if (typeof output === 'object' && output?.command === 'setup' && !arguments_.includes('--json')) {
      if (!output.cancelled) {
        process.stdout.write('Next: gh cao doctor\nThen review git diff and git status, commit, and push the installed files.\nCheck the CAO validation workflow in Actions after publishing.\nMonitoring is configured; executing operations is optional.\nDescribe the outcome, target scope, and execution requirements: https://githubnext.github.io/gh-cao/operation-patterns/\n');
      }
      return;
    }
    process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
    if (typeof output === 'object' && output?.command === 'repair-database' && !output.healthy) process.exitCode = 2;
  } catch (error) {
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
    process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    const message = process.env.CAO_DEBUG === '1' && error instanceof Error && error.stack
      ? error.stack
      : `Error: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
