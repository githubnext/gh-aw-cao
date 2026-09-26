// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('repository-memory worker protocol', () => {
  it('lists files and returns verified content from static memory data', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const content = '# Memory\n';
    const campaign = {
      campaign: 'ambient-context',
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{
        path: 'notes/memory.md',
        oid: 'b'.repeat(40),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
      }],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, campaigns: [campaign] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, campaigns: [campaign] })))
      .mockResolvedValueOnce(new Response(content));
    vi.stubGlobal('fetch', fetch);
    const base = {
      operation: 'query-repository-memory',
      campaign: 'ambient-context',
      memoryRoot: 'http://localhost:3000/memory/',
    };

    await expect(processDataRequest({ ...base, action: 'list' })).resolves.toMatchObject({
      branch: 'memory/ambient-context',
      files: [{ path: 'notes/memory.md' }],
    });
    await expect(processDataRequest({
      ...base,
      action: 'content',
      path: 'notes/memory.md',
    })).resolves.toEqual({ content });
  });

  it('returns null for a missing branch and rejects unmanifested files', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, campaigns: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        campaigns: [{
          campaign: 'ambient-context',
          branch: 'memory/ambient-context',
          commit: 'a'.repeat(40),
          files: [],
        }],
      }))));
    const base = {
      operation: 'query-repository-memory',
      campaign: 'ambient-context',
      memoryRoot: 'http://localhost:3000/memory/',
    };

    await expect(processDataRequest({ ...base, action: 'list' })).resolves.toBeNull();
    await expect(processDataRequest({
      ...base,
      action: 'content',
      path: 'not-listed.md',
    })).rejects.toThrow('Memory file path is invalid.');
  });
});
