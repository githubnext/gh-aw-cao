import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertValueHistory, confinedCollector, runWorkflowValues, workflowValueRegistrations } from '../../activity/workflow-values.mjs';
import { parsePolicy } from '../../.github/workflows/shared/policy.mjs';
import { adaptCachedGhAwJsonl } from '../../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../dashboard/site/src/data/normalize/index.js';

const entry = { repository: 'org/repo', workflow: 'daily-review', collector: 'collectors/value.mjs' };
function policy() {
  return { version: 1, 'gh-aw-version': 'v0.92.5', 'control-plane': {
    scope: { 'allowed-owners': ['org'], 'allowed-repositories': ['org/repo'] },
    activity: { repositories: ['org/repo'] }, campaigns: { activity: { 'workflow-values': [entry] } },
  } };
}
function packet(observedAt = '2026-10-20T12:00:00.000Z') {
  return { schema_version: 2, kind: 'operational_value_evidence', operational_value_evidence: {
    schemaVersion: 1, repository: 'org/repo', workflow: 'daily-review', sourcePath: '.github/workflows/daily-review.md',
    id: 'operational-value-evidence:org%2Frepo%3Adaily-review%3Alines%3Av1',
    observedAt, windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-20T00:00:00.000Z',
    contractDigest: 'a'.repeat(64), facts: [
      { 'fact-kind': 'contract', 'fact-id': 'contract', goal: 'Remove waste', acceptance: 'Accepted deletion',
        'workflow-name': 'Review', 'metric-id': 'lines', 'metric-name': 'Lines', 'metric-unit': 'lines',
        'metric-direction': 'increase', 'metric-version': 'v1', 'metric-formula': 'accepted removed lines',
        'measurement-basis': 'workflow-contribution', 'cadence-days': 1,
        'outputs-available': false, 'repository-state-available': false, 'checks-available': false },
      { 'fact-kind': 'coverage', 'fact-id': 'window', at: '2026-10-01T00:00:00.000Z',
        'end-at': '2026-10-20T00:00:00.000Z', 'coverage-status': 'complete' },
    ],
  } };
}

async function fixture(t, body) {
  const root = await mkdtemp(path.resolve('.workflow-values-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'collectors'));
  const policyPath = path.join(root, 'cao.json');
  await writeFile(policyPath, JSON.stringify(policy()));
  const definition = { schemaVersion: 3, repository: entry.repository, slug: entry.workflow,
    sourcePath: '.github/workflows/daily-review.md', adoption: { adoptedAt: '2026-10-01T00:00:00.000Z' },
    evidence: { repositories: ['org/repo'], window: { cadenceDays: 1, maturationDays: 0 } } };
  await writeFile(path.join(root, entry.collector), `
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
export const definition=${JSON.stringify(definition)};
export async function collectValueEvidence(request) {
 await writeFile(path.join(request.workspace.directory,'proof.json'),JSON.stringify({original:true}));
 ${body ?? `return ${JSON.stringify(packet())};`}
}
`);
  return { root, policy: policyPath, database: path.join(root, 'activity.sqlite'),
    repositories: ['org/repo'], workspace: path.join(root, 'proofs'), output: path.join(root, 'values.jsonl'),
    observedAt: '2026-10-20T12:00:00.000Z', timeout: 5000 };
}

test('reviewed opt-ins intersect both effective Activity enrollment and explicit runtime repository scope', () => {
  const document = parsePolicy(JSON.stringify(policy()));
  assert.deepEqual(workflowValueRegistrations(document, ['ORG/REPO']), [entry]);
  assert.deepEqual(workflowValueRegistrations(document, ['org/other']), []);
  document['control-plane'].activity.repositories = ['org/other'];
  assert.deepEqual(workflowValueRegistrations(document, ['org/repo']), []);
  for (const collector of ['../escape.mjs', '/absolute.mjs', 'a//b.mjs', 'https://host/file.mjs']) {
    const invalid = policy();
    invalid['control-plane'].campaigns.activity['workflow-values'][0] = { ...entry, collector };
    assert.throws(() => parsePolicy(JSON.stringify(invalid)));
  }
  const duplicate = policy();
  duplicate['control-plane'].campaigns.activity['workflow-values'] = [entry, { ...entry, repository: 'ORG/REPO' }];
  assert.throws(() => parsePolicy(JSON.stringify(duplicate)), /duplicate/);
});

test('recurring producer emits original typed facts, retains proof, skips satisfied cadence and preserves disabled history', async (t) => {
  const options = await fixture(t);
  assert.equal((await runWorkflowValues(options)).collected, 1);
  const original = await readFile(options.output, 'utf8');
  assert.deepEqual(JSON.parse(original), packet());
  const canonical = normalize(adaptCachedGhAwJsonl(original).observations);
  assert.equal(canonical.operationalValueEvidence.length, 1);
  assert.equal((await runWorkflowValues(options)).skipped, 1);
  assert.equal(await readFile(options.output, 'utf8'), original);
  const [directory] = await readdir(options.workspace);
  assert.deepEqual(await readdir(path.join(options.workspace, directory)), ['proof.json']);
  const revoked = policy();
  revoked['control-plane'].campaigns.activity['workflow-values'] = [{ ...entry, enabled: false }];
  await writeFile(options.policy, JSON.stringify(revoked));
  assert.equal((await runWorkflowValues(options)).collected, 0);
  assert.equal(await readFile(options.output, 'utf8'), original);
});

test('partial acquisition, changed identity and timeout retain accepted evidence without fresh clocks or zero', async (t) => {
  for (const body of [
    `const e=${JSON.stringify(packet())}; e.operational_value_evidence.facts[1]['coverage-status']='partial'; return e;`,
    `const e=${JSON.stringify(packet())}; e.operational_value_evidence.repository='org/other'; return e;`,
    'await new Promise(resolve=>setTimeout(resolve,5000));',
  ]) {
    const options = await fixture(t, body);
    options.timeout = 100;
    const original = `${JSON.stringify(packet('2026-10-19T12:00:00.000Z'))}\n`;
    await writeFile(options.output, original);
    // Older coverage does not satisfy the current cadence.
    const previous = JSON.parse(original);
    previous.operational_value_evidence.windowEnd = '2026-10-19T00:00:00.000Z';
    previous.operational_value_evidence.facts[1]['end-at'] = '2026-10-19T00:00:00.000Z';
    const retained = `${JSON.stringify(previous)}\n`;
    await writeFile(options.output, retained);
    const result = await runWorkflowValues(options);
    assert.equal(result.collected, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(await readFile(options.output, 'utf8'), retained);
  }
});

test('local collector path rejects symlinks and immutable accepted facts cannot be rewritten', async (t) => {
  const options = await fixture(t);
  await symlink(path.join(options.root, 'collectors'), path.join(options.root, 'link'));
  await assert.rejects(confinedCollector(options.root, 'link/value.mjs'), /symlink/);
  const old = packet().operational_value_evidence;
  const incoming = structuredClone(old);
  incoming.observedAt = '2026-10-21T12:00:00.000Z';
  incoming.facts[0]['metric-formula'] = 'redefined';
  assert.throws(() => assertValueHistory(old, incoming), /Immutable/);
});

test('a due capture reuses workflow proofs, preserves original facts, and advances only to the acquired cutoff', async (t) => {
  const options = await fixture(t, `
 const file=path.join(request.workspace.directory,'count.json');
 let count=0; try {count=JSON.parse(await readFile(file,'utf8'));} catch {}
 await writeFile(file,JSON.stringify(count+1));
 const e=${JSON.stringify(packet())};
 if(request.previous){
   if(count!==1) throw new Error('evidence workspace was not reused');
   e.operational_value_evidence=structuredClone(request.previous);
   e.operational_value_evidence.observedAt='2026-10-21T12:00:00.000Z';
   e.operational_value_evidence.windowEnd='2026-10-21T00:00:00.000Z';
   e.operational_value_evidence.facts[1]['end-at']='2026-10-21T00:00:00.000Z';
 }
 return e;
`);
  assert.equal((await runWorkflowValues(options)).collected, 1);
  options.observedAt = '2026-10-21T12:00:00.000Z';
  const result = await runWorkflowValues(options);
  assert.equal(result.collected, 1);
  assert.deepEqual(result.warnings, []);
  const lines = (await readFile(options.output, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'superseded cumulative packets must not create quadratic retained evidence');
  const evidence = JSON.parse(lines[0]).operational_value_evidence;
  assert.equal(evidence.observedAt, options.observedAt);
  assert.equal(evidence.windowStart, packet().operational_value_evidence.windowStart);
  assert.deepEqual(evidence.facts[0], packet().operational_value_evidence.facts[0]);
});
