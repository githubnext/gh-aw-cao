// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAllCampaignMemory, renderCampaignMemory } from '../../src/components/campaign-memory.js';
import { resetSourceStore } from '../../src/source-store.js';

const memoryApi = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../src/data-processor.js', () => ({
  listRepositoryMemory: memoryApi.list,
  readRepositoryMemoryFile: memoryApi.read,
}));

beforeEach(resetSourceStore);
afterEach(() => {
  resetSourceStore();
  memoryApi.list.mockReset();
  memoryApi.read.mockReset();
  document.body.replaceChildren();
});

describe('campaign repository memory', () => {
  it('browses every campaign memory in place', async () => {
    memoryApi.list
      .mockResolvedValueOnce({
        branch: 'memory/ambient-context',
        commit: 'a'.repeat(40),
        files: [{ path: 'ambient.md', oid: 'b'.repeat(40), size: 9 }],
        omitted: {},
      })
      .mockResolvedValueOnce({
        branch: 'memory/security-review',
        commit: 'c'.repeat(40),
        files: [{ path: 'security.md', oid: 'd'.repeat(40), size: 10 }],
        omitted: {},
      });
    memoryApi.read
      .mockResolvedValueOnce({ content: '# Ambient' })
      .mockResolvedValueOnce({ content: '# Security' });

    const rendered = renderAllCampaignMemory({
      pageId: 'memory',
      title: 'Campaign memory',
      sourceNames: ['campaign-memory-campaigns'],
      sources: {
        'campaign-memory-campaigns': {
          source: 'campaign-memory-campaigns',
          rows: [
            { campaign: 'ambient-context', 'campaign-name': 'Ambient Context' },
            { campaign: 'security-review', 'campaign-name': 'Security Review' },
          ],
          metadata: {
            'source-id': 'campaign-memory-test',
            'source-kind': 'fixture',
            'as-of': '2026-09-26T00:00:00Z',
            'retrieved-at': '2026-09-26T00:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available',
          },
        },
      },
      contextDetails: [],
      headingTag: 'h3',
    });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.querySelector('pre')?.textContent).toBe('# Ambient'));
    expect([...rendered.querySelectorAll('.cao-memory-campaign')].map((node) => node.textContent))
      .toEqual(['Ambient Context', 'Security Review']);

    /** @type {HTMLButtonElement} */ (rendered.querySelectorAll('.cao-memory-campaign')[1]).click();
    await vi.waitFor(() => expect(rendered.querySelector('pre')?.textContent).toBe('# Security'));
    expect(location.hash).toBe('');
    expect(memoryApi.list.mock.calls.map(([campaign]) => campaign))
      .toEqual(['ambient-context', 'security-review']);
  });

  it('renders an honest empty state when no campaigns are registered', () => {
    const rendered = renderAllCampaignMemory({
      pageId: 'memory',
      title: 'Campaign memory',
      sourceNames: ['campaign-memory-campaigns'],
      sources: {},
      contextDetails: [],
      headingTag: 'h3',
    });

    expect(rendered.textContent).toBe('No campaigns are registered.');
    expect(memoryApi.list).not.toHaveBeenCalled();
  });

  it('loads the static manifest and browses campaign files', async () => {
    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [
        { path: 'notes/first.json', oid: 'b'.repeat(40), size: 14 },
        { path: 'summary.md', oid: 'c'.repeat(40), sha256: 'e'.repeat(64), size: 8 },
      ],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    });
    memoryApi.read
      .mockResolvedValueOnce({ content: '{"answer":42}\n' })
      .mockResolvedValueOnce({ content: '# Summary' });

    const rendered = renderCampaignMemory({
      campaignId: 'ambient-context',
      campaignName: 'Ambient Context',
    });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.querySelector('pre')?.textContent).toBe('{"answer":42}\n'));
    expect(rendered.querySelector('.campaign-memory-branch')?.textContent).toContain('memory/ambient-context');
    expect([...rendered.querySelectorAll('.campaign-memory-file span')].map((node) => node.textContent))
      .toEqual(['notes/first.json', 'summary.md']);

    rendered.querySelectorAll('button')[1].click();
    await vi.waitFor(() => expect(rendered.querySelector('pre')?.textContent).toBe('# Summary'));
    expect(memoryApi.read.mock.calls.map(([campaign, path]) => [campaign, path])).toEqual([
      ['ambient-context', 'notes/first.json'],
      ['ambient-context', 'summary.md'],
    ]);
  });

  it('renders honest empty and invalid-manifest states', async () => {
    memoryApi.list.mockResolvedValueOnce(null);
    const empty = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(empty);
    await vi.waitFor(() => expect(empty.textContent).toContain(
      'No repository-memory branch has been published'
    ));
    empty.remove();

    memoryApi.list.mockRejectedValueOnce(new Error('Repository-memory manifest is invalid.'));
    const invalid = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(invalid);
    await vi.waitFor(() => expect(invalid.textContent).toContain('Repository-memory manifest is invalid.'));
  });

  it('renders empty branches and warns when excluded files make the view incomplete', async () => {
    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [],
      omitted: {
        fileLimit: 1,
        fileSize: 2,
        totalSize: 1,
        extension: 3,
        nesting: 0,
        unsafePath: 0,
        invalidContent: 1,
        unsupportedType: 0,
      },
    });
    const rendered = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.textContent).toContain(
      'The repository-memory branch contains no supported files.'
    ));
    expect(rendered.querySelector('.campaign-memory-warning')?.textContent).toContain(
      'This view does not represent the entire memory branch'
    );
    expect(rendered.querySelector('.campaign-memory-warning')?.textContent).toContain(
      '1 excluded by the file-count limit, 2 excluded by the file-size limit'
    );
    expect(rendered.querySelector('.campaign-memory-warning')?.textContent).toContain(
      '3 excluded by unsupported file extensions'
    );
    expect(rendered.querySelector('.campaign-memory-warning')?.textContent).toContain(
      '1 excluded by invalid text content'
    );
    expect(rendered.querySelector('.campaign-memory-warning')?.textContent).toContain(
      '1 excluded by the total-size limit'
    );
  });

  it('rejects file metadata outside the publication limits', async () => {
    memoryApi.list.mockRejectedValue(new Error('Campaign repository-memory file metadata is invalid.'));
    const rendered = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.textContent).toContain(
      'Campaign repository-memory file metadata is invalid.'
    ));
  });

  it('stops reading files that exceed the size limit', async () => {
    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{ path: 'large.txt', oid: 'b'.repeat(40), sha256: 'c'.repeat(64), size: 10 }],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    });
    memoryApi.read.mockRejectedValue(new Error('Memory file exceeds the published size limit.'));
    const rendered = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.textContent).toContain(
      'Memory file exceeds the published size limit.'
    ));
  });

  it('stays silent by default and logs only scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=campaign-memory', output })
      };
    });
    vi.resetModules();
    const { renderCampaignMemory: renderCampaignMemoryWithDebug } = await import('../../src/components/campaign-memory.js');

    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{ path: 'notes/first.json', oid: 'b'.repeat(40), size: 14 }],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    });
    memoryApi.read.mockResolvedValueOnce({ content: '{"answer":42}\n' });

    const rendered = renderCampaignMemoryWithDebug({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-memory]',
      { operation: 'list-manifest', status: 'ready', fileCount: 1 }
    ));
    await vi.waitFor(() => expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-memory]',
      { operation: 'read-file', status: 'ready', contentLength: '{"answer":42}\n'.length }
    ));

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    rendered.remove();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs a read-file error with only the error name, never the message', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=campaign-memory', output })
      };
    });
    vi.resetModules();
    const { renderCampaignMemory: renderCampaignMemoryWithDebug } = await import('../../src/components/campaign-memory.js');

    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{ path: 'large.txt', oid: 'b'.repeat(40), sha256: 'c'.repeat(64), size: 10 }],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    });
    memoryApi.read.mockRejectedValue(new Error('Memory file exceeds the published size limit.'));

    const rendered = renderCampaignMemoryWithDebug({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-memory]',
      { operation: 'read-file', status: 'error', errorName: 'Error' }
    ));
    const loggedValues = output.debug.mock.calls.flatMap((call) => Object.values(call[1]));
    expect(loggedValues.some((value) => typeof value === 'string' && value.includes('published size limit'))).toBe(false);

    rendered.remove();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { renderCampaignMemory: renderCampaignMemoryWithoutDebug } = await import('../../src/components/campaign-memory.js');

    memoryApi.list.mockResolvedValue({
      branch: 'memory/ambient-context',
      commit: 'a'.repeat(40),
      files: [{ path: 'notes/first.json', oid: 'b'.repeat(40), size: 14 }],
      omitted: {
        fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0
      },
    });
    memoryApi.read.mockResolvedValueOnce({ content: '{"answer":42}\n' });

    const rendered = renderCampaignMemoryWithoutDebug({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);
    await vi.waitFor(() => expect(rendered.querySelector('pre')?.textContent).toBe('{"answer":42}\n'));

    expect(output.debug).not.toHaveBeenCalled();

    rendered.remove();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
