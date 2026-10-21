import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupCaoControlPlane } from '../../activity/setup.mjs';
import { runSetup } from '../../activity/commands/setup.mjs';

async function fixture(t, { visibility = 'PUBLIC', modeFailure = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-public-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = path.join(root, '.github/workflows/cao.json');
  const policy = { version: 1, 'control-plane': {
    scope: { 'allowed-owners': ['acme'], 'allowed-repositories': ['acme/control'] },
    campaigns: {}, workflows: {}, operations: {},
  } };
  await mkdir(path.dirname(policyPath), { recursive: true });
  await writeFile(policyPath, JSON.stringify(policy));
  const calls = [];
  return {
    policy, policyPath, calls,
    saved: async () => JSON.parse(await readFile(policyPath, 'utf8')),
    options: {
      policyPath, publicOnly: true, repositories: ['octo/*'],
      output: { write() {} },
      setupAuthentication: () => assert.fail('public monitoring cannot configure user credentials'),
      execute(binary, args) {
        assert.equal(binary, 'gh');
        calls.push(args);
        const command = args.join(' ');
        if (command === 'auth status') return { status: 0 };
        if (command === 'repo view --json nameWithOwner --jq .nameWithOwner') return { status: 0, stdout: 'acme/control' };
        if (args[0] === 'repo' && args[1] === 'view') return {
          status: 0, stdout: JSON.stringify({ nameWithOwner: args[2], visibility }),
        };
        if (args[0] === 'repo' && args[1] === 'list') return {
          status: 0, stdout: JSON.stringify([
            { nameWithOwner: 'octo/public', visibility: 'PUBLIC' },
            { nameWithOwner: 'octo/private', visibility: 'PRIVATE' },
            { nameWithOwner: 'octo/internal', visibility: 'INTERNAL' },
          ]),
        };
        if (command === 'api repos/acme/control/pages') return {
          status: 0, stdout: '{"build_type":"workflow","public":true}',
        };
        if (command === 'variable set GH_AW_GITHUB_AUTH_MODE --repo acme/control --body workflow-token') {
          return { status: modeFailure ? 1 : 0, stderr: modeFailure ? 'mode denied' : '' };
        }
        assert.fail(`Unexpected command: ${command}`);
      },
    },
  };
}

test('public quickstart snapshots public repositories without App/PAT prompts and is repeatable', async (t) => {
  const f = await fixture(t);
  const result = await setupCaoControlPlane(f.options);
  assert.equal(result.profile, 'public-only');
  assert.deepEqual(result.repositories, ['acme/control', 'octo/public']);
  const saved = await f.saved();
  assert.deepEqual(saved['control-plane'].activity, {
    repositories: result.repositories, 'public-only': true,
  });
  assert.deepEqual(saved['control-plane'].campaigns, {});
  assert.deepEqual(saved['control-plane'].workflows, {});
  assert.deepEqual(saved['control-plane'].operations, {});
  assert.ok(f.calls.every((args) => !args.includes('secret') && !args.includes('workflow')));
  const repeated = await setupCaoControlPlane({ ...f.options, repositories: [] });
  assert.deepEqual(repeated.repositories, result.repositories);
});

test('guided all-public setup skips authentication selection for exact and wildcard scopes', async (t) => {
  for (const scope of ['acme/control', 'octo/public', 'octo/*', 'acme/control,octo/*']) {
    const f = await fixture(t);
    const execute = f.options.execute;
    const result = await setupCaoControlPlane({
      ...f.options, publicOnly: false,
      execute(binary, args) {
        if (args[1] === 'list') return {
          status: 0, stdout: '[{"nameWithOwner":"octo/public","visibility":"PUBLIC"}]',
        };
        return execute(binary, args);
      },
      prompt: {
        note() {},
        text: async () => scope,
        select: async () => assert.fail('all-public scope must not prompt for authentication'),
        confirm: async () => true,
      },
    });
    assert.equal(result.profile, 'public-only');
    assert.equal(result.authentication.mode, 'workflow-token');
    assert.deepEqual(result.repositories, scope === 'acme/control'
      ? ['acme/control'] : ['acme/control', 'octo/public']);
    assert.deepEqual((await f.saved())['control-plane'].activity, {
      repositories: result.repositories, 'public-only': true,
    });
  }
});

test('selecting an App for a now-private scope clears the collection-only profile', async (t) => {
  const f = await fixture(t);
  await setupCaoControlPlane(f.options);
  const result = await setupCaoControlPlane({
    ...f.options, publicOnly: false,
    execute(binary, args) {
      if (args[1] === 'view' && !args.includes('--jq')) return {
        status: 0, stdout: '{"nameWithOwner":"acme/control","visibility":"PRIVATE"}',
      };
      return f.options.execute(binary, args);
    },
    prompt: {
      note() {},
      text: async () => 'acme/control',
      select: async () => 'github-app',
      confirm: async () => true,
    },
    setupAuthentication: async (profile) => ({ profile }),
  });
  assert.equal(result.profile, 'github-app');
  assert.deepEqual((await f.saved())['control-plane'].activity, {
    repositories: ['acme/control'],
  });
});

test('guided setup keeps authentication for nonpublic scopes and fails closed on incomplete lookups', async (t) => {
  for (const scope of ['octo/target', 'octo/*']) {
    for (const visibility of ['PUBLIC', 'PRIVATE', 'INTERNAL', 'UNKNOWN', '', 'failed']) {
      const f = await fixture(t, { visibility: 'PRIVATE' });
      let selections = 0;
      const options = {
        ...f.options, publicOnly: false,
        execute(binary, args) {
          if (args[1] === 'list' || args[2] === 'octo/target') {
            if (visibility === 'failed') return { status: 1, stderr: 'lookup denied' };
            const record = { nameWithOwner: 'octo/target', visibility };
            return { status: 0, stdout: JSON.stringify(args[1] === 'list' ? [record] : record) };
          }
          return f.options.execute(binary, args);
        },
        prompt: {
          note() {},
          text: async () => scope,
          select: async (_, choices) => {
            selections++;
            assert.deepEqual(choices.map(({ value }) => value), ['enterprise-app', 'approved-app', 'token']);
            return 'token';
          },
          confirm: async () => false,
        },
      };
      if (visibility === 'failed') {
        await assert.rejects(setupCaoControlPlane(options), /lookup denied/);
        assert.equal(selections, 0);
      } else {
        assert.equal((await setupCaoControlPlane(options)).cancelled, true);
        assert.equal(selections, 1);
      }
      assert.deepEqual(await f.saved(), f.policy);
      assert.ok(f.calls.every((args) => args[0] === 'auth' || args[0] === 'repo'));
    }
  }
});

test('public quickstart rejects non-public control or exact target and preserves policy on failures', async (t) => {
  for (const visibility of ['PRIVATE', 'INTERNAL']) {
    const f = await fixture(t, { visibility });
    await assert.rejects(setupCaoControlPlane(f.options), /public control repository/);
    assert.deepEqual(await f.saved(), f.policy);
    assert.ok(f.calls.every((args) => args[0] === 'auth' || args[0] === 'repo'));
  }
  const f = await fixture(t);
  const execute = f.options.execute;
  await assert.rejects(setupCaoControlPlane({
    ...f.options, repositories: ['octo/private'],
    execute(binary, args) {
      if (args[2] === 'octo/private') return {
        status: 0, stdout: '{"nameWithOwner":"octo/private","visibility":"PRIVATE"}',
      };
      return execute(binary, args);
    },
  }), /cannot include/);
  assert.deepEqual(await f.saved(), f.policy);
  const failure = await fixture(t, { modeFailure: true });
  await assert.rejects(setupCaoControlPlane(failure.options), /stopped during workflow-token authentication/);
  assert.deepEqual(await failure.saved(), failure.policy);
});

test('Node setup infers public monitoring from explicit repeatable repository scope without an auth flag', async () => {
  const result = await runSetup({
    arguments_: ['--repository', 'acme/*', '--repository', 'octo/public'],
    setupCaoControlPlane: (options) => options, UsageError: Error,
  });
  assert.equal(result.publicOnly, true);
  assert.deepEqual(result.repositories, ['acme/*', 'octo/public']);
  assert.throws(() => runSetup({ arguments_: ['--public-only'], UsageError: Error }), /Missing value|Unknown option/);
});
