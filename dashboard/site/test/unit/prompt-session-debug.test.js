// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const meta = document.createElement('meta');
  meta.name = 'dashboard-copilot-session';
  meta.content = '/session';
  document.head.append(meta);
  const { createPromptSessionControl } = await import('../../src/components/prompt-session.js');
  return { output, control: createPromptSessionControl(() => 'secret prompt text') };
}

describe('prompt session debug logging', () => {
  it('is silent by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    const { output, control } = await load('');
    control?.button.click();
    await vi.waitFor(() => expect(control?.button.disabled).toBe(true));
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs requested and started under its predictable category without the prompt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    const { output, control } = await load('?debug=prompt-session');
    control?.button.click();
    await vi.waitFor(() => expect(control?.status.textContent).toContain('Session started'));
    expect(output.debug).toHaveBeenCalledWith('[cao:prompt-session]', { event: 'start', status: 'requested' });
    expect(output.debug).toHaveBeenCalledWith('[cao:prompt-session]', { event: 'start', status: 'started', httpStatus: 200 });
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('secret prompt text');
  });

  it('logs failures with a sanitized error name only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'private detail' }) })));
    const { output, control } = await load('?debug=prompt-session');
    control?.button.click();
    await vi.waitFor(() => expect(output.debug).toHaveBeenCalledWith(
      '[cao:prompt-session]', { event: 'start', status: 'failed', errorName: 'Error' }
    ));
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('private detail');
  });
});
