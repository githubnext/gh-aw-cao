// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureOcticonSprite, octicon } from '../../src/octicons.js';

const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="octicon-alert" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></symbol></svg>';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('octicons', () => {
  it('renders the report-compatible issue glyph without a missing sprite reference', () => {
    const rendered = octicon('issue');

    expect(rendered.classList.contains('octicon-issue')).toBe(true);
    expect(rendered.querySelector('path')?.getAttribute('d')).toBe(
      'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm-.75-9.25a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0ZM8 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'
    );
    expect(rendered.querySelector('use')).toBeNull();
  });

  it('references bundled Octicons through a same-document sprite reference', () => {
    const rendered = octicon('alert');

    expect(rendered.querySelector('use')?.getAttribute('href')).toBe('#octicon-alert');
  });

  it('inlines the deployed sprite once so external references are never required', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(sprite, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOcticonSprite();
    await ensureOcticonSprite();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/src\/octicons\.svg$/);
    const inlined = document.getElementById('octicon-sprite');
    expect(inlined?.querySelector('symbol')?.id).toBe('octicon-alert');
    expect(inlined?.getAttribute('aria-hidden')).toBe('true');

    const rendered = octicon('alert');
    expect(rendered.querySelector('path')).not.toBeNull();
    expect(rendered.querySelector('use')).toBeNull();
  });
});
