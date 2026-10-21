// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import ledger from '../fixtures/operational-value-ledger.json' with { type: 'json' };
import { execFileSync } from 'node:child_process';

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  return { ...(await import('../../src/data/model/operational-value-evidence.js')), output };
}

/** @returns {Record<string, any>} */
const packet = () => JSON.parse(execFileSync(process.execPath,
  ['../../.github/skills/add-operational-value/scripts/export-evidence.mjs'],
  { input: JSON.stringify(ledger), encoding: 'utf8' })).operational_value_evidence;

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('operational value evidence debug logging', () => {
  it('is silent by default', async () => {
    const { mergeOperationalValueEvidence, output } = await load('');
    const incoming = packet();
    mergeOperationalValueEvidence(incoming, incoming);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs only scalar merge metadata under its category', async () => {
    const { mergeOperationalValueEvidence, output } = await load('?debug=operational-value-evidence');
    const incoming = packet();
    mergeOperationalValueEvidence(incoming, incoming);
    expect(output.debug).toHaveBeenCalledWith('[cao:operational-value-evidence]',
      { event: 'merge', outcome: 'replaced', factCount: incoming.facts.length });

    output.debug.mockClear();
    expect(() => mergeOperationalValueEvidence(incoming, { ...incoming, contractDigest: 'f'.repeat(64) })).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:operational-value-evidence]', { event: 'merge', outcome: 'contract-changed' });
    const logged = JSON.stringify(output.debug.mock.calls);
    expect(logged).not.toContain(incoming.repository);
    expect(logged).not.toContain(incoming.contractDigest);
  });

  it('is excluded by other category filters', async () => {
    const { mergeOperationalValueEvidence, output } = await load('?debug=data,-operational-value-*');
    const incoming = packet();
    mergeOperationalValueEvidence(incoming, incoming);
    expect(output.debug).not.toHaveBeenCalled();
  });
});
