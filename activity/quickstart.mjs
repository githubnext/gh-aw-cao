import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activityWorkflowStats } from './cli/activity-stats.mjs';
import { addCaoCampaign } from './cli/campaigns.mjs';
import { commandFailureMessage, writeJsonAtomically } from './cli/files.mjs';
import { configureDashboardPages } from './setup.mjs';
import { installedCaoRevision } from '../.github/workflows/shared/materialize-cao.mjs';

const SAMPLE_REPOSITORY_NAME = 'cao-sample';
const DEFAULT_CAMPAIGN = 'githubnext/gh-aw-cao/bug-bash';
const BUG_BASH_WORKFLOW = 'bug-bash.lock.yml';
const BUG_BASH_WORKER = 'bug-bash-investigation.lock.yml';
const VALIDATION_WORKFLOW = 'cao-validate.yml';
const ACTIVITY_WORKFLOW = 'cao-activity.yml';
const DASHBOARD_WORKFLOW = 'cao-dashboard.yml';
const QUICKSTART_DIRECTORIES = ['.github', 'activity', 'dashboard', 'bug-bash'];
const QUICKSTART_PATHS = [
  ...QUICKSTART_DIRECTORIES,
  'cao.sh',
  '.gitattributes',
  '.vscode/settings.json',
];
const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const SAMPLE_DESCRIPTION = 'Disposable CAO quickstart sample with intentional bugs for Bug Bash.';
const SAMPLE_SOURCE_IMPORT = '../src/checkout.mjs';
const SAMPLE_FILES = {
  'README.md': `# CAO sample

> [!WARNING]
> This repository intentionally contains bugs for the Central Agentic Ops
> quickstart. Do not use its code in production.

This small checkout calculator demonstrates a bounded Bug Bash review. Orders
may contain multiple units of an item, discounts are percentages, and inventory
must be positive before an order can ship.
`,
  'package.json': `${JSON.stringify({
    name: 'cao-sample',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2)}\n`,
  'src/checkout.mjs': `export function calculateOrderTotal(items, discountPercent = 0) {
  const subtotal = items.reduce((total, item) => total + Number(item.price), 0);
  return Math.max(0, subtotal - discountPercent);
}

export function canShip(inventoryCount) {
  return inventoryCount >= 0;
}
`,
  'test/checkout.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateOrderTotal, canShip } from '${SAMPLE_SOURCE_IMPORT}';

test('calculates an undiscounted single-item order', () => {
  assert.equal(calculateOrderTotal([{ price: 12.5, quantity: 1 }]), 12.5);
});

test('ships an item with available inventory', () => {
  assert.equal(canShip(1), true);
});
`,
};

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

export async function createQuickstartSampleRepository({
    repository,
    user,
    execute = spawnSync,
    temporaryDirectoryRoot = tmpdir(),
  }) {
    const temporaryDirectory = await mkdtemp(path.join(temporaryDirectoryRoot, 'cao-sample-'));
    const checkout = path.join(temporaryDirectory, repository.split('/')[1]);
    let repositoryCreated = false;
    try {
      run(execute, 'gh', [
        'repo', 'create', repository,
        '--public',
        '--clone',
        '--description', SAMPLE_DESCRIPTION,
      ], { cwd: temporaryDirectory });
      repositoryCreated = true;
      for (const [relativePath, content] of Object.entries(SAMPLE_FILES)) {
        const destination = path.join(checkout, relativePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      const branch = run(execute, 'gh', [
        'api', `repos/${repository}`,
        '--jq', '.default_branch',
      ]).stdout.trim() || 'main';
      run(execute, 'git', ['add', '--', ...Object.keys(SAMPLE_FILES)], { cwd: checkout });
      run(execute, 'git', ['branch', '-M', branch], { cwd: checkout });
      run(execute, 'git', [
        '-c', `user.name=${user.login}`,
        '-c', `user.email=${user.id}+${user.login}@users.noreply.github.com`,
        'commit', '--no-gpg-sign',
        '-m', 'Create CAO Bug Bash sample',
      ], { cwd: checkout });
      run(execute, 'git', ['push', '--set-upstream', 'origin', 'HEAD'], { cwd: checkout });
      return { repository, url: `https://github.com/${repository}` };
    } catch (error) {
      if (repositoryCreated) {
        throw new Error(`${error.message}\nThe public sample repository ${repository} was created but may be incomplete; inspect or delete it before retrying.`, { cause: error });
      }
      throw error;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function findRun({
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
    if (attempt + 1 < attempts) await pause(waitMilliseconds);
  }
  if (!required) return null;
  throw new Error(`Timed out waiting for ${workflow} to start`);
}

async function watchRun(
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
    if (attempt + 1 < attempts) await pause(waitMilliseconds);
  }
  throw new Error(`Timed out waiting for workflow run ${runRecord.url || runRecord.databaseId}`);
}

async function dispatchWorkflow({
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
    if (attempt + 1 < attempts) await pause(2000);
  }
  throw new Error(`gh ${arguments_.join(' ')} failed: ${commandFailureMessage(result, `exit ${result?.status ?? 'unknown'}`)}`);
}

export function formatQuickstartSummary(result) {
  return [
    'CAO quickstart complete.',
    `Dashboard: ${result.dashboard.url}`,
    `Target: https://github.com/${result.targetRepository}${result.sampleCreated ? ' (sample with intentional bugs)' : ''}`,
    `Bug Bash: ${result.bugBash.url} (${result.bugBash.conclusion})`,
    `Activity: ${result.activity.url} (${result.activity.uniqueRuns} collected runs)`,
    `Control repository: https://github.com/${result.controlRepository}`,
  ].join('\n');
}

async function executeCaoQuickstart({
  campaignSpec,
  targetRepository,
  policyPath = '.github/workflows/cao.json',
  execute = spawnSync,
  addCampaign = addCaoCampaign,
  configurePages = configureDashboardPages,
  collectActivityStats = activityWorkflowStats,
  progress,
  now = Date.now,
  pause = wait,
  resolveRootRevision = installedCaoRevision,
  createSampleTarget = createQuickstartSampleRepository,
  effects = {},
} = {}) {
  const ui = progress ?? {};

  const root = path.resolve(run(execute, 'git', ['rev-parse', '--show-toplevel']).stdout.trim());
  if (root !== path.resolve('.')) {
    throw new Error('Run CAO quickstart from the root of the control repository');
  }
  const head = execute('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  const hasHead = !head?.error && head?.status === 0;

  const repository = runJson(execute, 'gh', ['repo', 'view', '--json', 'nameWithOwner,visibility']);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository?.nameWithOwner || '')) {
    throw new Error('Unable to resolve the control repository');
  }
  const visibility = String(repository.visibility || '').toUpperCase();
  if (!['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(visibility)) {
    throw new Error('Unable to resolve the control repository visibility');
  }
  const controlRepository = repository.nameWithOwner;
  const branch = run(execute, 'gh', [
    'api', `repos/${controlRepository}`,
    '--jq', '.default_branch',
  ]).stdout.trim() || 'main';
  if (hasHead) {
    const currentBranch = run(execute, 'git', ['branch', '--show-current']).stdout.trim();
    if (!currentBranch || currentBranch !== branch) {
      throw new Error(`CAO quickstart requires the checked-out default branch ${branch}`);
    }
  }
  const initialStatus = run(execute, 'git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  initialStatus.map(repositoryPathFromStatus).forEach(assertQuickstartPath);
  if (initialStatus.some((line) => ![' ', '?'].includes(line[0]))) {
    throw new Error('CAO quickstart refuses pre-staged changes; unstage them and retry');
  }
  const user = runJson(execute, 'gh', ['api', 'user']);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(user?.login || '') || !Number.isSafeInteger(user?.id)) {
    throw new Error('Unable to resolve the signed-in GitHub user for the quickstart commit');
  }
  let selectedTarget = targetRepository;
  let sampleCreated = false;
  if (selectedTarget) {
    if (!REPOSITORY_COORDINATE.test(selectedTarget)) {
      throw new Error(`Quickstart target must use owner/repository format: ${selectedTarget}`);
    }
    const target = runJson(execute, 'gh', [
      'repo', 'view', selectedTarget,
      '--json', 'nameWithOwner,visibility',
    ]);
    if (!REPOSITORY_COORDINATE.test(target?.nameWithOwner || '') || String(target.visibility || '').toUpperCase() !== 'PUBLIC') {
      throw new Error(`Quickstart target must be an accessible public repository: ${selectedTarget}`);
    }
    selectedTarget = target.nameWithOwner;
  } else {
    selectedTarget = `${user.login}/${SAMPLE_REPOSITORY_NAME}`;
    const existingSample = execute('gh', ['api', `repos/${selectedTarget}`], { encoding: 'utf8' });
    if (!existingSample?.error && existingSample?.status === 0) {
      throw new Error(
        `Default sample repository ${selectedTarget} already exists. `
        + `Rerun with --target ${selectedTarget} to use it, or delete it before retrying.`,
      );
    }
    if (existingSample?.error || !/\bHTTP 404\b/.test(existingSample?.stderr || '')) {
      throw new Error(`Unable to verify that ${selectedTarget} is available: ${commandFailureMessage(existingSample, 'gh api failed')}`);
    }
  }

  await ui.step?.('Installing the review-only Bug Bash campaign (2 workflows)');
  const selectedCampaign = campaignSpec ?? `${DEFAULT_CAMPAIGN}@${resolveRootRevision('root', root)}`;
  await addCampaign(selectedCampaign, [], { policyPath, execute });
  const policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
  const campaign = policy['control-plane']?.campaigns?.['bug-bash'];
  if (!campaign?.workers?.investigation) {
    throw new Error('Bug Bash did not install its CAO campaign declaration');
  }
  if (!targetRepository) {
    await ui.step?.(`Creating the public sample target ${selectedTarget} with intentional bugs`);
    await createSampleTarget({
      repository: selectedTarget,
      user,
      execute,
    });
    sampleCreated = true;
    effects.sampleRepository = selectedTarget;
    ui.success?.(`Public sample target created: ${selectedTarget}`);
  }
  const controlOwner = controlRepository.split('/')[0];
  const targetOwner = selectedTarget.split('/')[0];
  policy['control-plane'].scope = {
    'allowed-owners': [...new Set([controlOwner, targetOwner])],
    'allowed-repositories': [...new Set([controlRepository, selectedTarget])],
  };
  policy['control-plane'].activity = { repositories: [controlRepository] };
  policy['control-plane'].campaigns['bug-bash'] = {
    ...campaign,
    icon: 'rocket',
    mode: 'review',
    'max-repositories': 1,
    'rollout-percent': 100,
    targets: { [selectedTarget]: { mode: 'review' } },
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
  ui.success?.(`Bug Bash campaign installed in review mode for ${selectedTarget}`);

  await ui.step?.('Configuring the public-read workflow token profile and dashboard Pages');
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

  await ui.step?.('Committing and pushing the bounded control-plane configuration');
  const bootstrapCreated = isoBefore(now);
  run(execute, 'git', ['add', '--', ...QUICKSTART_PATHS]);
  run(execute, 'git', ['diff', '--cached', '--check']);
  if (!hasHead) run(execute, 'git', ['branch', '-M', branch]);
  run(execute, 'git', [
    '-c', `user.name=${user.login}`,
    '-c', `user.email=${user.id}+${user.login}@users.noreply.github.com`,
    'commit', '--no-gpg-sign',
    '-m', 'Set up Central Agentic Ops quickstart',
  ]);
  run(execute, 'git', ['push', '--set-upstream', 'origin', 'HEAD']);
  ui.success?.(`Control plane pushed to ${controlRepository}`);

  await ui.step?.('Waiting for CAO validation');
  const validationRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: VALIDATION_WORKFLOW,
    event: 'push',
    created: bootstrapCreated,
    pause,
  });
  const validation = await watchRun(execute, controlRepository, validationRun, { pause });
  if (validation.conclusion !== 'success') {
    throw new Error(`CAO validation concluded ${validation.conclusion || validation.status}: ${validation.url}`);
  }
  ui.success?.('CAO validation completed');

  await ui.step?.('Waiting for the initial CAO Activity snapshot');
  const initialActivityRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    event: 'push',
    created: bootstrapCreated,
    pause,
  });
  const initialActivity = await watchRun(execute, controlRepository, initialActivityRun, { pause });
  if (initialActivity.conclusion !== 'success') {
    throw new Error(`Initial CAO Activity concluded ${initialActivity.conclusion || initialActivity.status}: ${initialActivity.url}`);
  }
  const initialStats = await collectActivityStats({
    repo: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    limit: 1,
  }, execute);
  if (initialStats.summary.runsWithArtifact !== 1 || initialStats.summary.totalUniqueRuns < 1) {
    throw new Error(`Initial CAO Activity completed without a data-bearing snapshot: ${initialActivity.url}`);
  }
  ui.success?.(`Initial Activity collected ${initialStats.summary.totalUniqueRuns} workflow runs`);

  await ui.step?.('Waiting for the initial dashboard deployment');
  const initialDashboardRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: DASHBOARD_WORKFLOW,
    event: 'workflow_run',
    created: bootstrapCreated,
    pause,
  });
  const initialDashboard = await watchRun(execute, controlRepository, initialDashboardRun, { pause });
  if (initialDashboard.conclusion !== 'success') {
    throw new Error(`Initial CAO Dashboard concluded ${initialDashboard.conclusion || initialDashboard.status}: ${initialDashboard.url}`);
  }
  ui.success?.('Control plane validated and initial dashboard deployed');

  const bugBashCreated = isoBefore(now);
  await ui.step?.('Running one bounded Bug Bash campaign in review mode (up to 700 AI credits)');
  await dispatchWorkflow({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKFLOW,
    branch,
    pause,
    fields: {
      target_repo: selectedTarget,
      safe_output_repo: controlRepository,
      max_repos: 1,
      rollout_percent: 100,
      safe_output_mode: 'review',
    },
  });
  const bugBashRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKFLOW,
    event: 'workflow_dispatch',
    created: bugBashCreated,
    titleIncludes: selectedTarget,
    pause,
  });
  const bugBash = await watchRun(execute, controlRepository, bugBashRun, { pause });
  if (bugBash.conclusion === 'success') ui.success?.('Bug Bash orchestrator completed');
  else ui.warning?.(`Bug Bash orchestrator concluded ${bugBash.conclusion || bugBash.status}`);

  await ui.step?.('Waiting for one bounded Bug Bash investigation');
  const workerRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: BUG_BASH_WORKER,
    event: 'workflow_dispatch',
    created: bugBashCreated,
    titleIncludes: selectedTarget,
    attempts: 15,
    pause,
    required: false,
  });
  let worker;
  if (workerRun) {
    worker = await watchRun(execute, controlRepository, workerRun, { pause });
    if (worker.conclusion === 'success') ui.success?.('Bug Bash investigation completed');
    else ui.warning?.(`Bug Bash investigation concluded ${worker.conclusion || worker.status}`);
  } else {
    ui.warning?.('Bug Bash dispatched no investigation; Activity will retain the orchestrator outcome');
  }

  const requestId = `quickstart-${bugBash.databaseId}`;
  const activityCreated = isoBefore(now);
  await ui.step?.('Collecting the first CAO Activity snapshot');
  await dispatchWorkflow({
    execute,
    repository: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    branch,
    pause,
    fields: { 'request-id': requestId },
  });
  const activityRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: ACTIVITY_WORKFLOW,
    event: 'workflow_dispatch',
    created: activityCreated,
    titleIncludes: requestId,
    pause,
  });
  const activity = await watchRun(execute, controlRepository, activityRun, { pause });
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

  await ui.step?.('Waiting for the data-bearing dashboard deployment');
  const dashboardRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: DASHBOARD_WORKFLOW,
    event: 'workflow_run',
    created: activityCreated,
    pause,
  });
  const dashboard = await watchRun(execute, controlRepository, dashboardRun, { pause });
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
    targetRepository: selectedTarget,
    sampleCreated,
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
  const ui = options.progress
    ?? (await import('./setup-prompt.mjs')).createQuickstartProgress();
  const effects = {};
  ui.start?.();
  try {
    return await executeCaoQuickstart({ ...options, progress: ui, effects });
  } catch (error) {
    ui.failure?.();
    if (effects.sampleRepository) {
      throw new Error(
        `${error.message}\nThe public sample repository ${effects.sampleRepository} remains in place. `
        + `Inspect or delete it before retrying, or rerun with --target ${effects.sampleRepository}.`,
        { cause: error },
      );
    }
    throw error;
  }
}
