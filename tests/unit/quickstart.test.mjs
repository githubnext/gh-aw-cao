import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  formatQuickstartSummary,
  runCaoQuickstart,
} from '../../activity/quickstart.mjs';
import { runQuickstart as runQuickstartCommand } from '../../activity/commands/quickstart.mjs';
import { createQuickstartProgress } from '../../activity/setup-prompt.mjs';
import { runTerminal } from '../helpers/terminal.mjs';

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

for (const options of [{}, { step: 'install' }, { wait: true }, { targetRepository: '' }, { targetRepository: 'not-a-coordinate' }]) {
  test(`quickstart requires an explicit target before any operation: ${JSON.stringify(options)}`, async () => {
    await assert.rejects(runCaoQuickstart({
      ...options,
      execute() { assert.fail('must not execute commands'); },
      addCampaign() { assert.fail('must not install'); },
      configurePages() { assert.fail('must not configure Pages'); },
      progress: { start() { assert.fail('must not start'); } },
    }), /require explicit --target OWNER\/REPO/);
  });
}

for (const arguments_ of [
  [], ['--wait'], ['--step', 'install'], ['--json'], ['--target', 'not-a-coordinate'],
  ['--step'], ['--step', 'unknown'], ['--step', 'run', '--wait'],
  ['--step', 'collect', '--target', 'acme/project'],
  ['--step', 'dashboard', '--campaign', 'example'],
  ['--step', 'run', '--step', 'collect'], ['--wait', '--wait'], ['--watch'],
]) {
  test(`quickstart rejects invalid flags: ${arguments_.join(' ')}`, () => {
    assert.throws(() => runQuickstartCommand({
      arguments_, UsageError: Error, runCaoQuickstart() { assert.fail('must not execute'); },
    }));
  });
}

test('quickstart command forwards explicit stage and legacy wait', async () => {
  for (const [arguments_, expected] of [
    [['--step', 'run', '--json'], { step: 'run', progress: {} }],
    [['--wait', '--target', 'acme/project'], { wait: true, targetRepository: 'acme/project' }],
    [['--step', 'install', '--target', 'acme/project', '--campaign', 'example'], { step: 'install', targetRepository: 'acme/project', campaignSpec: 'example' }],
  ]) {
    let actual;
    await runQuickstartCommand({ arguments_, UsageError: Error, runCaoQuickstart(value) { actual = value; } });
    assert.deepEqual(actual, expected);
  }
});

test('quickstart command forwards an explicit target and JSON progress', async () => {
  let options;
  await runQuickstartCommand({
    arguments_: ['--target', 'acme/project', '--json'],
    runCaoQuickstart: async (value) => { options = value; },
    UsageError: Error,
  });
  assert.deepEqual(options, {
    targetRepository: 'acme/project',
    progress: {},
  });
});

test('plain quickstart progress starts with the first operation', () => {
  let output = '';
  const progress = createQuickstartProgress({
    input: { isTTY: false },
    output: { isTTY: false, write: (value) => { output += value; } },
  });

  progress.start();
  progress.step('Installing Repo Assist');
  progress.success('Repo Assist campaign installed');
  progress.finish('Dashboard ready');

  assert.equal(output, [
    '==> Installing Repo Assist',
    'OK: Repo Assist campaign installed',
    'Dashboard ready',
    '',
  ].join('\n'));
  assert.doesNotMatch(output, /Complete the CAO quickstart/);
});

test('plain quickstart explanations remain readable without styling or prompts', async () => {
  let output = '';
  const progress = createQuickstartProgress({
    input: { isTTY: false },
    output: { isTTY: false, write: (value) => { output += value; } },
    environment: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  progress.note('Control: acme/cao\nTarget: acme/project\nPUBLIC dashboard; review-only outputs.', '1/5 · Repositories');
  await progress.step('Installing');
  progress.success('Installed');
  progress.note('Inspect the policy before requesting work.', 'Checkpoint');
  progress.finish('Next stage is explicit');
  assert.equal(output, [
    '1/5 · Repositories',
    'Control: acme/cao',
    'Target: acme/project',
    'PUBLIC dashboard; review-only outputs.',
    '==> Installing',
    'OK: Installed',
    'Checkpoint',
    'Inspect the policy before requesting work.',
    'Next stage is explicit',
    '',
  ].join('\n'));
  assert.doesNotMatch(output, /\u001b|\r/);
});

test('styled quickstart progress renders immediately without a UI dependency', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-quickstart-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'driver.mjs');
  await writeFile(driver, `
import { createQuickstartProgress } from ${JSON.stringify(pathToFileURL(path.resolve('activity/setup-prompt.mjs')).href)};
const progress = createQuickstartProgress();
await progress.step('Installing Repo Assist campaign');
progress.success('Repo Assist campaign installed');
progress.note('Control: acme/cao. Target: acme/project. Policy: .github/workflows/cao.json. Authentication: workflow-token. The dashboard and its published evidence are PUBLIC even when the control repository is private.', '4/5 · Authentication and hosting');
await progress.step('Continuing installation');
progress.finish('Dashboard ready');
`);
  const result = await runTerminal(process.execPath, [driver], {
    cwd: directory,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      ACCESSIBLE: '',
      NO_COLOR: '',
      CI: '',
    },
  });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Installing Repo Assist campaign · 0s elapsed/);
  assert.match(result.stdout, /Repo Assist campaign installed \[0s\]/);
  assert.match(result.stdout, /4\/5 · Authentication and hosting/);
  assert.match(result.stdout, /Authentication: workflow-token\. The dashboard and its published evidence are PUBLIC even when the control repository is private\./);
  assert.ok(result.stdout.indexOf('4/5') < result.stdout.indexOf('Continuing installation'));
  assert.match(result.stdout, /Dashboard ready/);
});

async function quickstartFixture(t, {
  status = '?? .github/workflows/cao.json\n?? cao.sh\n?? .gitattributes\n?? .vscode/settings.json\n',
  headStatus = 128,
  visibility = 'PRIVATE',
  currentBranch = 'main',
  defaultBranch = 'main',
  diffCheck = success(),
  targetRepository = 'acme/project',
  targetVisibility = 'PUBLIC',
  workerConclusion = 'success',
  dispatchResult = success(),
  disableResult = success(),
  compileResult = success(),
  enableResult = success(),
  remoteHead = 'a'.repeat(40),
  policyDiff = success(),
} = {}) {
  const calls = [];
  const runRecords = {
    'repo-assist.lock.yml': {
      databaseId: 101,
      displayTitle: `Repo Assist: ${targetRepository}`,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:01:00Z',
      url: 'https://github.com/acme/cao/actions/runs/101',
    },
    'repo-assist-maintenance.lock.yml': {
      databaseId: 102,
      displayTitle: `Repo Assist maintenance ${targetRepository}`,
      status: 'completed',
      conclusion: workerConclusion,
      createdAt: '2026-01-01T00:00:10Z',
      updatedAt: '2026-01-01T00:02:00Z',
      url: 'https://github.com/acme/cao/actions/runs/102',
    },
    'cao-activity.yml': {
      databaseId: 103,
      displayTitle: 'CAO Activity quickstart-101',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-01-01T00:02:10Z',
      updatedAt: '2026-01-01T00:03:00Z',
      url: 'https://github.com/acme/cao/actions/runs/103',
    },
    'cao-dashboard.yml': {
      databaseId: 104,
      displayTitle: 'CAO Dashboard',
      jobs: [{ name: 'deploy', status: 'completed', conclusion: 'success' }],
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-01-01T00:03:10Z',
      updatedAt: '2026-01-01T00:04:00Z',
      url: 'https://github.com/acme/cao/actions/runs/104',
    },
  };
  const recordsById = Object.fromEntries(Object.values(runRecords).map((record) => [record.databaseId, record]));
  const execute = (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === 'git' && arguments_[0] === 'rev-parse' && arguments_[1] === '--show-toplevel') {
      return success(`${process.cwd()}\n`);
    }
    return fixtureCommand(command, arguments_);
  };
  function fixtureCommand(command, arguments_) {
    if (command === 'git' && arguments_[0] === 'rev-parse') {
      return { status: headStatus, stdout: headStatus === 0 ? 'a'.repeat(40) : '', stderr: headStatus === 0 ? '' : 'no HEAD' };
    }
    if (command === 'git' && arguments_[0] === 'branch' && arguments_[1] === '--show-current') return success(`${currentBranch}\n`);
    if (command === 'gh' && arguments_.join(' ') === 'repo view --json nameWithOwner,visibility') return success(JSON.stringify({ nameWithOwner: 'acme/cao', visibility }));
    if (command === 'gh' && arguments_[0] === 'repo' && arguments_[1] === 'view') return success(JSON.stringify({ nameWithOwner: arguments_[2], visibility: targetVisibility }));
    if (command === 'gh' && arguments_[0] === 'aw' && arguments_[1] === 'compile') return compileResult;
    if (command === 'git' && arguments_[0] === 'status') return success(status);
    if (command === 'git' && arguments_[0] === 'diff' && arguments_.includes('--check')) return diffCheck;
    if (command === 'git' && arguments_[0] === 'diff') return policyDiff;
    if (command === 'gh' && arguments_[0] === 'api' && arguments_[1] === 'user') return success('{"login":"octocat","id":1}\n');
    if (command === 'gh' && arguments_[0] === 'api' && arguments_.includes('--jq')) return success(arguments_[1].includes('/commits/') ? remoteHead : defaultBranch);
    if (command === 'gh' && arguments_[0] === 'workflow' && arguments_[2] === 'repo-assist.lock.yml') {
      if (arguments_[1] === 'run') return dispatchResult;
      if (arguments_[1] === 'disable') return disableResult;
      if (arguments_[1] === 'enable') return enableResult;
    }
    if (command === 'gh' && arguments_[0] === 'run' && arguments_[1] === 'list') return success(JSON.stringify([runRecords[arguments_[arguments_.indexOf('--workflow') + 1]]]));
    if (command === 'gh' && arguments_[0] === 'run' && arguments_[1] === 'view') return success(JSON.stringify(recordsById[Number(arguments_[2])]));
    if (command === 'gh' && arguments_[0] === 'api') return success('{"html_url":"https://acme.github.io/cao/","public":true}\n');
    return success();
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-quickstart-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    calls, execute, runRecords,
    async policyPath() {
      const value = path.join(directory, 'cao.json');
      await writeFile(value, JSON.stringify({
        $schema: './cao.schema.json', version: 1, 'gh-aw-version': 'v0.91.5',
        'control-plane': {
          scope: { 'allowed-owners': ['acme'], 'allowed-repositories': ['acme/cao'] },
          campaigns: {},
        },
      }));
      return value;
    },
  };
}

async function installedFixture(t, options = {}) {
  const fixture = await quickstartFixture(t, { headStatus: 0, ...options });
  const policyPath = await fixture.policyPath();
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy['control-plane'] = {
    scope: {
      'allowed-owners': ['acme'],
      'allowed-repositories': ['acme/cao', 'acme/project'],
    },
    activity: { repositories: ['acme/cao'] },
    campaigns: {
      'repo-assist': {
        enabled: true, mode: 'review', 'max-repositories': 1, 'rollout-percent': 100,
        targets: { 'acme/project': { mode: 'review' } },
        workers: {
          maintenance: { enabled: true, workflow: 'repo-assist-maintenance', 'max-mode': 'review' },
          'issue-fix': { enabled: false, workflow: 'repo-assist-issue-fix', 'max-mode': 'review' },
        },
      },
    },
  };
  await writeFile(policyPath, JSON.stringify(policy));
  return {
    ...fixture, policy, policyPath,
    options: {
      policyPath, execute: fixture.execute, progress: {},
      pause() { assert.fail('stages must not poll or wait'); },
      addCampaign() { assert.fail('must not reinstall'); },
      configurePages() { assert.fail('must not reconfigure'); },
      collectActivityStats: async (value) => {
        assert.equal(value.runId, 103);
        return { summary: { runsWithArtifact: 1, totalUniqueRuns: 4 }, runs: [{ runId: '103' }] };
      },
    },
  };
}

test('quickstart with explicit target installs and pauses without dispatching or polling', async (t) => {
  const fixture = await quickstartFixture(t);
  const policyPath = await fixture.policyPath();
  let output = '';
  const progress = createQuickstartProgress({
    input: { isTTY: false },
    output: { isTTY: false, write: (value) => { output += value; } },
  });
  const result = await runCaoQuickstart({
    targetRepository: 'acme/project',
    policyPath, progress,
    execute(command, arguments_) {
      if (arguments_[0] === 'variable') assert.match(output, /4\/5 · Connect authentication/);
      if (command === 'git' && arguments_.includes('commit')) assert.match(output, /5\/5 · Publish configuration/);
      return fixture.execute(command, arguments_);
    },
    resolveRootRevision: () => 'a'.repeat(40),
    async addCampaign() {
      assert.match(output, /1\/5 · Understand the repositories/);
      assert.match(output, /2\/5 · Install the campaign components/);
      assert.doesNotMatch(output, /3\/5/);
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['repo-assist'] = {
        workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ public: true, url: 'https://acme.github.io/cao/' }),
    pause() { assert.fail('no waiting'); },
  });
  assert.equal(result.step, 'install');
  assert.equal(result.status, 'installed');
  assert.equal(result.paused, true);
  assert.equal(result.nextCommand, 'gh cao quickstart --step run');
  assert.match(formatQuickstartSummary(result), /No work was dispatched/);
  assert.match(formatQuickstartSummary(result), /Control repository: https:\/\/github\.com\/acme\/cao/);
  assert.match(formatQuickstartSummary(result), /Target: https:\/\/github\.com\/acme\/project/);
  assert.equal(result.guide.length, 5);
  assert.match(formatQuickstartSummary(result), /Before continuing: Open .*cao\.json/);
  for (const detail of [
    'acme/cao (private), default branch: main',
    'explicit --target selection',
    `githubnext/gh-aw-cao/repo-assist@${'a'.repeat(40)}`,
    'cao-validate.yml', 'cao-activity.yml', 'cao-dashboard.yml',
    'repo-assist-maintenance.lock.yml', 'Issue triage, issue fix, and PR upkeep',
    'maximum repositories: 1; rollout: 100% of this exact target only',
    'Activity collection scope: acme/cao only',
    'GH_AW_GITHUB_AUTH_MODE=workflow-token',
    'GITHUB_TOKEN', 'does not configure a GitHub App or PAT',
    'PUBLIC, even if the control repository is private',
    'Stage and commit only these bounded paths',
    'Commit as octocat', 'push to origin/main',
    'Normal Activity push/schedule triggers remain active',
  ]) assert.ok(output.includes(detail), `Missing guidance: ${detail}`);
  const headings = result.guide.map(({ title }) => output.indexOf(title));
  assert.ok(headings.every((index, position) => index >= 0 && (position === 0 || index > headings[position - 1])));
  assert.ok(!fixture.calls.some((call) => call[1] === 'run'));
  assert.deepEqual(fixture.calls.filter((call) => call[1] === 'workflow'), [
    ['gh', 'workflow', 'disable', 'repo-assist.lock.yml', '--repo', 'acme/cao'],
  ]);
});

test('JSON quickstart retains selected configuration details without progress output', async (t) => {
  const fixture = await quickstartFixture(t, { targetRepository: 'acme/project', visibility: 'PUBLIC' });
  const policyPath = await fixture.policyPath();
  const result = await runQuickstartCommand({
    arguments_: ['--target', 'acme/project', '--campaign', 'acme/catalog/repo-assist@v1.0.0', '--json'],
    UsageError: Error,
    runCaoQuickstart(options) {
      assert.deepEqual(options.progress, {});
      return runCaoQuickstart({
        ...options, policyPath, execute: fixture.execute,
        async addCampaign() {
          const policy = JSON.parse(await readFile(policyPath, 'utf8'));
          policy['control-plane'].campaigns['repo-assist'] = {
            workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
          };
          await writeFile(policyPath, JSON.stringify(policy));
        },
        configurePages: () => ({ public: true }),
        pause() { assert.fail('no waiting or prompts'); },
      });
    },
  });
  const json = JSON.parse(JSON.stringify(result));
  const explanation = json.guide.flatMap(({ title, details }) => [title, ...details]).join('\n');
  assert.match(explanation, /acme\/cao \(public\)/);
  assert.match(explanation, /Target: acme\/project \(public; explicit --target selection\)/);
  assert.doesNotMatch(explanation, /default public example/);
  assert.match(explanation, /Repo Assist package: acme\/catalog\/repo-assist@v1\.0\.0/);
  assert.match(json.checkpoint, /confirm the target, review mode/);
  assert.ok(!fixture.calls.some((call) => call[1] === 'run'));
});

for (const step of ['run', 'collect', 'dashboard']) {
  test(`${step} stage preserves policy bytes and never watches or commits`, async (t) => {
    const fixture = await installedFixture(t);
    const before = await readFile(fixture.policyPath, 'utf8');
    const explanations = [];
    const result = await runCaoQuickstart({
      ...fixture.options, step,
      progress: { note(message, title) { explanations.push({ message, title }); } },
      execute(command, arguments_) {
        if (command === 'gh' && (arguments_[0] === 'workflow' || arguments_[0] === 'run')) {
          assert.equal(explanations.length, 1, 'explain the stage before any workflow request or readiness check');
        }
        return fixture.execute(command, arguments_);
      },
    });
    assert.equal(await readFile(fixture.policyPath, 'utf8'), before);
    assert.equal(result.step, step);
    assert.equal(result.status, step === 'dashboard' ? 'ready' : 'dispatched');
    assert.match(formatQuickstartSummary(result), /Next: /);
    assert.match(formatQuickstartSummary(result), /Before continuing: /);
    assert.equal(explanations.length, 1);
    if (step === 'run') {
      assert.match(explanations[0].message, /Target: acme\/project; review output repository: acme\/cao/);
      assert.match(explanations[0].message, /max_repos=1, rollout_percent=100, safe_output_mode=review/);
      assert.match(result.checkpoint, /Do not repeat run as a status check/);
    } else if (step === 'collect') {
      assert.match(explanations[0].message, /collection scope: acme\/cao only/);
      assert.match(explanations[0].message, /cao-activity-index artifact/);
      assert.match(result.checkpoint, /do not repeat collect/);
    } else {
      assert.match(explanations[0].message, /read-only/);
      assert.match(explanations[0].message, /successful Pages deploy job, not just a successful build/);
      assert.match(result.checkpoint, /Reports/);
    }
    assert.ok(!fixture.calls.some((call) => ['watch', 'commit', 'push', 'add', 'compile'].includes(call[1])));
    const views = fixture.calls.filter((call) => call[1] === 'run' && call[2] === 'view');
    assert.equal(views.length, step === 'dashboard' ? 1 : 0);
    if (step === 'dashboard') assert.equal(views[0].at(-1), 'jobs');
    const workflows = fixture.calls.filter((call) => call[1] === 'workflow');
    if (step === 'run') {
      assert.deepEqual(workflows.map((call) => call[2]), ['enable', 'run', 'disable']);
      assert.ok(workflows[1].includes('target_repo=acme/project'));
      assert.ok(workflows[1].includes('safe_output_repo=acme/cao'));
      assert.ok(workflows[1].includes('safe_output_mode=review'));
      assert.ok(workflows[1].includes('max_repos=1'));
      assert.ok(workflows[1].includes('rollout_percent=100'));
    } else if (step === 'collect') {
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0][3], 'cao-activity.yml');
      assert.match(result.requestId, /^quickstart-[0-9a-f-]{36}$/);
      assert.ok(workflows[0].includes(`request-id=${result.requestId}`));
      const again = await runCaoQuickstart({ ...fixture.options, step });
      assert.notEqual(again.requestId, result.requestId);
    } else {
      assert.deepEqual(workflows, []);
      assert.equal(result.dashboard.url, 'https://acme.github.io/cao/');
    }
  });
}

for (const step of ['run', 'collect']) {
  for (const [name, mutate] of [
    ['disabled campaign', (p) => { p.campaigns['repo-assist'].enabled = false; }],
    ['live campaign', (p) => { p.campaigns['repo-assist'].mode = 'live'; }],
    ['live target', (p) => { p.campaigns['repo-assist'].targets['acme/project'].mode = 'live'; }],
    ['multiple targets', (p) => { p.campaigns['repo-assist'].targets['acme/other'] = { mode: 'review' }; }],
    ['unbounded campaign', (p) => { p.campaigns['repo-assist']['max-repositories'] = 2; }],
    ['disabled maintenance', (p) => { p.campaigns['repo-assist'].workers.maintenance.enabled = false; }],
    ['live worker', (p) => { p.campaigns['repo-assist'].workers.maintenance['max-mode'] = 'live'; }],
    ['another enabled worker', (p) => { p.campaigns['repo-assist'].workers['issue-fix'].enabled = true; }],
    ['implicit worker enablement', (p) => { delete p.campaigns['repo-assist'].workers['issue-fix'].enabled; }],
    ['wrong workflow', (p) => { p.campaigns['repo-assist'].workers.maintenance.workflow = 'other'; }],
    ['missing scope', (p) => { delete p.scope; }],
    ['out-of-scope target', (p) => { p.scope['allowed-repositories'] = ['acme/cao']; }],
    ['broader collection', (p) => { p.activity.repositories.push('acme/other'); }],
  ]) {
    test(`${step} fails closed without mutation for ${name}`, async (t) => {
      const fixture = await installedFixture(t);
      mutate(fixture.policy['control-plane']);
      const before = JSON.stringify(fixture.policy);
      await writeFile(fixture.policyPath, before);
      await assert.rejects(runCaoQuickstart({ ...fixture.options, step }), /policy|target/);
      assert.equal(await readFile(fixture.policyPath, 'utf8'), before);
      assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
    });
  }
  for (const [name, options] of [
    ['non-default branch', { currentBranch: 'feature' }],
    ['unpushed revision', { remoteHead: 'b'.repeat(40) }],
    ['uncommitted policy', { policyDiff: { status: 1 } }],
    ['private target', { targetVisibility: 'PRIVATE' }],
  ]) {
    test(`${step} rejects ${name} before dispatch`, async (t) => {
      const fixture = await installedFixture(t, options);
      await assert.rejects(runCaoQuickstart({ ...fixture.options, step }));
      assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
    });
  }
}

for (const [name, options] of [
  ['dispatch fails', { dispatchResult: { status: 1, stderr: 'dispatch failed' } }],
  ['enable fails', { enableResult: { status: 1, stderr: 'enable failed' } }],
  ['dispatch and pause fail', { dispatchResult: { status: 1, stderr: 'dispatch failed' }, disableResult: { status: 1, stderr: 'pause failed' } }],
]) {
  test(`run stage always pauses when ${name}`, async (t) => {
    const fixture = await installedFixture(t, options);
    await assert.rejects(runCaoQuickstart({ ...fixture.options, step: 'run' }));
    const workflows = fixture.calls.filter((call) => call[1] === 'workflow');
    assert.equal(workflows.at(-1)[2], 'disable');
    assert.ok(workflows.filter((call) => call[2] === 'run').length <= 1);
  });
}

for (const state of ['activity-pending', 'activity-failed', 'activity-empty', 'stats-mismatch', 'dashboard-pending', 'dashboard-failed', 'dashboard-old']) {
  test(`dashboard check is read-only and pending for ${state}`, async (t) => {
    const fixture = await installedFixture(t);
    if (state === 'activity-pending') fixture.runRecords['cao-activity.yml'].status = 'in_progress';
    if (state === 'activity-failed') fixture.runRecords['cao-activity.yml'].conclusion = 'failure';
    if (state === 'dashboard-pending') fixture.runRecords['cao-dashboard.yml'].status = 'queued';
    if (state === 'dashboard-failed') fixture.runRecords['cao-dashboard.yml'].conclusion = 'failure';
    if (state === 'dashboard-old') fixture.runRecords['cao-dashboard.yml'].createdAt = '2025-01-01T00:00:00Z';
    const collectActivityStats = async () => ({
      summary: { runsWithArtifact: 1, totalUniqueRuns: state === 'activity-empty' ? 0 : 4 },
      runs: [{ runId: state === 'stats-mismatch' ? '100' : '103' }],
    });
    const result = await runCaoQuickstart({ ...fixture.options, step: 'dashboard', collectActivityStats });
    assert.equal(result.status, 'pending');
    assert.equal(result.dashboard, undefined);
    assert.equal(result.nextCommand, 'gh cao quickstart --step dashboard');
    const workflow = state.startsWith('dashboard-') ? 'cao-dashboard.yml' : 'cao-activity.yml';
    assert.ok(result.actionsUrl.endsWith(`/actions/workflows/${workflow}`));
    assert.ok(result.inspectCommand.endsWith(`--workflow ${workflow}`));
    assert.doesNotMatch(formatQuickstartSummary(result), /CAO quickstart complete|dashboard: ready|Dashboard: https/);
    assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
  });
}
test('run discloses its AI credit budget before dispatch and in JSON context', async (t) => {
  const fixture = await installedFixture(t);
  let budgetDisclosed = false;
  const budget = /up to 1,250 AI credits: 250 orchestration \+ 600 maintenance \+ 400 configurable output checking/;
  const result = await runCaoQuickstart({
    ...fixture.options, step: 'run',
    progress: { step(message) { assert.match(message, budget); budgetDisclosed = true; } },
    execute(command, arguments_) {
      if (command === 'gh' && arguments_[0] === 'workflow' && arguments_[1] === 'run') {
        assert.equal(budgetDisclosed, true);
      }
      return fixture.execute(command, arguments_);
    },
  });
  assert.match(result.context, budget);
  assert.match(JSON.stringify(result), /1,250 AI credits/);
});

test('dashboard remains pending without Activity history or data artifacts', async (t) => {
  const fixture = await installedFixture(t);
  const execute = (command, arguments_) => {
    if (command === 'gh' && arguments_[0] === 'run' && arguments_[1] === 'list') {
      fixture.calls.push([command, ...arguments_]);
      return success('[]');
    }
    return fixture.execute(command, arguments_);
  };
  const empty = await runCaoQuickstart({
    ...fixture.options, execute, step: 'dashboard',
    collectActivityStats() { assert.fail('no Activity run to inspect'); },
  });
  assert.equal(empty.status, 'pending');
  const missingArtifact = await runCaoQuickstart({
    ...fixture.options, step: 'dashboard',
    collectActivityStats: async () => ({
      summary: { runsWithArtifact: 0, totalUniqueRuns: 0 },
      runs: [{ runId: '103', error: 'artifact not found' }],
    }),
  });
  assert.equal(missingArtifact.status, 'pending');
  assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
});

test('dashboard cannot report ready when Pages deployment is disabled', async (t) => {
  const fixture = await installedFixture(t);
  fixture.policy['control-plane'].campaigns.dashboard = { deploy: false };
  await writeFile(fixture.policyPath, JSON.stringify(fixture.policy));
  const result = await runCaoQuickstart({ ...fixture.options, step: 'dashboard' });
  assert.equal(result.status, 'pending');
  assert.equal(result.dashboard, undefined);
  assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
});

for (const [name, jobs] of [
  ['skipped', [{ name: 'deploy', status: 'completed', conclusion: 'skipped' }]],
  ['missing', [{ name: 'build', status: 'completed', conclusion: 'success' }]],
  ['failed', [{ name: 'deploy', status: 'completed', conclusion: 'failure' }]],
  ['pending', [{ name: 'deploy', status: 'in_progress', conclusion: null }]],
]) {
  test(`dashboard stays pending when its actual Pages deploy job is ${name}`, async (t) => {
    const fixture = await installedFixture(t);
    fixture.runRecords['cao-dashboard.yml'].jobs = jobs;
    const result = await runCaoQuickstart({ ...fixture.options, step: 'dashboard' });
    assert.equal(result.status, 'pending');
    assert.equal(result.dashboard, undefined);
    assert.ok(result.actionsUrl.endsWith('/cao-dashboard.yml'));
    assert.ok(fixture.calls.some((call) => call.join(' ') === 'gh run view 104 --repo acme/cao --json jobs'));
    assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
    assert.ok(!fixture.calls.some((call) => call[1] === 'api' && call[2].endsWith('/pages')));
  });
}

for (const step of ['run', 'collect']) {
  test(`${step} rejects missing or invalid policy without mutation`, async (t) => {
    const fixture = await installedFixture(t);
    await writeFile(fixture.policyPath, '{invalid JSON');
    await assert.rejects(runCaoQuickstart({ ...fixture.options, step }), SyntaxError);
    assert.equal(await readFile(fixture.policyPath, 'utf8'), '{invalid JSON');
    await rm(fixture.policyPath);
    await assert.rejects(runCaoQuickstart({ ...fixture.options, step }), { code: 'ENOENT' });
    assert.ok(!fixture.calls.some((call) => call[1] === 'workflow'));
  });
}

test('quickstart reports staged whitespace errors', async (t) => {
  const fixture = await quickstartFixture(t, {
    diffCheck: {
      status: 2,
      stdout: 'dashboard/site/src/components/workflow-badges.js:73: new blank line at EOF.\n',
      stderr: '',
    },
  });
  const policyPath = await fixture.policyPath();

  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    policyPath,
    execute: fixture.execute,
    addCampaign: async () => {
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['repo-assist'] = {
        orchestrator: 'repo-assist',
        workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), /git diff --cached --check failed: dashboard\/site\/src\/components\/workflow-badges\.js:73: new blank line at EOF/);
});

test('quickstart refuses to commit or dispatch when deterministic compilation fails', async (t) => {
  const fixture = await quickstartFixture(t, {
    compileResult: { status: 1, stdout: '', stderr: 'Invalid workflow source' },
  });
  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    policyPath: await fixture.policyPath(),
    execute: fixture.execute,
    addCampaign: async () => {},
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), /gh aw compile .*--schedule-seed githubnext\/gh-aw-cao failed: Invalid workflow source/);
  assert.ok(!fixture.calls.some((call) => call[0] === 'git' && call.includes('commit')));
  assert.ok(!fixture.calls.some((call) => call[0] === 'gh' && call[1] === 'workflow'));
});

test('quickstart configures, commits, runs, collects, and reports first dashboard data', async (t) => {
  const fixture = await quickstartFixture(t);
  const policyPath = await fixture.policyPath();
  const progress = [];
  let installedCampaign;
  let activeRepoAssistPhaseRendered = false;
  const result = await runCaoQuickstart({
    wait: true,
    targetRepository: 'acme/project',
    policyPath,
    execute: (command, arguments_) => {
      if (command === 'gh' && arguments_[0] === 'workflow' && arguments_[1] === 'run') {
        assert.equal(activeRepoAssistPhaseRendered, true);
      }
      return fixture.execute(command, arguments_);
    },
    addCampaign: async (campaign) => {
      installedCampaign = campaign;
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['repo-assist'] = {
        orchestrator: 'repo-assist',
        workers: {
          maintenance: { workflow: 'repo-assist-maintenance', enabled: true },
          'issue-fix': { workflow: 'repo-assist-issue-fix' },
          'issue-triage': { workflow: 'repo-assist-issue-triage' },
          'pr-upkeep': { workflow: 'repo-assist-pr-upkeep' },
        },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
    collectActivityStats: async () => ({
      summary: { runsWithArtifact: 1, totalUniqueRuns: 4 },
    }),
    progress: {
      start() {},
      step: async (message) => {
        progress.push(message);
        if (message.startsWith('Running Repo Assist in review mode')) {
          await Promise.resolve();
          activeRepoAssistPhaseRendered = true;
        }
      },
      success: (message) => progress.push(message),
      warning: (message) => progress.push(message),
      finish: (message) => progress.push(message),
    },
    now: () => Date.parse('2026-01-01T00:00:05Z'),
    pause() {},
    resolveRootRevision: () => 'a'.repeat(40),
  });

  assert.equal(installedCampaign, `githubnext/gh-aw-cao/repo-assist@${'a'.repeat(40)}`);
  assert.equal(result.dashboard.url, 'https://acme.github.io/cao/');
  assert.equal(result.activity.uniqueRuns, 4);
  assert.equal(result.mode, 'review');
  assert.equal(result.paused, true);
  assert.equal(result.targetRepository, 'acme/project');
  assert.ok(!Object.hasOwn(result, 'starterTarget'));
  assert.equal(result.campaign, 'repo-assist');
  assert.equal(result.repoAssist.workerRunId, 102);
  assert.match(formatQuickstartSummary(result), /Target: https:\/\/github\.com\/acme\/project/);
  assert.doesNotMatch(formatQuickstartSummary(result), /example/);
  assert.match(formatQuickstartSummary(result), /Repo Assist:/);
  assert.match(formatQuickstartSummary(result), /Repo Assist is paused; re-enable it explicitly/);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.deepEqual(policy['control-plane'].activity.repositories, ['acme/cao']);
  assert.deepEqual(policy['control-plane'].scope['allowed-repositories'], [
    'acme/cao',
    'acme/project',
  ]);
  assert.deepEqual(policy['control-plane'].scope['allowed-owners'], ['acme']);
  assert.equal(policy['control-plane'].campaigns['repo-assist'].mode, 'review');
  assert.equal(policy['control-plane'].campaigns['repo-assist'].workers.maintenance.enabled, true);
  assert.equal(policy['control-plane'].campaigns['repo-assist'].workers.maintenance['max-mode'], 'review');
  for (const key of ['issue-fix', 'issue-triage', 'pr-upkeep']) {
    assert.equal(policy['control-plane'].campaigns['repo-assist'].workers[key].enabled, false, key);
    assert.equal(policy['control-plane'].campaigns['repo-assist'].workers[key]['max-mode'], 'review', key);
  }
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('workflow run repo-assist.lock.yml')));
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('workflow run cao-activity.yml')));
  assert.ok(fixture.calls.some((call) => call.join(' ') === 'git add -- .github activity dashboard repo-assist cao.sh .gitattributes .vscode/settings.json'));
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('git -c user.name=octocat -c user.email=1+octocat@users.noreply.github.com commit --no-gpg-sign')));
  const compileIndex = fixture.calls.findIndex((call) => call.join(' ') === 'gh aw compile --strict --no-check-update --schedule-seed githubnext/gh-aw-cao');
  const stageIndex = fixture.calls.findIndex((call) => call[0] === 'git' && call[1] === 'add');
  assert.ok(compileIndex >= 0 && stageIndex > compileIndex);
  const dispatchIndex = fixture.calls.findIndex((call) => call.join(' ').includes('workflow run repo-assist.lock.yml'));
  const disableIndex = fixture.calls.findIndex((call) => call.join(' ') === 'gh workflow disable repo-assist.lock.yml --repo acme/cao');
  const watchIndex = fixture.calls.findIndex((call) => call.join(' ').startsWith('gh run list'));
  assert.ok(dispatchIndex >= 0 && disableIndex > dispatchIndex && watchIndex > disableIndex);
  assert.ok(!fixture.calls.some((call) => call.includes('starter=true')));
  assert.ok(!fixture.calls.some((call) => call[1] === 'api' && call[2].includes('/commits/')));
  assert.ok(progress.includes('Installing Repo Assist with only its existing maintenance worker enabled in review mode'));
  assert.ok(progress.includes('Repo Assist maintenance enabled in review mode for acme/project; other workers remain disabled; proposals are optional, not requirements for CAO'));
  assert.ok(progress.includes('Configuring the public-read workflow token profile and dashboard Pages'));
  assert.ok(progress.some((message) => message.startsWith('Running Repo Assist in review mode')));
  assert.ok(progress.includes('Waiting for a Repo Assist maintenance proposal or no-op'));
  assert.ok(progress.some((message) => message.includes('up to 1,250 AI credits: 250 orchestration + 600 maintenance + 400 output checking')));
  assert.ok(progress.some((message) => message.includes('proposals are optional, not requirements for CAO')));
});

test('quickstart runs maintenance on an explicit ordinary repository without workflow-inventory preflight', async (t) => {
  const fixture = await quickstartFixture(t, {
    targetRepository: 'acme/plain-project',
    workerConclusion: 'failure',
  });
  const policyPath = await fixture.policyPath();
  const warnings = [];
  const result = await runCaoQuickstart({
    wait: true,
    targetRepository: 'acme/plain-project',
    policyPath,
    execute: fixture.execute,
    addCampaign: async () => {
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['repo-assist'] = {
        workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
    collectActivityStats: async () => ({
      summary: { runsWithArtifact: 1, totalUniqueRuns: 4 },
    }),
    progress: { warning: (message) => warnings.push(message) },
    now: () => Date.parse('2026-01-01T00:00:05Z'),
    pause() {},
    resolveRootRevision: () => 'a'.repeat(40),
  });

  assert.equal(result.targetRepository, 'acme/plain-project');
  assert.ok(!Object.hasOwn(result, 'starterTarget'));
  assert.equal(result.repoAssist.workerConclusion, 'failure');
  assert.deepEqual(warnings, ['Repo Assist maintenance concluded failure']);
  assert.ok(!fixture.calls.some((call) => call[1] === 'workflow' && call[2] === 'list'));
  assert.ok(!fixture.calls.some((call) => call[1] === 'api' && call[2].includes('/commits/')));
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.deepEqual(policy['control-plane'].campaigns['repo-assist'].targets, {
    'acme/plain-project': { mode: 'review' },
  });
});

for (const [name, status, message] of [
  ['unrelated files', '?? secrets.txt\n', /refuses to commit unrelated path: secrets\.txt/],
  ['descendants of owned root files', '?? .gitattributes/secret\n', /refuses to commit unrelated path: \.gitattributes\/secret/],
  ['other editor settings', '?? .vscode/extensions.json\n', /refuses to commit unrelated path: \.vscode\/extensions\.json/],
  ['pre-staged files', 'A  .github/workflows/cao.json\n', /refuses pre-staged changes/],
]) {
  test(`quickstart refuses to commit ${name}`, async (t) => {
    const fixture = await quickstartFixture(t, { status });
    const policyPath = await fixture.policyPath();
    let campaignInstalled = false;

    await assert.rejects(runCaoQuickstart({
      targetRepository: 'acme/project',
      policyPath,
      execute: fixture.execute,
      addCampaign: async () => {
        campaignInstalled = true;
        const policy = JSON.parse(await readFile(policyPath, 'utf8'));
        policy['control-plane'].campaigns['repo-assist'] = {
          orchestrator: 'repo-assist',
          workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
        };
        await writeFile(policyPath, JSON.stringify(policy));
      },
      configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
      progress: {},
      resolveRootRevision: () => 'a'.repeat(40),
    }), message);
    assert.equal(campaignInstalled, false);
    assert.ok(!fixture.calls.some((call) => call[0] === 'git' && call[1] === 'commit'));
  });
}

test('quickstart accepts a public control repository with an existing default-branch commit', async (t) => {
  const fixture = await quickstartFixture(t, { headStatus: 0, visibility: 'PUBLIC' });
  const expected = new Error('campaign reached');
  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    execute: fixture.execute,
    addCampaign: async () => { throw expected; },
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), (error) => error === expected);
  assert.ok(fixture.calls.some((call) => call.join(' ') === 'git branch --show-current'));
  assert.ok(!fixture.calls.some((call) => call.join(' ') === 'git branch -M main'));
});

test('quickstart uses an explicit public target without creating a target repository', async (t) => {
  const fixture = await quickstartFixture(t);
  const expected = new Error('campaign reached');
  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    execute: fixture.execute,
    addCampaign: async () => { throw expected; },
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), (error) => error === expected);
  assert.ok(fixture.calls.some((call) => call.join(' ') === 'gh repo view acme/project --json nameWithOwner,visibility'));
  assert.ok(!fixture.calls.some((call) => call.join(' ').startsWith('gh repo create')));
});

test('quickstart rejects a private target before installing the campaign', async (t) => {
  const fixture = await quickstartFixture(t, { targetVisibility: 'PRIVATE' });
  let campaignInstalled = false;
  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    execute: fixture.execute,
    addCampaign: async () => { campaignInstalled = true; },
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), /target must be an accessible public repository/);
  assert.equal(campaignInstalled, false);
});

for (const [name, options, message] of [
  ['a non-default branch', { headStatus: 0, currentBranch: 'feature' }, /requires the checked-out default branch main/],
  ['unknown repository visibility', { visibility: '' }, /resolve the control repository visibility/],
]) {
  test(`quickstart rejects ${name} before campaign installation`, async (t) => {
    const fixture = await quickstartFixture(t, options);
    let campaignInstalled = false;
    await assert.rejects(runCaoQuickstart({
      targetRepository: 'acme/project',
      execute: fixture.execute,
      addCampaign: async () => { campaignInstalled = true; },
      progress: {},
    }), message);
    assert.equal(campaignInstalled, false);
  });
}

test('quickstart rejects private Pages before setting credentials or committing', async (t) => {
  const fixture = await quickstartFixture(t);
  const policyPath = await fixture.policyPath();
  await assert.rejects(runCaoQuickstart({
    targetRepository: 'acme/project',
    policyPath,
    execute: fixture.execute,
    addCampaign: async () => {
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['repo-assist'] = {
        orchestrator: 'repo-assist',
        workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: false }),
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), (error) => {
    assert.match(error.message, /requires public GitHub Pages/);
    return true;
  });
  assert.ok(!fixture.calls.some((call) => call[0] === 'gh' && call[1] === 'variable'));
  assert.ok(!fixture.calls.some((call) => call[0] === 'git' && call.includes('commit')));
});

for (const [name, options, message] of [
  ['pauses after a failed dispatch', {
    dispatchResult: { status: 1, stdout: '', stderr: 'dispatch rejected' },
  }, /workflow run repo-assist\.lock\.yml .*failed: dispatch rejected/],
  ['reports a pause failure', {
    disableResult: { status: 1, stdout: '', stderr: 'disable denied' },
  }, /workflow disable repo-assist\.lock\.yml .*failed: disable denied/],
  ['preserves dispatch and pause failures', {
    dispatchResult: { status: 1, stdout: '', stderr: 'dispatch rejected' },
    disableResult: { status: 1, stdout: '', stderr: 'disable denied' },
  }, /dispatch rejected; pausing Repo Assist also failed: .*disable denied/],
]) {
  test(`quickstart ${name}`, async (t) => {
    const fixture = await quickstartFixture(t, options);
    const policyPath = await fixture.policyPath();
    await assert.rejects(runCaoQuickstart({
      wait: true,
      targetRepository: 'acme/project',
      policyPath,
      execute: fixture.execute,
      addCampaign: async () => {
        const policy = JSON.parse(await readFile(policyPath, 'utf8'));
        policy['control-plane'].campaigns['repo-assist'] = {
          orchestrator: 'repo-assist',
          workers: { maintenance: { workflow: 'repo-assist-maintenance' } },
        };
        await writeFile(policyPath, JSON.stringify(policy));
      },
      configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
      progress: {},
      pause() {},
      resolveRootRevision: () => 'a'.repeat(40),
    }), (error) => {
      assert.match(error.message, message);
      if (options.dispatchResult && options.disableResult) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
      }
      return true;
    });
    const dispatches = fixture.calls.filter((call) => call[1] === 'workflow' && call[2] === 'run');
    assert.ok(dispatches.length > 0);
    assert.ok(dispatches.every((call) => call[3] === 'repo-assist.lock.yml'));
    assert.equal(fixture.calls.filter((call) => call.join(' ') === 'gh workflow disable repo-assist.lock.yml --repo acme/cao').length, 1);
    assert.ok(!fixture.calls.some((call) => call[1] === 'run' && call[2] === 'list'));
  });
}
