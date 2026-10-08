// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOcticonRenderer, octicon } from '../../src/octicons.js';

afterEach(() => document.body.replaceChildren());

describe('octicons', () => {
  it('renders the report-compatible issue glyph without a missing sprite reference', () => {
    const rendered = octicon('issue');

    expect(rendered.classList.contains('octicon-issue')).toBe(true);
    expect(rendered.querySelector('path')?.getAttribute('d')).toBe(
      'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm-.75-9.25a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0ZM8 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'
    );
    expect(rendered.querySelector('use')).toBeNull();
  });

  describe('deferred supported Octicons', () => {
    const core = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="octicon-question"><path d="M0 0"/></symbol></svg>';
    const full = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="octicon-question"><path d="M0 0"/></symbol><symbol id="octicon-extra"><path d="M1 1"/></symbol></svg>';

    it('shares the complete sprite load and fills supported inline glyphs', async () => {
      /** @type {(value: string) => void} */
      let release = () => {};
      const pending = new Promise((resolve) => { release = resolve; });
      const loadSprite = vi.fn(() => pending);
      const render = createOcticonRenderer({ sprite: core, names: ['question', 'extra'], loadSprite, onError: vi.fn() });
      const first = render('extra');
      const second = render('extra');
      document.body.append(first, second);
      expect(first.dataset.iconState).toBe('loading');
      expect(loadSprite).toHaveBeenCalledTimes(1);
      release(full);
      await vi.waitFor(() => expect(first.dataset.iconState).toBe('available'));
      expect(first.querySelector('path')?.getAttribute('d')).toBe('M1 1');
      expect(second.querySelector('path')?.getAttribute('d')).toBe('M1 1');
      expect(first.querySelector('use')).toBeNull();
      expect(render('extra').querySelector('path')?.getAttribute('d')).toBe('M1 1');
      expect(loadSprite).toHaveBeenCalledTimes(1);
    });

    it('does not update a detached icon after its shared asset resolves', async () => {
      /** @type {(value: string) => void} */
      let release = () => {};
      const pending = new Promise((resolve) => { release = resolve; });
      const render = createOcticonRenderer({
        sprite: core, names: ['question', 'extra'], loadSprite: () => pending, onError: vi.fn()
      });
      const rendered = render('extra');
      document.body.append(rendered);
      rendered.remove();
      release(full);
      await pending;
      await Promise.resolve();
      expect(rendered.querySelector('path')?.getAttribute('d')).toBe('M0 0');
    });

    it('finishes an owned icon when its asset resolves before attachment', async () => {
      const render = createOcticonRenderer({
        sprite: core, names: ['question', 'extra'], loadSprite: async () => full, onError: vi.fn()
      });
      const rendered = render('extra');
      await vi.waitFor(() => expect(rendered.dataset.iconState).toBe('available'));
      document.body.append(rendered);
      expect(rendered.querySelector('path')?.getAttribute('d')).toBe('M1 1');
    });

    it('reports a failed shared asset and keeps unknown names synchronous', async () => {
      const error = new Error('Sprite unavailable');
      const onError = vi.fn();
      const loadSprite = vi.fn(async () => { throw error; });
      const render = createOcticonRenderer({ sprite: core, names: ['question', 'extra'], loadSprite, onError });
      expect(render('unknown').querySelector('path')?.getAttribute('d')).toBe('M0 0');
      expect(loadSprite).not.toHaveBeenCalled();
      const first = render('extra');
      const second = render('extra');
      document.body.append(first, second);
      await vi.waitFor(() => expect(first.dataset.iconState).toBe('unavailable'));
      expect(second.dataset.iconState).toBe('unavailable');
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    });
  });

  it('renders bundled Octicons directly from JavaScript', () => {
    const rendered = octicon('alert');

    expect(rendered.querySelector('path')).not.toBeNull();
    expect(rendered.querySelector('use')).toBeNull();
  });

  it('uses an inlined fallback for unknown icon names', () => {
    const rendered = octicon('not-an-octicon');
    expect(rendered.querySelector('path')).not.toBeNull();
    expect(rendered.querySelector('use')).toBeNull();
  });
});
