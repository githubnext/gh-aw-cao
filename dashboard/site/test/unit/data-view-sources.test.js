import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { loadCanonicalViewSources } from '../../src/data/queries/view-sources.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sources = {
  repositories: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }], metadata },
  workflows: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' }], metadata },
  runs: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'run-status': 'completed', 'run-conclusion': 'failure',
      'started-at': '2026-09-09T04:00:00Z', 'failure-detail': 'Build failed',
      'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
      'requested-model': 'model-a', 'resolved-model': 'model-b',
      'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42', label: 'Run 42' }
    }],
    metadata
  },
  'job-performance': {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'job-id': '99', job: 'build',
      'job-status': 'completed', 'job-conclusion': 'failure', 'job-duration-seconds': 120,
      'started-at': '2026-09-09T04:01:00Z', runner: 'ubuntu-latest', engine: 'copilot', model: 'model-b'
    }],
    metadata
  },
  usage: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42', aic: 17 }],
    metadata
  }
};

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical view sources', () => {
  it('projects failed-run evidence from the active canonical generation', async () => {
    const projected = await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-attempt': 2, 'run-conclusion': 'failure', 'failure-detail': 'Build failed' }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.runs).toMatchObject({
      source: 'runs',
      rows: [{
        repository: 'gh-aw-cao', run: '42', 'run-attempt': 2,
        'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
        'requested-model': 'model-a', 'resolved-model': 'model-b'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.repositories).toMatchObject({
      source: 'repositories',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.workflows).toMatchObject({
      source: 'workflows',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected['job-performance']).toMatchObject({
      source: 'job-performance',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', run: '42',
        'run-attempt': 2, 'job-id': '99', job: 'build',
        'job-duration-seconds': 120, runner: 'ubuntu-latest', engine: 'copilot', model: 'model-b'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(Reflect.get(projected, 'usage')).toEqual({
      source: 'usage',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42', aic: 17 }],
      metadata
    });
  });

  it('rejects a generation that is not active and usable', async () => {
    await expect(loadCanonicalViewSources(indexedDB, sources)).rejects.toThrow(
      'Canonical generation generation-a is not active and usable'
    );
  });
});