import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCaoQuickstart } from '../../activity/quickstart.mjs';
import { createQuickstartProgress } from '../../activity/setup-prompt.mjs';

function success(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

test('plain quickstart progress starts with the first operation', () => {
  let output = '';
  const progress = createQuickstartProgress({
    input: { isTTY: false },
    output: { isTTY: false, write: (value) => { output += value; } },
  });

  progress.start();
  progress.step('Installing Bug Bash');
  progress.success('Bug Bash campaign installed');
  progress.finish('Dashboard ready');

  assert.equal(output, [
    '==> Installing Bug Bash',
    'OK: Bug Bash campaign installed',
    'Dashboard ready',
    '',
  ].join('\n'));
  assert.doesNotMatch(output, /Complete the CAO quickstart/);
});

async function quickstartFixture(t, {
  status = '?? .github/workflows/cao.json\n?? cao.sh\n?? .gitattributes\n?? .vscode/settings.json\n',
  headStatus = 128,
  visibility = 'PRIVATE',
  diffCheck = success(),
} = {}) {
  const calls = [];
  const runRecords = {
    'bug-bash.lock.yml': {
      databaseId: 101,
      displayTitle: 'Bug Bash: githubnext/gh-aw-cao',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:01:00Z',
      url: 'https://github.com/acme/cao/actions/runs/101',
    },
    'bug-bash-investigation.lock.yml': {
      databaseId: 102,
      displayTitle: 'Investigate githubnext/gh-aw-cao',
      status: 'completed',
      conclusion: 'success',
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
    if (command === 'gh' && arguments_[0] === 'repo') {
      return success(`${JSON.stringify({ nameWithOwner: 'acme/cao', visibility })}\n`);
    }
    if (command === 'git' && arguments_[0] === 'status') return success(status);
    if (command === 'git' && arguments_[0] === 'diff' && arguments_.includes('--check')) return diffCheck;
    if (command === 'gh' && arguments_[0] === 'api' && arguments_[1] === 'user') {
      return success('{"login":"octocat","id":1}\n');
    }
    if (command === 'gh' && arguments_[0] === 'api' && arguments_.includes('--jq')) {
      return success('main\n');
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
      policy['control-plane'].campaigns['bug-bash'] = {
        orchestrator: 'bug-bash',
        workers: { investigation: { workflow: 'bug-bash-investigation' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), /git diff --cached --check failed: dashboard\/site\/src\/components\/workflow-badges\.js:73: new blank line at EOF/);
});

test('quickstart configures, commits, runs, collects, and reports first dashboard data', async (t) => {
  const fixture = await quickstartFixture(t);
  const policyPath = await fixture.policyPath();
  const progress = [];
  let installedCampaign;
  const result = await runCaoQuickstart({
    policyPath,
    execute: fixture.execute,
    addCampaign: async (campaign) => {
      installedCampaign = campaign;
      const policy = JSON.parse(await readFile(policyPath, 'utf8'));
      policy['control-plane'].campaigns['bug-bash'] = {
        orchestrator: 'bug-bash',
        workers: { investigation: { workflow: 'bug-bash-investigation', 'max-mode': 'review' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
    collectActivityStats: async () => ({
      summary: { runsWithArtifact: 1, totalUniqueRuns: 4 },
    }),
    progress: {
      start() {},
      step: (message) => progress.push(message),
      success: (message) => progress.push(message),
      warning: (message) => progress.push(message),
      finish: (message) => progress.push(message),
    },
    now: () => Date.parse('2026-01-01T00:00:05Z'),
    pause() {},
    resolveRootRevision: () => 'a'.repeat(40),
  });

  assert.equal(installedCampaign, `githubnext/gh-aw-cao/bug-bash@${'a'.repeat(40)}`);
  assert.equal(result.dashboard.url, 'https://acme.github.io/cao/');
  assert.equal(result.activity.uniqueRuns, 4);
  assert.equal(result.mode, 'review');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  assert.deepEqual(policy['control-plane'].activity.repositories, ['acme/cao']);
  assert.deepEqual(policy['control-plane'].scope['allowed-repositories'], [
    'acme/cao',
    'githubnext/gh-aw-cao',
  ]);
  assert.equal(policy['control-plane'].campaigns['bug-bash'].mode, 'review');
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('workflow run bug-bash.lock.yml')));
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('workflow run cao-activity.yml')));
  assert.ok(fixture.calls.some((call) => call.join(' ') === 'git add -- .github activity dashboard bug-bash cao.sh .gitattributes .vscode/settings.json'));
  assert.ok(fixture.calls.some((call) => call.join(' ').includes('git -c user.name=octocat -c user.email=1+octocat@users.noreply.github.com commit --no-gpg-sign')));
  assert.ok(progress.includes('Installing the review-only Bug Bash campaign (2 workflows)'));
  assert.ok(progress.includes('Bug Bash campaign installed in review mode for one public starter repository'));
  assert.ok(progress.includes('Configuring the public-read workflow token profile and dashboard Pages'));
  assert.ok(progress.includes('Waiting for one bounded Bug Bash investigation'));
  assert.ok(progress.some((message) => message.includes('up to 700 AI credits')));
});

for (const [name, status, message] of [
  ['unrelated files', '?? secrets.txt\n', /refuses to commit unrelated path: secrets\.txt/],
  ['descendants of owned root files', '?? .gitattributes/secret\n', /refuses to commit unrelated path: \.gitattributes\/secret/],
  ['other editor settings', '?? .vscode/extensions.json\n', /refuses to commit unrelated path: \.vscode\/extensions\.json/],
]) {
  test(`quickstart refuses to commit ${name}`, async (t) => {
    const fixture = await quickstartFixture(t, { status });
    const policyPath = await fixture.policyPath();

    await assert.rejects(runCaoQuickstart({
      policyPath,
      execute: fixture.execute,
      addCampaign: async () => {
        const policy = JSON.parse(await readFile(policyPath, 'utf8'));
        policy['control-plane'].campaigns['bug-bash'] = {
          orchestrator: 'bug-bash',
          workers: { investigation: { workflow: 'bug-bash-investigation' } },
        };
        await writeFile(policyPath, JSON.stringify(policy));
      },
      configurePages: () => ({ url: 'https://acme.github.io/cao/', public: true }),
      progress: {},
      resolveRootRevision: () => 'a'.repeat(40),
    }), message);
    assert.ok(!fixture.calls.some((call) => call[0] === 'git' && call[1] === 'commit'));
  });
}

for (const [name, options, message] of [
  ['an existing commit', { headStatus: 0 }, /requires a new control repository with no commits/],
  ['a non-private control repository', { visibility: 'PUBLIC' }, /requires a private control repository/],
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
      policy['control-plane'].campaigns['bug-bash'] = {
        orchestrator: 'bug-bash',
        workers: { investigation: { workflow: 'bug-bash-investigation' } },
      };
      await writeFile(policyPath, JSON.stringify(policy));
    },
    configurePages: () => ({ url: 'https://acme.github.io/cao/', public: false }),
    progress: {},
    resolveRootRevision: () => 'a'.repeat(40),
  }), /requires public GitHub Pages/);
  assert.ok(!fixture.calls.some((call) => call[0] === 'gh' && call[1] === 'variable'));
  assert.ok(!fixture.calls.some((call) => call[0] === 'git' && call.includes('commit')));
});
