// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCampaignMemory } from '../../src/components/campaign-memory.js';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('campaign repository memory', () => {
  it('loads the static manifest and browses campaign files', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        campaigns: [{
          campaign: 'ambient-context',
          branch: 'memory/ambient-context',
          commit: 'a'.repeat(40),
          files: [
            { path: 'notes/first.json', oid: 'b'.repeat(40), size: 14 },
            { path: 'summary.md', oid: 'c'.repeat(40), size: 8 },
          ],
        }],
      })))
      .mockResolvedValueOnce(new Response('{"answer":42}\n'))
      .mockResolvedValueOnce(new Response('# Summary'));
    vi.stubGlobal('fetch', fetch);

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
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:3000/memory/manifest.json',
      'http://localhost:3000/memory/ambient-context/notes/first.json',
      'http://localhost:3000/memory/ambient-context/summary.md',
    ]);
  });

  it('renders honest empty and invalid-manifest states', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      campaigns: [],
    }))));
    const empty = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(empty);
    await vi.waitFor(() => expect(empty.textContent).toContain('No repository memory has been published'));
    empty.remove();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 2,
      campaigns: [],
    }))));
    const invalid = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(invalid);
    await vi.waitFor(() => expect(invalid.textContent).toContain('Repository-memory manifest is invalid.'));
  });

  it('rejects file metadata outside the publication limits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 1,
      campaigns: [{
        campaign: 'ambient-context',
        branch: 'memory/ambient-context',
        commit: 'a'.repeat(40),
        files: [{ path: 'script.js', oid: 'b'.repeat(40), size: 10 }],
      }],
    }))));
    const rendered = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.textContent).toContain(
      'Campaign repository-memory file metadata is invalid.'
    ));
  });

  it('stops reading files that exceed the size limit', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        campaigns: [{
          campaign: 'ambient-context',
          branch: 'memory/ambient-context',
          commit: 'a'.repeat(40),
          files: [{ path: 'large.txt', oid: 'b'.repeat(40), size: 10 }],
        }],
      })))
      .mockResolvedValueOnce(new Response('x', {
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }));
    vi.stubGlobal('fetch', fetch);
    const rendered = renderCampaignMemory({ campaignId: 'ambient-context', campaignName: 'Ambient Context' });
    document.body.append(rendered);

    await vi.waitFor(() => expect(rendered.textContent).toContain(
      'Memory file exceeds the published size limit.'
    ));
  });
});
