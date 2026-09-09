import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activateGeneration,
  activeGeneration,
  activeGenerationIsUsable,
  DATABASE_NAME,
  generationState,
  openCanonicalDatabase,
  readActiveCollection,
  readCheckpoint,
  stageCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';

/** @param {string} generation */
function batch(generation) {
  return normalize([
    {
      kind: 'repository',
      source: 'fixture',
      sourceId: 'repo-1',
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: 'repository:1', fullName: 'githubnext/gh-aw-cao' }
    }
  ], { generation });
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical IndexedDB generations', () => {
  it('initializes the complete database schema', async () => {
    const database = await openCanonicalDatabase(indexedDB);

    expect([...database.objectStoreNames]).toEqual([
      'events',
      'ingestionCheckpoints',
      'jobs',
      'meta',
      'repositories',
      'runs',
      'sessions',
      'sourceMetadata',
      'sourceRecords',
      'workflows'
    ]);
    database.close();
  });

  it('keeps staging rows out of active-generation queries', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a');

    expect(await activeGeneration(indexedDB)).toBeNull();
    expect(await readActiveCollection(indexedDB, 'repositories')).toEqual([]);
  });

  it('activates a complete generation atomically', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a');
    await activateGeneration(indexedDB, 'generation-a');

    expect(await activeGeneration(indexedDB)).toBe('generation-a');
    expect(await readActiveCollection(indexedDB, 'repositories')).toEqual([
      expect.objectContaining({ id: 'repository:1', generation: 'generation-a' })
    ]);
  });

  it('makes duplicate writes idempotent through compound keys', async () => {
    const canonicalBatch = batch('generation-a');
    await stageCanonicalBatch(indexedDB, canonicalBatch, 'generation-a');
    await stageCanonicalBatch(indexedDB, canonicalBatch, 'generation-a');
    await activateGeneration(indexedDB, 'generation-a');

    expect(await readActiveCollection(indexedDB, 'repositories')).toHaveLength(1);
  });

  it('resumes after interruption from the last committed bounded batch', async () => {
    const generation = 'generation-a';
    const canonicalBatch = batch(generation);
    canonicalBatch.repositories.push(...Array.from({ length: 4 }, (_, index) => ({
      id: `repository:${index + 2}`,
      fullName: `githubnext/repository-${index + 2}`,
      generation
    })));

    await expect(stageCanonicalBatch(indexedDB, canonicalBatch, generation, {
      batchSize: 2,
      onBatchCommitted: ({ committedBatches }) => {
        if (committedBatches === 1) throw new Error('simulated interruption');
      }
    })).rejects.toThrow('simulated interruption');
    expect(await activeGeneration(indexedDB)).toBeNull();
    expect(await readCheckpoint(indexedDB, generation)).toBeNull();
    expect(await generationState(indexedDB, generation)).toBe('staging');
    await expect(activateGeneration(indexedDB, generation))
      .rejects.toThrow(`Generation ${generation} is incomplete`);

    await stageCanonicalBatch(indexedDB, canonicalBatch, generation, { batchSize: 2 });
    expect(await readCheckpoint(indexedDB, generation)).toMatchObject({
      status: 'committed',
      recordCount: 5
    });
    await activateGeneration(indexedDB, generation);
    expect(await generationState(indexedDB, generation)).toBe('complete');
    expect(await readActiveCollection(indexedDB, 'repositories')).toHaveLength(5);
  });

  it('stages 100,000 records in bounded transactions', async () => {
    const generation = 'generation-large';
    const canonicalBatch = normalize([], { generation });
    canonicalBatch.repositories = Array.from({ length: 100_000 }, (_, index) => ({
      id: `repository:${index}`,
      generation
    }));
    /** @type {{ committedBatches: number, committedRecords: number }[]} */
    const progress = [];

    await stageCanonicalBatch(indexedDB, canonicalBatch, generation, {
      batchSize: 5_000,
      onBatchCommitted: (value) => {
        progress.push(value);
      }
    });

    expect(progress).toHaveLength(20);
    expect(progress.at(-1)).toEqual({ committedBatches: 20, committedRecords: 100_000 });
    expect(await readCheckpoint(indexedDB, generation)).toMatchObject({
      status: 'committed',
      recordCount: 100_000
    });
  }, 20_000);

  it('preserves the active generation when replacement validation fails', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a');
    await activateGeneration(indexedDB, 'generation-a');
    const invalid = batch('generation-b');
    invalid.workflows.push({
      id: 'workflow:missing-parent',
      repositoryId: 'repository:missing',
      generation: 'generation-b'
    });
    await stageCanonicalBatch(indexedDB, invalid, 'generation-b');

    await expect(activateGeneration(indexedDB, 'generation-b'))
      .rejects.toThrow('Generation relationship validation failed');
    expect(await generationState(indexedDB, 'generation-b')).toBe('failed');
    expect(await activeGeneration(indexedDB)).toBe('generation-a');
    expect(await readActiveCollection(indexedDB, 'repositories')).toEqual([
      expect.objectContaining({ generation: 'generation-a' })
    ]);
  });

  it('atomically switches queries to a replacement and retires the previous generation', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a');
    await activateGeneration(indexedDB, 'generation-a');
    const replacement = batch('generation-b');
    replacement.repositories[0].fullName = 'githubnext/replacement';
    await stageCanonicalBatch(indexedDB, replacement, 'generation-b');
    await activateGeneration(indexedDB, 'generation-b');

    expect(await activeGeneration(indexedDB)).toBe('generation-b');
    expect(await generationState(indexedDB, 'generation-a')).toBe('retired');
    expect(await generationState(indexedDB, 'generation-b')).toBe('complete');
    expect(await readActiveCollection(indexedDB, 'repositories')).toEqual([
      expect.objectContaining({ fullName: 'githubnext/replacement', generation: 'generation-b' })
    ]);
  });

  it('detects missing active records as unusable derived state', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a');
    await activateGeneration(indexedDB, 'generation-a');
    expect(await activeGenerationIsUsable(indexedDB, 'generation-a')).toBe(true);

    const database = await openCanonicalDatabase(indexedDB);
    const transaction = database.transaction('repositories', 'readwrite');
    transaction.objectStore('repositories').delete(['generation-a', 'repository:1']);
    await new Promise((resolve) => { transaction.oncomplete = resolve; });
    database.close();

    expect(await activeGenerationIsUsable(indexedDB, 'generation-a')).toBe(false);
  });
});