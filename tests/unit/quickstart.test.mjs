import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  QUICKSTART_STARTER_TARGET,
  formatQuickstartSummary,
  runCaoQuickstart,
} from '../../activity/quickstart.mjs';
import { runQuickstart as runQuickstartCommand } from '../../activity/commands/quickstart.mjs';
import { createQuickstartProgress } from '../../activity/setup-prompt.mjs';
import { runTerminal } from '../helpers/terminal.mjs';

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

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

test('styled quickstart progress renders immediately without a UI dependency', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cao-quickstart-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = path.join(directory, 'driver.mjs');
  await writeFile(driver, `
import { createQuickstartProgress } from ${JSON.stringify(pathToFileURL(path.resolve('activity/setup-prompt.mjs')).href)};
const progress = createQuickstartProgress();
await progress.step('Installing Repo Assist campaign');
progress.success('Repo Assist campaign installed');
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
  assert.match(result.stdout, /Dashboard ready/);
});

async function quickstartFixture(t, {
  status = '?? .github/workflows/cao.json\n?? cao.sh\n?? .gitattributes\n?? .vscode/settings.json\n',
  headStatus = 128,
  visibility = 'PRIVATE',
  currentBranch = 'main',
  defaultBranch = 'main',
  diffCheck = success(),
  targetRepository = QUICKSTART_STARTER_TARGET.repository,
  targetVisibility = 'PUBLIC',
  workerConclusion = 'success',
  dispatchResult = success(),
  disableResult = success(),
  compileResult = success(),
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
    if (command === 'git' && arguments_[0] === 'rev-parse') {
      return { status: headStatus, stdout: headStatus === 0 ? 'a'.repeat(40) : '', stderr: headStatus === 0 ? '' : 'no HEAD' };
    }
    if (command === 'git' && arguments_[0] === 'branch' && arguments_[1] === '--show-current') {
      return success(`${currentBranch}\n`);
    }
    if (command === 'gh' && arguments_.join(' ') === 'repo view --json nameWithOwner,visibility') {
      return success(`${JSON.stringify({ nameWithOwner: 'acme/cao', visibility })}\n`);
    }
    if (command === 'gh' && arguments_[0] === 'repo' && arguments_[1] === 'view') {
      return success(`${JSON.stringify({ nameWithOwner: arguments_[2], visibility: targetVisibility })}\n`);
    }
    if (command === 'gh' && arguments_[0] === 'aw' && arguments_[1] === 'compile') return compileResult;
    if (command === 'git' && arguments_[0] === 'status') return success(status);
    if (command === 'git' && arguments_[0] === 'diff' && arguments_.includes('--check')) return diffCheck;
    if (command === 'gh' && arguments_[0] === 'api' && arguments_[1] === 'user') {
      return success('{"login":"octocat","id":1}\n');
    }
    if (command === 'gh' && arguments_[0] === 'api' && arguments_.includes('--jq')) {
      return success(`${defaultBranch}\n`);
    }
    if (command === 'gh' && arguments_[0] === 'workflow' && arguments_[2] === 'repo-assist.lock.yml') {
      if (arguments_[1] === 'run') return dispatchResult;
      if (arguments_[1] === 'disable') return disableResult;
    }
    if (command === 'gh' && arguments_[0] === 'run' && arguments_[1] === 'list') {
      const workflow = arguments_[arguments_.indexOf('--workflow') + 1];
      return success(`${JSON.stringify([runRecords[workflow]])}\n`);
    }
    if (command === 'gh' && arguments_[0] === 'run' && arguments_[1] === 'view') {
      return success(`${JSON.stringify(recordsById[Number(arguments_[2])])}\n`);
    }
    if (command === 'gh' && arguments_[0] === 'api') {
      return success('{"html_url":"https://acme.github.io/cao/","public":true}\n');
    }
    return success();
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cao-quickstart-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return {
    calls,
    execute,
    async policyPath() {
      const value = path.join(directory, 'cao.json');
      await writeFile(value, JSON.stringify({
        $schema: './cao.schema.json',
        version: 1,
        'gh-aw-version': 'v0.91.5',
        'control-plane': {
          scope: {
            'allowed-owners': ['acme'],
            'allowed-repositories': ['acme/cao'],
          },
          campaigns: {},
        },
      }));
      return value;
    },
  };
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
  assert.equal(result.targetRepository, QUICKSTART_STARTER_TARGET.repository);
  assert.equal(result.starterTarget, true);
  assert.equal(result.campaign, 'repo-assist');
  assert.equal(result.repoAssist.workerRunId, 102);
  assert.match(formatQuickstartSummary(result), /Target: https:\/\/github\.com\/github\/gh-aw \(public Repo Assist example\)/);
  assert.match(formatQuickstartSummary(result), /Repo Assist:/);
  assert.match(formatQuickstartSummary(result), /Repo Assist is paused; re-enable it explicitly/);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.deepEqual(policy['control-plane'].activity.repositories, ['acme/cao']);
  assert.deepEqual(policy['control-plane'].scope['allowed-repositories'], [
    'acme/cao',
    QUICKSTART_STARTER_TARGET.repository,
  ]);
  assert.deepEqual(policy['control-plane'].scope['allowed-owners'], ['acme', 'github']);
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
  assert.ok(progress.includes(
    `Repo Assist example selected: ${QUICKSTART_STARTER_TARGET.repository}`,
  ));
  assert.ok(progress.includes(`Repo Assist maintenance enabled in review mode for ${QUICKSTART_STARTER_TARGET.repository}; other workers remain disabled; proposals are optional, not requirements for CAO`));
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
  assert.equal(result.starterTarget, false);
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
    execute: fixture.execute,
    addCampaign: async () => { throw expected; },
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), (error) => error === expected);
  assert.ok(fixture.calls.some((call) => call.join(' ') === 'git branch --show-current'));
  assert.ok(!fixture.calls.some((call) => call.join(' ') === 'git branch -M main'));
});

test('quickstart uses an explicit public target without creating the sample repository', async (t) => {
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
});

test('quickstart rejects a private target before installing the campaign', async (t) => {
  const fixture = await quickstartFixture(t, { targetVisibility: 'PRIVATE' });
  let campaignInstalled = false;
  await assert.rejects(runCaoQuickstart({
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
