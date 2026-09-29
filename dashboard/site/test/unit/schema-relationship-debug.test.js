import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {string} search debug query string used to enable logging */
async function importRelationshipErrorsWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const { relationshipErrors } = await import('../../src/data/model/schema.js');
  return { relationshipErrors, output };
}

/** @returns {import('../../src/data/model/schema.js').CanonicalBatch} */
function completeBatch() {
  return {
    campaigns: [{ id: 'campaign:fixture:dashboard', slug: 'dashboard' }],
    repositories: [{ id: 'github:repository:1' }],
    workflows: [{
      id: 'github:workflow:2',
      repositoryId: 'github:repository:1',
      campaignId: 'campaign:fixture:dashboard',
      campaign: 'dashboard'
    }],
    runs: [{
      id: 'github:run:1',
      repositoryId: 'github:repository:1',
      workflowId: 'github:workflow:2'
    }],
    domains: [],
    tools: [],
    skills: [],
    friction: [],
    audits: [],
    issues: [],
    operationalValues: [],
    marketplacePackages: []
  };
}

describe('schema relationship validation debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { relationshipErrors, output } = await importRelationshipErrorsWithDebug('');

    relationshipErrors(completeBatch());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs validation-start and validation-passed under its predictable category when enabled', async () => {
    const { relationshipErrors, output } = await importRelationshipErrorsWithDebug('?debug=schema');

    relationshipErrors(completeBatch());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:schema]',
      { event: 'validation-start', workflowCount: 1, runCount: 1 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:schema]',
      { event: 'validation-passed' }
    );
  });

  it('logs validation-failed with only a scalar error count when relationships are dangling', async () => {
    const { relationshipErrors, output } = await importRelationshipErrorsWithDebug('?debug=schema');
    const batch = completeBatch();
    batch.workflows[0].repositoryId = 'github:repository:missing';

    const errors = relationshipErrors(batch);

    expect(errors.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:schema]',
      { event: 'validation-failed', errorCount: errors.length }
    );
  });

  it('never logs record IDs or relationship error text, only scalar counts', async () => {
    const { relationshipErrors, output } = await importRelationshipErrorsWithDebug('?debug=schema');
    const batch = completeBatch();
    batch.workflows[0].repositoryId = 'github:repository:missing';

    relationshipErrors(batch);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/github:repository|github:workflow|does not reference/i);
    }
  });
});
