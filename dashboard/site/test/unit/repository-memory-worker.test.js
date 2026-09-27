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
        fileLimit: 0, fileSize: 0, totalSize: 0, extension: 0, nesting: 0, unsafePath: 0, invalidContent: 0, unsupportedType: 0
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

  it('rejects campaign memory over the total size limit', async () => {
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `file-${index}.txt`,
      oid: 'b'.repeat(40),
      size: 1024 * 1024,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      campaigns: [
        {
          campaign: 'ambient-context',
          branch: 'memory/ambient-context',
          commit: 'a'.repeat(40),
          files,
        },
        {
          campaign: 'other',
          branch: 'memory/other',
          commit: 'c'.repeat(40),
          files: [...files, { path: 'overflow.txt', oid: 'd'.repeat(40), size: 1024 * 1024 }],
        },
      ],
    }))));

    await expect(processDataRequest({
      operation: 'query-repository-memory',
      action: 'list',
      campaign: 'ambient-context',
      memoryRoot: 'http://localhost:3000/memory/',
    })).rejects.toThrow('files exceed the total size limit');
  });

  it('rejects malformed UTF-8 file content', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const content = Uint8Array.of(0xff);
    const campaign = {
      campaign: 'ambient-context',
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{
        path: 'memory.txt',
        oid: 'b'.repeat(40),
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength,
      }],
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, campaigns: [campaign] })))
      .mockResolvedValueOnce(new Response(content)));

    await expect(processDataRequest({
      operation: 'query-repository-memory',
      action: 'content',
      campaign: 'ambient-context',
      path: 'memory.txt',
      memoryRoot: 'http://localhost:3000/memory/',
    })).rejects.toThrow('not valid UTF-8 text');
  });
});
