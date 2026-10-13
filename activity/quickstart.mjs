import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { activityWorkflowStats } from './cli/activity-stats.mjs';
import { addCaoCampaign } from './cli/campaigns.mjs';
import { commandFailureMessage, writeJsonAtomically } from './cli/files.mjs';
import { configureDashboardPages } from './setup.mjs';
import { createQuickstartProgress } from './setup-prompt.mjs';
import { installedCaoRevision } from '../.github/workflows/shared/materialize-cao.mjs';

const STARTER_REPOSITORY = 'githubnext/gh-aw-cao';
const DEFAULT_CAMPAIGN = 'githubnext/gh-aw-cao/bug-bash';
const BUG_BASH_WORKFLOW = 'bug-bash.lock.yml';
const BUG_BASH_WORKER = 'bug-bash-investigation.lock.yml';
const ACTIVITY_WORKFLOW = 'cao-activity.yml';
const DASHBOARD_WORKFLOW = 'cao-dashboard.yml';
const QUICKSTART_DIRECTORIES = ['.github', 'activity', 'dashboard', 'bug-bash'];
const QUICKSTART_PATHS = [...QUICKSTART_DIRECTORIES, 'cao.sh', '.gitattributes'];

function resultText(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim();
}

function run(execute, command, arguments_, options = {}) {
  const result = execute(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(`${command} ${arguments_.join(' ')} failed: ${commandFailureMessage(result, `exit ${result?.status ?? 'unknown'}`)}`);
  }
  return result;
}

function runJson(execute, command, arguments_) {
  const result = run(execute, command, arguments_);
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (error) {
    throw new Error(`${command} ${arguments_.join(' ')} returned invalid JSON: ${error.message}`);
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function repositoryPathFromStatus(line) {
  const value = line.slice(3).trim();
  const pathValue = value.includes(' -> ') ? value.split(' -> ').at(-1) : value;
  return pathValue.replace(/^"|"$/g, '');
}

function assertQuickstartPath(file) {
  if (QUICKSTART_PATHS.includes(file) || QUICKSTART_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`))) {
    return;
  }
  throw new Error(`Quickstart refuses to commit unrelated path: ${file}`);
}

function isoBefore(now, milliseconds = 5000) {
  return new Date(now() - milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function listRuns(execute, repository, workflow, event, created) {
  const runs = runJson(execute, 'gh', [
    'run', 'list',
    '--repo', repository,
    '--workflow', workflow,
    '--event', event,
    '--created', `>=${created}`,
    '--limit', '20',
    '--json', 'databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url',
  ]);
  if (!Array.isArray(runs)) throw new Error(`gh run list returned invalid data for ${workflow}`);
  return runs;
}

function findRun({
  execute,
  repository,
  workflow,
  event,
  created,
  titleIncludes = '',
  attempts = 30,
  waitMilliseconds = 2000,
  pause = wait,
  required = true,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runs = listRuns(execute, repository, workflow, event, created)
      .filter((run) => !titleIncludes || String(run.displayTitle || '').includes(titleIncludes))
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
    if (runs[0]) return runs[0];
    if (attempt + 1 < attempts) pause(waitMilliseconds);
  }
  if (!required) return null;
  throw new Error(`Timed out waiting for ${workflow} to start`);
}

function watchRun(
  execute,
  repository,
  runRecord,
  { pause = wait, attempts = 1080, waitMilliseconds = 5000 } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = runJson(execute, 'gh', [
      'run', 'view', String(runRecord.databaseId),
      '--repo', repository,
      '--json', 'databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url',
    ]);
    if (current?.status === 'completed') return current;
    if (attempt + 1 < attempts) pause(waitMilliseconds);
  }
  throw new Error(`Timed out waiting for workflow run ${runRecord.url || runRecord.databaseId}`);
}

function dispatchWorkflow({
  execute,
  repository,
  workflow,
  branch,
  fields,
  pause = wait,
  attempts = 30,
}) {
  const arguments_ = [
    'workflow', 'run', workflow,
    '--repo', repository,
    '--ref', branch,
    ...Object.entries(fields).flatMap(([name, value]) => ['--raw-field', `${name}=${value}`]),
  ];
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = execute('gh', arguments_, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (!result?.error && result?.status === 0) return;
    if (attempt + 1 < attempts) pause(2000);
  }
  throw new Error(`gh ${arguments_.join(' ')} failed: ${commandFailureMessage(result, `exit ${result?.status ?? 'unknown'}`)}`);
}

function quickstartProgress(progress) {
  return progress ?? createQuickstartProgress();
}

export function formatQuickstartSummary(result) {
  return [
    'CAO quickstart complete.',
    `Dashboard: ${result.dashboard.url}`,
    `Bug Bash: ${result.bugBash.url} (${result.bugBash.conclusion})`,
    `Activity: ${result.activity.url} (${result.activity.uniqueRuns} collected runs)`,
    `Control repository: https://github.com/${result.controlRepository}`,
  ].join('\n');
}

async function executeCaoQuickstart({
  campaignSpec,
  policyPath = '.github/workflows/cao.json',
  execute = spawnSync,
  addCampaign = addCaoCampaign,
  configurePages = configureDashboardPages,
  collectActivityStats = activityWorkflowStats,
  progress,
  now = Date.now,
  pause = wait,
  resolveRootRevision = installedCaoRevision,
} = {}) {
  const ui = quickstartProgress(progress);

  const root = path.resolve(run(execute, 'git', ['rev-parse', '--show-toplevel']).stdout.trim());
  if (root !== path.resolve('.')) {
    throw new Error('Run CAO quickstart from the root of its newly created control repository');
  }
  const head = execute('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  if (!head?.error && head?.status === 0) {
    throw new Error('CAO quickstart requires a new control repository with no commits');
  }

  const repository = runJson(execute, 'gh', ['repo', 'view', '--json', 'nameWithOwner,visibility']);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository?.nameWithOwner || '')) {
    throw new Error('Unable to resolve the new control repository');
  }
  if (repository.visibility !== 'PRIVATE') {
    throw new Error('CAO quickstart requires a private control repository');
  }
  const controlRepository = repository.nameWithOwner;
  const user = runJson(execute, 'gh', ['api', 'user']);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(user?.login || '') || !Number.isSafeInteger(user?.id)) {
    throw new Error('Unable to resolve the signed-in GitHub user for the quickstart commit');
  }

  ui.step?.('Installing the review-only Bug Bash campaign (2 workflows)');
  const selectedCampaign = campaignSpec ?? `${DEFAULT_CAMPAIGN}@${resolveRootRevision('root', root)}`;
  await addCampaign(selectedCampaign, [], { policyPath, execute });
  const policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
  const campaign = policy['control-plane']?.campaigns?.['bug-bash'];
  if (!campaign?.workers?.investigation) {
    throw new Error('Bug Bash did not install its CAO campaign declaration');
  }
  const controlOwner = controlRepository.split('/')[0];
  policy['control-plane'].scope = {
    'allowed-owners': [...new Set([controlOwner, 'githubnext'])],
    'allowed-repositories': [controlRepository, STARTER_REPOSITORY],
  };
  policy['control-plane'].activity = { repositories: [controlRepository] };
  policy['control-plane'].campaigns['bug-bash'] = {
    ...campaign,
    icon: 'rocket',
    mode: 'review',
    'max-repositories': 1,
    'rollout-percent': 100,
    targets: { [STARTER_REPOSITORY]: { mode: 'review' } },
    workers: {
      investigation: {
        ...campaign.workers.investigation,
        'max-mode': 'review',
      },
    },
  };
  await writeJsonAtomically(path.resolve(policyPath), policy);
  run(execute, process.execPath, [
    '.github/workflows/shared/control.mjs',
    'validate-policy',
    policyPath,
  ]);
  ui.success?.('Bug Bash campaign installed in review mode for one public starter repository');

  ui.step?.('Configuring the public-read workflow token profile and dashboard Pages');
  const pages = configurePages({ repository: controlRepository, execute });
  if (!pages.public) {
    throw new Error('CAO quickstart requires public GitHub Pages; use ./cao.sh setup for a private dashboard profile');
  }
  run(execute, 'gh', [
    'variable', 'set', 'GH_AW_GITHUB_AUTH_MODE',
    '--repo', controlRepository,
    '--body', 'workflow-token',
  ]);
  ui.success?.('Dashboard Pages source configured for public access');

  const status = run(execute, 'git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  if (status.length === 0) throw new Error('Quickstart produced no files to commit');
  status.map(repositoryPathFromStatus).forEach(assertQuickstartPath);

  ui.step?.('Committing and pushing the bounded control-plane configuration');
  run(execute, 'git', ['add', '--', ...QUICKSTART_PATHS]);
  run(execute, 'git', ['diff', '--cached', '--check']);
  const branch = run(execute, 'gh', [
    'api', `repos/${controlRepository}`,
    '--jq', '.default_branch',
  ]).stdout.trim() || 'main';
  run(execute, 'git', ['branch', '-M', branch]);
  run(execute, 'git', [
    '-c', `user.name=${user.login}`,
    '-c', `user.email=${user.id}+${user.login}@users.noreply.github.com`,
    'commit', '--no-gpg-sign',
    '-m', 'Set up Central Agentic Ops quickstart',
  ]);
  run(execute, 'git', ['push', '--set-upstream', 'origin', 'HEAD']);
  ui.success?.(`Control plane pushed to ${controlRepository}`);

  const bugBashCreated = isoBefore(now);
  ui.step?.('Running one bounded Bug Bash investigation in review mode (up to 700 AI credits)');
  dispatchWorkflow({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKFLOW,
    branch,
    pause,
    fields: {
      target_repo: STARTER_REPOSITORY,
      safe_output_repo: controlRepository,
      max_repos: 1,
      rollout_percent: 100,
      safe_output_mode: 'review',
    },
  });
  const bugBashRun = findRun({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKFLOW,
    event: 'workflow_dispatch',
    created: bugBashCreated,
    titleIncludes: STARTER_REPOSITORY,
    pause,
  });
  const bugBash = watchRun(execute, controlRepository, bugBashRun, { pause });
  if (bugBash.conclusion === 'success') ui.success?.('Bug Bash orchestrator completed');
  else ui.warning?.(`Bug Bash orchestrator concluded ${bugBash.conclusion || bugBash.status}`);

  ui.step?.('Waiting for one bounded Bug Bash investigation');
  const workerRun = findRun({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKER,
    event: 'workflow_dispatch',
    created: bugBashCreated,
    titleIncludes: STARTER_REPOSITORY,
    attempts: 15,
    pause,
    required: false,
  });
  let worker;
  if (workerRun) {
    worker = watchRun(execute, controlRepository, workerRun, { pause });
    if (worker.conclusion === 'success') ui.success?.('Bug Bash investigation completed');
    else ui.warning?.(`Bug Bash investigation concluded ${worker.conclusion || worker.status}`);
  } else {
    ui.warning?.('Bug Bash dispatched no investigation; Activity will retain the orchestrator outcome');
  }

  const requestId = `quickstart-${bugBash.databaseId}`;
  const activityCreated = isoBefore(now);
  ui.step?.('Collecting the first CAO Activity snapshot');
  dispatchWorkflow({
    execute,
    repository: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    branch,
    pause,
    fields: { 'request-id': requestId },
  });
  const activityRun = findRun({
    execute,
    repository: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    event: 'workflow_dispatch',
    created: activityCreated,
    titleIncludes: requestId,
    pause,
  });
  const activity = watchRun(execute, controlRepository, activityRun, { pause });
  if (activity.conclusion !== 'success') {
    throw new Error(`CAO Activity concluded ${activity.conclusion || activity.status}: ${activity.url}`);
  }
  const stats = await collectActivityStats({
    repo: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    limit: 1,
  }, execute);
  if (stats.summary.runsWithArtifact !== 1 || stats.summary.totalUniqueRuns < 1) {
    throw new Error(`CAO Activity completed without a data-bearing snapshot: ${activity.url}`);
  }
  ui.success?.(`Activity collected ${stats.summary.totalUniqueRuns} workflow runs`);

  ui.step?.('Waiting for the data-bearing dashboard deployment');
  const dashboardRun = findRun({
    execute,
    repository: controlRepository,
    workflow: DASHBOARD_WORKFLOW,
    event: 'workflow_run',
    created: activityCreated,
    pause,
  });
  const dashboard = watchRun(execute, controlRepository, dashboardRun, { pause });
  if (dashboard.conclusion !== 'success') {
    throw new Error(`CAO Dashboard concluded ${dashboard.conclusion || dashboard.status}: ${dashboard.url}`);
  }
  const deployedPages = runJson(execute, 'gh', ['api', `repos/${controlRepository}/pages`]);
  const dashboardUrl = deployedPages?.html_url || pages.url;
  if (!dashboardUrl) throw new Error('CAO Dashboard deployed, but GitHub returned no Pages URL');
  ui.finish?.(`Dashboard ready: ${dashboardUrl}`);

  return {
    command: 'quickstart',
    controlRepository,
    starterRepository: STARTER_REPOSITORY,
    campaign: 'bug-bash',
    mode: 'review',
    dashboard: {
      url: dashboardUrl,
      workflowRun: dashboard.url,
      visibility: deployedPages.public === false ? 'private' : 'public',
    },
    bugBash: {
      runId: bugBash.databaseId,
      url: bugBash.url,
      conclusion: bugBash.conclusion,
      ...(worker ? {
        workerRunId: worker.databaseId,
        workerUrl: worker.url,
        workerConclusion: worker.conclusion,
      } : {}),
    },
    activity: {
      runId: activity.databaseId,
      url: activity.url,
      uniqueRuns: stats.summary.totalUniqueRuns,
    },
  };
}

export async function runCaoQuickstart(options = {}) {
  const ui = quickstartProgress(options.progress);
  ui.start?.();
  try {
    return await executeCaoQuickstart({ ...options, progress: ui });
  } catch (error) {
    ui.failure?.();
    throw error;
  }
}
