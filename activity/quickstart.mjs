import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { activityWorkflowStats } from './cli/activity-stats.mjs';
import { addCaoCampaign } from './cli/campaigns.mjs';
import { commandFailureMessage, writeJsonAtomically } from './cli/files.mjs';
import { configureDashboardPages } from './setup.mjs';
import { installedCaoRevision } from '../.github/workflows/shared/materialize-cao.mjs';

const SAMPLE_SEED_REPOSITORY = 'github/gh-aw';
const DEFAULT_CAMPAIGN = 'githubnext/gh-aw-cao/repo-assist';
const REPO_ASSIST_WORKFLOW = 'repo-assist.lock.yml';
const REPO_ASSIST_WORKER = 'repo-assist-maintenance.lock.yml';
const ACTIVITY_WORKFLOW = 'cao-activity.yml';
const DASHBOARD_WORKFLOW = 'cao-dashboard.yml';
const QUICKSTART_DIRECTORIES = ['.github', 'activity', 'dashboard', 'repo-assist'];
const QUICKSTART_PATHS = [
  ...QUICKSTART_DIRECTORIES,
  'cao.sh',
  '.gitattributes',
  '.vscode/settings.json',
];
const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export const QUICKSTART_STARTER_TARGET = Object.freeze({
  repository: SAMPLE_SEED_REPOSITORY,
});

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
  if (result.step) {
    return [
      `CAO quickstart ${result.step}: ${result.status}.`,
      result.context,
      `Control repository: ${result.controlRepository} (default branch: ${result.branch})`,
      ...(result.actionsUrl ? [`Actions: ${result.actionsUrl}`] : []),
      ...(result.dashboard?.url ? [`Dashboard: ${result.dashboard.url}`] : []),
      ...(result.inspectCommand ? [`Inspect: ${result.inspectCommand}`] : []),
      `Next: ${result.nextCommand}`,
    ].join('\n');
  }
  return [
    'CAO quickstart complete.',
    `Dashboard: ${result.dashboard.url}`,
    `Target: https://github.com/${result.targetRepository}${result.starterTarget ? ' (public Repo Assist example)' : ''}`,
    `Repo Assist: ${result.repoAssist.url} (${result.repoAssist.conclusion})`,
    ...(result.paused ? ['Repo Assist is paused; re-enable it explicitly for further runs and the six-hour schedule.'] : []),
    `Activity: ${result.activity.url} (${result.activity.uniqueRuns} collected runs)`,
    `Control repository: https://github.com/${result.controlRepository}`,
  ].join('\n');
}

async function executeCaoQuickstart({
  wait: waitForCompletion = false,
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
  let selectedTarget = targetRepository ?? SAMPLE_SEED_REPOSITORY;
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
  const starterTarget = selectedTarget === SAMPLE_SEED_REPOSITORY;
  if (starterTarget) ui.success?.(`Repo Assist example selected: ${selectedTarget}`);

  await ui.step?.('Installing Repo Assist with only its existing maintenance worker enabled in review mode');
  const selectedCampaign = campaignSpec ?? `${DEFAULT_CAMPAIGN}@${resolveRootRevision('root', root)}`;
  await addCampaign(selectedCampaign, [], { policyPath, execute });
  run(execute, 'gh', [
    'aw', 'compile', '--strict', '--no-check-update',
    '--schedule-seed', 'githubnext/gh-aw-cao',
  ]);
  const policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
  const campaign = policy['control-plane']?.campaigns?.['repo-assist'];
  if (campaign?.workers?.maintenance?.workflow !== 'repo-assist-maintenance') {
    throw new Error('Repo Assist did not install its maintenance worker declaration');
  }
  const controlOwner = controlRepository.split('/')[0];
  const targetOwner = selectedTarget.split('/')[0];
  policy['control-plane'].scope = {
    'allowed-owners': [...new Set([controlOwner, targetOwner])],
    'allowed-repositories': [...new Set([controlRepository, selectedTarget])],
  };
  policy['control-plane'].activity = { repositories: [controlRepository] };
  policy['control-plane'].campaigns['repo-assist'] = {
    ...campaign,
    icon: 'gear',
    enabled: true,
    mode: 'review',
    'max-repositories': 1,
    'rollout-percent': 100,
    targets: { [selectedTarget]: { mode: 'review' } },
    workers: Object.fromEntries(Object.entries(campaign.workers).map(([key, worker]) => [
      key,
      {
        ...worker,
        enabled: key === 'maintenance',
        'max-mode': 'review',
      },
    ])),
  };
  await writeJsonAtomically(path.resolve(policyPath), policy);
  run(execute, process.execPath, [
    '.github/workflows/shared/control.mjs',
    'validate-policy',
    policyPath,
  ]);
  ui.success?.(`Repo Assist maintenance enabled in review mode for ${selectedTarget}; other workers remain disabled; proposals are optional, not requirements for CAO`);

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
  if (!waitForCompletion) {
    run(execute, 'gh', ['workflow', 'disable', REPO_ASSIST_WORKFLOW, '--repo', controlRepository]);
    const result = {
      command: 'quickstart', step: 'install', status: 'installed',
      controlRepository, branch, targetRepository: selectedTarget, paused: true,
      context: 'Installed review-only maintenance and public dashboard infrastructure. No work was dispatched. Repo Assist schedules are paused; the next stage explicitly requests one review.',
      nextCommand: './cao.sh quickstart --step run',
    };
    ui.finish?.('Install stage complete; no workflows dispatched.');
    return result;
  }

  const repoAssistCreated = isoBefore(now);
  await ui.step?.('Running Repo Assist in review mode (default budget up to 1,250 AI credits: 250 orchestration + 600 maintenance + 400 output checking; configured output-check limits may differ)');
  let dispatchError;
  try {
    await dispatchWorkflow({
      execute,
      repository: controlRepository,
      workflow: REPO_ASSIST_WORKFLOW,
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
  } catch (error) {
    dispatchError = error;
    throw error;
  } finally {
    await ui.step?.('Pausing Repo Assist after this dispatch to prevent recurring scheduled runs');
    try {
      run(execute, 'gh', ['workflow', 'disable', REPO_ASSIST_WORKFLOW, '--repo', controlRepository]);
    } catch (error) {
      if (dispatchError) {
        throw new AggregateError(
          [dispatchError, error],
          `${dispatchError.message}; pausing Repo Assist also failed: ${error.message}`,
        );
      }
      throw error;
    }
    ui.success?.('Repo Assist is paused; the requested run can finish. Re-enable it explicitly for further runs');
  }
  const repoAssistRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: REPO_ASSIST_WORKFLOW,
    event: 'workflow_dispatch',
    created: repoAssistCreated,
    titleIncludes: selectedTarget,
    pause,
  });
  const repoAssist = await watchRun(execute, controlRepository, repoAssistRun, { pause });
  if (repoAssist.conclusion === 'success') ui.success?.('Repo Assist orchestrator completed');
  else ui.warning?.(`Repo Assist orchestrator concluded ${repoAssist.conclusion || repoAssist.status}`);

  await ui.step?.('Waiting for a Repo Assist maintenance proposal or no-op');
  const workerRun = await findRun({
    execute,
    repository: controlRepository,
    workflow: REPO_ASSIST_WORKER,
    event: 'workflow_dispatch',
    created: repoAssistCreated,
    titleIncludes: selectedTarget,
    attempts: 15,
    pause,
    required: false,
  });
  let worker;
  if (workerRun) {
    worker = await watchRun(execute, controlRepository, workerRun, { pause });
    if (worker.conclusion === 'success') ui.success?.('Repo Assist maintenance completed (proposal or no-op; inspect the run outcome)');
    else ui.warning?.(`Repo Assist maintenance concluded ${worker.conclusion || worker.status}`);
  } else {
    ui.warning?.('Repo Assist dispatched no maintenance worker; Activity will retain the orchestrator outcome');
  }

  const requestId = `quickstart-${repoAssist.databaseId}`;
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
    starterTarget,
    campaign: 'repo-assist',
    mode: 'review',
    paused: true,
    dashboard: {
      url: dashboardUrl,
      workflowRun: dashboard.url,
      visibility: deployedPages.public === false ? 'private' : 'public',
    },
    repoAssist: {
      runId: repoAssist.databaseId,
      url: repoAssist.url,
      conclusion: repoAssist.conclusion,
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

async function installedQuickstartContext(execute, policyPath) {
  const root = run(execute, 'git', ['rev-parse', '--show-toplevel']).stdout.trim();
  if (path.resolve(root) !== path.resolve('.')) throw new Error('Run CAO quickstart from the root of the control repository');
  const repository = runJson(execute, 'gh', ['repo', 'view', '--json', 'nameWithOwner,visibility']);
  const controlRepository = repository?.nameWithOwner;
  if (!REPOSITORY_COORDINATE.test(controlRepository || '')) throw new Error('Unable to resolve the control repository');
  const branch = run(execute, 'gh', ['api', `repos/${controlRepository}`, '--jq', '.default_branch']).stdout.trim();
  if (!branch || run(execute, 'git', ['branch', '--show-current']).stdout.trim() !== branch) {
    throw new Error(`CAO quickstart requires the checked-out default branch ${branch}`);
  }
  const head = run(execute, 'git', ['rev-parse', '--verify', 'HEAD']).stdout.trim();
  const remoteHead = run(execute, 'gh', ['api', `repos/${controlRepository}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha']).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head) || head !== remoteHead) {
    throw new Error('CAO quickstart requires the pushed default-branch revision; synchronize your checkout first');
  }
  run(execute, 'git', ['diff', '--exit-code', 'HEAD', '--', policyPath, '.github/workflows']);
  run(execute, 'git', ['ls-files', '--error-unmatch', '--', policyPath]);
  // Validate the reviewed policy without rewriting it or inferring authority from credentials.
  run(execute, process.execPath, ['.github/workflows/shared/control.mjs', 'validate-policy', policyPath]);
  const policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
  const control = policy['control-plane'];
  const campaign = control?.campaigns?.['repo-assist'];
  const targets = Object.entries(campaign?.targets ?? {});
  const maintenance = campaign?.workers?.maintenance;
  if (campaign?.enabled !== true || campaign.mode !== 'review'
      || campaign['max-repositories'] !== 1 || campaign['rollout-percent'] !== 100
      || targets.length !== 1 || targets[0][1]?.mode !== 'review'
      || !REPOSITORY_COORDINATE.test(targets[0][0])
      || maintenance?.enabled !== true || maintenance['max-mode'] !== 'review'
      || maintenance.workflow !== 'repo-assist-maintenance'
      || Object.entries(campaign.workers).some(([name, worker]) => name !== 'maintenance' && worker.enabled !== false)) {
    throw new Error('Quickstart requires exactly one enabled review-only Repo Assist maintenance target and bounded rollout policy');
  }
  const targetRepository = targets[0][0];
  const scope = control.scope;
  const authorized = (repo) => scope?.['allowed-repositories']?.includes(repo)
    && scope?.['allowed-owners']?.includes(repo.split('/')[0]);
  if (!authorized(controlRepository) || !authorized(targetRepository)
      || control.mode === 'live'
      || control.activity?.repositories?.length !== 1
      || control.activity.repositories[0] !== controlRepository) {
    throw new Error('Quickstart policy must authorize the exact review target and collect only the control repository');
  }
  const target = runJson(execute, 'gh', ['repo', 'view', targetRepository, '--json', 'nameWithOwner,visibility']);
  if (target?.nameWithOwner !== targetRepository || String(target.visibility).toUpperCase() !== 'PUBLIC') {
    throw new Error('Quickstart target must remain an accessible public repository');
  }
  return { controlRepository, branch, targetRepository, dashboardDeploy: control.campaigns.dashboard?.deploy !== false };
}

function stageRuns(execute, repository, branch, workflow, event) {
  const records = runJson(execute, 'gh', [
    'run', 'list', '--repo', repository, '--branch', branch, '--workflow', workflow,
    ...(event ? ['--event', event] : []),
    '--limit', '20', '--json', 'databaseId,status,conclusion,createdAt,updatedAt,url',
  ]);
  if (!Array.isArray(records)) throw new Error(`Invalid run list for ${workflow}`);
  return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function executeQuickstartStage({
  step, execute = spawnSync, policyPath = '.github/workflows/cao.json',
  collectActivityStats = activityWorkflowStats, progress: ui,
}) {
  const context = await installedQuickstartContext(execute, policyPath);
  const { controlRepository: repository, branch, targetRepository } = context;
  const base = { command: 'quickstart', step, controlRepository: repository, branch, targetRepository };
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const actionsUrl = (workflow) => `${serverUrl}/${repository}/actions/workflows/${workflow}`;
  const inspectCommand = (workflow) => `gh run list --repo ${repository} --branch '${branch.replaceAll("'", "'\\''")}' --workflow ${workflow}`;
  if (step === 'run') {
    await ui.step?.('Requesting one review-only maintenance run; proposals are optional and a no-op is valid');
    let dispatchError;
    try {
      run(execute, 'gh', ['workflow', 'enable', REPO_ASSIST_WORKFLOW, '--repo', repository]);
      await dispatchWorkflow({
        execute, repository, workflow: REPO_ASSIST_WORKFLOW, branch, attempts: 1,
        fields: { target_repo: targetRepository, safe_output_repo: repository, max_repos: 1, rollout_percent: 100, safe_output_mode: 'review' },
      });
    } catch (error) {
      dispatchError = error;
      throw error;
    } finally {
      try {
        run(execute, 'gh', ['workflow', 'disable', REPO_ASSIST_WORKFLOW, '--repo', repository]);
      } catch (error) {
        if (dispatchError) throw new AggregateError([dispatchError, error], `${dispatchError.message}; pausing Repo Assist also failed: ${error.message}`);
        throw error;
      }
    }
    ui.finish?.('Review requested; Repo Assist schedules are paused.');
    return {
      ...base, status: 'dispatched', paused: true, actionsUrl: actionsUrl(REPO_ASSIST_WORKFLOW),
      context: 'One bounded review was requested. Inspect the orchestrator and completed maintenance proposal or no-op before collecting evidence. No target changes are applied.',
      inspectCommand: inspectCommand(REPO_ASSIST_WORKER),
      nextCommand: './cao.sh quickstart --step collect',
    };
  }
  if (step === 'collect') {
    const requestId = `quickstart-${randomUUID()}`;
    await ui.step?.('Collecting Activity evidence after you inspect the completed maintenance outcome');
    await dispatchWorkflow({ execute, repository, workflow: ACTIVITY_WORKFLOW, branch, attempts: 1, fields: { 'request-id': requestId } });
    ui.finish?.('Activity snapshot requested; collection continues in Actions.');
    return {
      ...base, status: 'dispatched', requestId, actionsUrl: actionsUrl(ACTIVITY_WORKFLOW),
      context: 'Activity collects workflow evidence; a successful workflow alone does not prove an accepted improvement. Inspect this snapshot before checking its dashboard deployment.',
      inspectCommand: inspectCommand(ACTIVITY_WORKFLOW),
      nextCommand: './cao.sh quickstart --step dashboard',
    };
  }
  const pending = (message) => {
    ui.finish?.(message);
    return {
      ...base, status: 'pending', context: message, actionsUrl: actionsUrl(ACTIVITY_WORKFLOW),
      inspectCommand: inspectCommand(ACTIVITY_WORKFLOW), nextCommand: './cao.sh quickstart --step dashboard',
    };
  };
  const activity = stageRuns(execute, repository, branch, ACTIVITY_WORKFLOW)[0];
  if (!context.dashboardDeploy) return pending('Standalone Pages deployment is disabled by policy. This read-only check cannot publish a dashboard.');
  if (activity?.status !== 'completed' || activity.conclusion !== 'success') {
    return pending('The latest default-branch Activity snapshot is not successfully completed. Inspect Actions, then retry this read-only check; no work was dispatched.');
  }
  const stats = await collectActivityStats({ repo: repository, workflow: ACTIVITY_WORKFLOW, runId: activity.databaseId, limit: 1 }, execute);
  if (stats.summary.runsWithArtifact !== 1 || stats.summary.totalUniqueRuns < 1
      || String(stats.runs?.[0]?.runId) !== String(activity.databaseId)) {
    return pending('The latest Activity snapshot has no verified data-bearing artifact. Inspect collection evidence and retry this read-only check.');
  }
  const dashboard = stageRuns(execute, repository, branch, DASHBOARD_WORKFLOW, 'workflow_run')
    .filter((record) => Date.parse(record.createdAt) >= Date.parse(activity.updatedAt))[0];
  if (dashboard?.status !== 'completed' || dashboard.conclusion !== 'success') {
    return pending('A successful dashboard deployment after the latest Activity snapshot is not ready. Retry this read-only check; no new collection was dispatched.');
  }
  const pages = runJson(execute, 'gh', ['api', `repos/${repository}/pages`]);
  if (!pages?.html_url || pages.public === false) return pending('No public deployed Pages URL is available yet. Inspect Pages and retry this read-only check.');
  ui.finish?.('Data-bearing dashboard deployment verified.');
  return {
    ...base, status: 'ready', context: 'Activity contains collected runs and its subsequent dashboard workflow succeeded. Explore the evidence; operational value still requires reviewing outcomes.',
    dashboard: { url: pages.html_url, workflowRun: dashboard.url },
    activity: { url: activity.url, uniqueRuns: stats.summary.totalUniqueRuns },
    nextCommand: `gh browse --repo ${repository} --actions`,
  };
}

export async function runCaoQuickstart(options = {}) {
  if (options.wait && options.step) throw new Error('--wait cannot be combined with --step');
  const step = options.step ?? 'install';
  if (!['install', 'run', 'collect', 'dashboard'].includes(step)) throw new Error('Invalid quickstart step');
  if (step !== 'install' && (options.targetRepository || options.campaignSpec)) {
    throw new Error('--target and --campaign are only valid for install or --wait');
  }
  const ui = options.progress
    ?? (await import('./setup-prompt.mjs')).createQuickstartProgress();
  ui.start?.();
  try {
    return await (step === 'install'
      ? executeCaoQuickstart({ ...options, progress: ui })
      : executeQuickstartStage({ ...options, step, progress: ui }));
  } catch (error) {
    ui.failure?.();
    throw error;
  }
}
