import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { exportOperationalValueEvidence, operationalValueEvidenceJsonl } from '../../.github/skills/add-operational-value/scripts/export-evidence.mjs';
import { writePulse } from '../../.github/skills/add-operational-value/scripts/render-pulse.mjs';
import { adaptCachedGhAwJsonl } from '../../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../dashboard/site/src/data/normalize/index.js';
import { operationalValueEvidenceRows, validateOperationalValueEvidence } from '../../dashboard/site/src/data/model/operational-value-evidence.js';

const ledger = JSON.parse(readFileSync(new URL('../../dashboard/site/test/fixtures/operational-value-ledger.json', import.meta.url)));

test('validated ledger exports original facts through production Activity JSONL normalization', () => {
  const transport = operationalValueEvidenceJsonl(ledger);
  assert.equal(transport, readFileSync(new URL('../../dashboard/site/test/fixtures/operational-value-evidence.jsonl', import.meta.url), 'utf8'));
  const canonical = normalize(adaptCachedGhAwJsonl(transport).observations);
  assert.equal(canonical.operationalValueEvidence.length, 1);
  assert.equal(canonical.repositories.length, 1);
  assert.equal(canonical.workflows.length, 1);
  assert.equal(canonical.workflows[0].state, 'unknown');
  assert.equal(canonical.workflows[0].path, ledger.sourcePath);
  assert.equal(canonical.operationalValueEvidence[0].workflowId, canonical.workflows[0].id);
  assert.equal(canonical.runs.length, 0);
  const rows = operationalValueEvidenceRows(canonical.operationalValueEvidence);
  const header = rows.find(row => row['fact-kind'] === 'contract');
  assert.equal(header['output-unit'], 'issues');
  assert.equal(header['output-coverage'], 'partial');
  assert.equal(header['workflow-name'], 'Verify bugs');
  assert.equal(rows.find(row => row['fact-kind'] === 'implementation').at, ledger.events[0].at);
  assert.equal(rows.find(row => row['fact-kind'] === 'implementation')['accepted-at'], ledger.events[0].acceptance.at);
  assert.ok(rows.every(row => row['report-id'] === header['report-id'] && row.repository === 'example'));
  const snapshots = rows.filter(row => row['fact-kind'] === 'snapshot');
  assert.deepEqual(snapshots.map(row => row['items-available']), [true, true]);
  assert.equal(rows.find(row => row['fact-kind'] === 'snapshot-item')['parent-id'], snapshots[0]['fact-id']);
  assert.equal(rows.filter(row => row['fact-kind'] === 'snapshot-item' && row['parent-id'] === snapshots[1]['fact-id']).length, 0);
  assert.ok(!JSON.stringify(canonical).includes('repositoryComparison'));
});

test('malformed facts fail closed before normalization instead of inventing unavailable evidence', () => {
  const original = exportOperationalValueEvidence(ledger);
  for (const mutate of [
    packet => { packet.repository = 'outside'; },
    packet => { packet.id = 'different'; },
    packet => { packet.facts.push(packet.facts[0]); },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'output-evidence')['parent-id'] = 'missing'; },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'output').url = 'http://github.com'; },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'output').url = 'https://secret@github.com'; },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'snapshot').value = '0'; },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'snapshot').value = Infinity; },
    packet => { packet.facts.find(fact => fact['fact-kind'] === 'snapshot').ref = 'main'; },
    packet => { packet.windowEnd = '2027-01-01T00:00:00Z'; }
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => validateOperationalValueEvidence(changed), /Invalid operational value evidence/);
  }
});

test('standalone exporter rejects mutable acceptance and mismatched retained source identity', () => {
  const mutable = structuredClone(ledger);
  mutable.events[0].acceptance.ref = 'main';
  assert.throws(() => exportOperationalValueEvidence(mutable), /immutable evidence reference/);
  const mismatched = structuredClone(ledger);
  mismatched.sourcePath = '.github/workflows/other.md';
  assert.throws(() => exportOperationalValueEvidence(mismatched), /source identity/);
});

test('shared writePulse publishes adjacent replayable evidence and normal CLI can ingest it', () => {
  const directory = path.resolve(`.cao-evidence-test-${process.pid}`);
  mkdirSync(directory);
  try {
    const output = path.join(directory, 'report-pulse.html');
    writePulse(ledger, output);
    const evidence = output.replace(/\.html$/, '-evidence.jsonl');
    assert.deepEqual(JSON.parse(readFileSync(evidence)), JSON.parse(operationalValueEvidenceJsonl(ledger)));
    const database = path.join(directory, 'dashboard.sqlite');
    execFileSync(process.execPath, ['activity/cao.mjs', 'ingest-jsonl', '--database', database,
      '--input-dir', directory, '--retention-days', 'all'], { stdio: 'pipe' });
    const rows = JSON.parse(execFileSync(process.execPath, ['activity/cao.mjs', 'query',
      '--database', database, '--collection', 'operationalValueEvidence'], { encoding: 'utf8' }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].facts.length, exportOperationalValueEvidence(ledger).facts.length);
    const published = path.join(directory, 'normalized');
    execFileSync(process.execPath, ['activity/cao.mjs', 'hash-payloads', '--database', database,
      '--shard-dir', directory, '--normalized-dir', published, '--output', path.join(directory, 'payload-hashes.json')],
    { stdio: 'pipe' });
    const records = readdirSync(published).filter(name => name.endsWith('.jsonl')).flatMap(name =>
      readFileSync(path.join(published, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const packet = records.find(record => record.collection === 'operationalValueEvidence')?.record;
    assert.equal(packet.id, rows[0].id);
    assert.equal(packet.facts.length, rows[0].facts.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
