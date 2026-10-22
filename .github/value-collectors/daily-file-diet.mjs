import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { refreshFileDiet } from '../skills/add-operational-value/examples/acquire-file-diet.mjs';
import { readFileDietProof } from '../skills/add-operational-value/examples/daily-file-diet.mjs';
import { assertValueHistory } from '../../activity/workflow-value-history.mjs';
import { validateOperationalValueEvidence } from '../../dashboard/site/src/data/model/operational-value-evidence.js';

// Runtime identity of the existing retrospective instrument, not a new evaluator.
export const definition = {
  schemaVersion: 3,
  repository: 'github/gh-aw',
  slug: 'daily-file-diet',
  sourcePath: '.github/workflows/daily-file-diet.md',
  adoption: { commit: '1186030a620f4113f655c156bedf70cf2c164f79', adoptedAt: '2025-11-15T13:36:21Z' },
  evidence: { repositories: ['github/gh-aw'], window: { cadenceDays: 1, maturationDays: 0 } },
};

export async function collectValueEvidence(request, acquire = refreshFileDiet) {
  assert.equal(request.repository.toLowerCase(), definition.repository);
  assert.equal(request.workflow, definition.slug);
  assert.ok(Number.isFinite(Date.parse(request.observedAt)), 'A valid collection cutoff is required');
  const endAt = new Date(request.observedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const retained = path.join(request.workspace.directory, 'latest');
  const staging = await mkdtemp(path.join(request.workspace.directory, '.capture-'));
  const output = path.join(staging, 'report');
  try {
    await acquire({
      endAt, output, scratch: request.workspace.scratch,
      ...(existsSync(retained) ? { previous: path.join(retained, 'proof') } : {}),
    });
    const { proof } = readFileDietProof(path.join(output, 'proof'));
    assert.equal(proof.adoption.commit, definition.adoption.commit, 'Frozen adoption changed');
    assert.equal(proof.adoption.at, definition.adoption.adoptedAt, 'Frozen adoption time changed');
    const envelope = JSON.parse(await readFile(path.join(output, 'daily-file-diet-pulse-evidence.jsonl'), 'utf8'));
    assert.equal(envelope.schema_version, 2);
    assert.equal(envelope.kind, 'operational_value_evidence');
    const packet = validateOperationalValueEvidence(envelope.operational_value_evidence);
    assert.equal(packet.repository, definition.repository);
    assert.equal(packet.workflow, definition.slug);
    assert.equal(Date.parse(packet.windowEnd), Date.parse(endAt));
    assert.ok(Date.parse(packet.observedAt) <= Date.now(), 'Capture cannot be in the future');
    assert.equal(packet.facts.find(fact => fact['fact-kind'] === 'contract')['cadence-days'], 1);
    assert.ok(packet.facts.some(fact => fact['fact-kind'] === 'coverage'));
    assert.ok(packet.facts.filter(fact => fact['fact-kind'] === 'coverage')
      .every(fact => fact['coverage-status'] === 'complete'), 'Incomplete acquisition; retaining accepted proof');
    assertValueHistory(request.previous, packet);
    const retired = path.join(staging, 'retired');
    if (existsSync(retained)) await rename(retained, retired);
    try {
      await rename(output, retained);
    } catch (error) {
      if (existsSync(retired)) await rename(retired, retained);
      throw error;
    }
    return envelope;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
