// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('repository-memory worker protocol', () => {
  it('formats Raw JSON and JSONL content through the worker boundary, preserving invalid records', () => {
    const prepare = (/** @type {string} */ path, /** @type {string} */ content) =>
      processDataRequest({ operation: 'prepare-repository-memory-file', path, content });
    expect(prepare('notes.json', '{"answer":42,"nested":{"ok":true}}\n'))
      .toEqual({ content: '{\n  "answer": 42,\n  "nested": {\n    "ok": true\n  }\n}\n' });
    expect(prepare('transactions.jsonl', '{"id":1}\r\nnot-json\r\n\r\n{"id":2,"ok":true}'))
      .toMatchObject({ content: '{\n  "id": 1\n}\r\nnot-json\r\n\r\n{\n  "id": 2,\n  "ok": true\n}' });
    expect(prepare('notes.md', '{"answer":42}')).toEqual({ content: '{"answer":42}' });
    expect(prepare('broken.json', '{"answer":')).toEqual({ content: '{"answer":' });
  });

  it('parses JSONL into ordered columns and physical line numbers through the worker boundary', () => {
    expect(processDataRequest({
      operation: 'prepare-repository-memory-file', path: 'records.jsonl',
      content: '{"id":2,"nested":{"ok":true},"nullable":null}\r\n\r\n{"id":1,"later":[1,2],"html":"<script>"}\n',
    })).toMatchObject({ table: {
      columns: ['id', 'nested', 'nullable', 'later', 'html'],
      rows: [
        { line: 1, cells: ['2', '{"ok":true}', 'null', '', ''] },
        { line: 3, cells: ['1', '', '', '[1,2]', '<script>'] },
      ],
      error: '',
    } });
  });

  it('preserves scalar, array, empty-object, and unusual-key JSON records', () => {
    expect(processDataRequest({
      operation: 'prepare-repository-memory-file', path: 'records.jsonl',
      content: '{"__proto__":"safe","constructor":false,"":0}\n{}\nnull\nfalse\n0\n""\n[1,2]',
    })).toMatchObject({ table: {
      columns: ['__proto__', 'constructor', '', 'Value (non-object)'],
      rows: [
        { line: 1, cells: ['safe', 'false', '0', ''] },
        { line: 2, cells: ['', '', '', ''] },
        { line: 3, cells: ['', '', '', 'null'] },
        { line: 4, cells: ['', '', '', 'false'] },
        { line: 5, cells: ['', '', '', '0'] },
        { line: 6, cells: ['', '', '', ''] },
        { line: 7, cells: ['', '', '', '[1,2]'] },
      ],
      error: '',
    } });
  });

  it('reports malformed records and rejects invalid or oversized parser requests', () => {
    expect(processDataRequest({
      operation: 'prepare-repository-memory-file', path: 'records.jsonl', content: '{"id":1}\n\nbad\n{"id":2}',
    })).toMatchObject({ table: { columns: [], rows: [], error: 'Invalid JSON on line 3. Use Raw to inspect the file.' } });
    expect(() => processDataRequest({
      operation: 'prepare-repository-memory-file', path: 'records.jsonl', content: {},
    })).toThrow('must be text');
    expect(() => processDataRequest({
      operation: 'prepare-repository-memory-file', path: 'records.jsonl', content: 'x'.repeat(1024 * 1024 + 1),
    })).toThrow('size limit');
  });

  it('lists all requested campaigns from one manifest without inventing missing entries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      campaigns: [{
        campaign: 'available',
        branch: 'memory/available',
        commit: 'a'.repeat(40),
        files: [{ path: 'notes.md', oid: 'b'.repeat(40), size: 5 }],
        omitted: {},
      }],
    })));
    vi.stubGlobal('fetch', fetch);

    await expect(processDataRequest({
      operation: 'query-repository-memory',
      action: 'list-campaigns',
      campaigns: ['missing', 'available'],
      memoryRoot: 'http://localhost:3000/memory/',
    })).resolves.toMatchObject([null, { branch: 'memory/available', files: [{ path: 'notes.md' }] }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(processDataRequest({
      operation: 'query-repository-memory',
      action: 'list-campaigns',
      campaigns: ['invalid/id'],
      memoryRoot: 'http://localhost:3000/memory/',
    })).rejects.toThrow('Repository-memory campaign is invalid.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

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
