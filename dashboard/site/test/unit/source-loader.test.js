import { describe, expect, it, vi } from 'vitest';
import { loadDashboardSources } from '../../src/source-loader.js';

describe('dashboard source loader', () => {
  it('loads split logical sources sequentially', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchSource = vi.fn(async (input) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (pathname.endsWith('/sources/manifest.json')) {
        return new Response(JSON.stringify({ version: 1, sources: ['runs', 'outcomes'] }));
      }
      const name = pathname.endsWith('/runs.json') ? 'runs' : 'outcomes';
      return new Response(JSON.stringify({ source: name, rows: [{ id: name }] }));
    });

    await expect(loadDashboardSources(fetchSource, 'https://example.test/cao/sources.json')).resolves.toEqual({
      runs: { source: 'runs', rows: [{ id: 'runs' }] },
      outcomes: { source: 'outcomes', rows: [{ id: 'outcomes' }] }
    });
    expect(maximumActive).toBe(1);
    expect(fetchSource.mock.calls).toEqual([
      [new URL('https://example.test/cao/sources/manifest.json'), { cache: 'no-store' }],
      [new URL('https://example.test/cao/sources/runs.json'), { cache: 'no-store' }],
      [new URL('https://example.test/cao/sources/outcomes.json'), { cache: 'no-store' }]
    ]);
  });

  it('rejects split sources from a different artifact generation', async () => {
    const generation = 'a'.repeat(64);
    const fetchSource = vi.fn(async (input) => new URL(String(input)).pathname.endsWith('/sources/manifest.json')
      ? new Response(JSON.stringify({ version: 1, generation, sources: ['runs'] }))
      : new Response(JSON.stringify({
        source: 'runs',
        rows: [],
        metadata: { 'artifact-generation': 'b'.repeat(64) }
      })));

    await expect(loadDashboardSources(fetchSource, 'https://example.test/cao/sources.json')).rejects.toThrow(
      'Dashboard source runs does not match the source manifest generation.'
    );
  });

  it('falls back to the monolith only when no split manifest exists', async () => {
    const fetchSource = vi.fn(async (input) => new URL(String(input)).pathname.endsWith('/sources/manifest.json')
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify({ workflows: { source: 'workflows', rows: [] } })));

    await expect(loadDashboardSources(fetchSource, 'https://example.test/cao/sources.json')).resolves.toEqual({
      workflows: { source: 'workflows', rows: [] }
    });
    expect(fetchSource.mock.calls).toEqual([
      [new URL('https://example.test/cao/sources/manifest.json'), { cache: 'no-store' }],
      ['https://example.test/cao/sources.json', { cache: 'no-store' }]
    ]);
  });

  it('does not mask a non-404 manifest failure by falling back to the monolith', async () => {
    const fetchSource = vi.fn(async (input) => new URL(String(input)).pathname.endsWith('/sources/manifest.json')
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ workflows: { source: 'workflows', rows: [] } })));

    await expect(loadDashboardSources(fetchSource, 'https://example.test/cao/sources.json')).rejects.toThrow(
      'Unable to load dashboard source manifest: 503'
    );
    expect(fetchSource).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the monolith when a declared source fails', async () => {
    const fetchSource = vi.fn(async (input) => new URL(String(input)).pathname.endsWith('/sources/manifest.json')
      ? new Response(JSON.stringify({ version: 1, sources: ['runs'] }))
      : new Response('', { status: 503 }));

    await expect(loadDashboardSources(fetchSource, 'https://example.test/cao/sources.json')).rejects.toThrow(
      'Unable to load dashboard source runs: 503'
    );
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });
});