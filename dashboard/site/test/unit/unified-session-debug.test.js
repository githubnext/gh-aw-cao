import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function loadWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/data/adapters/unified-session.js');
  return { ...module, output };
}

const content = [
  { type: 'session.format', data: { version: 1 } },
  { type: 'user.message', timestamp: '2026-10-15T10:00:00Z', data: { content: 'secret prompt text' } },
  { type: 'unknown.event', timestamp: '2026-10-15T10:00:01Z', data: {} }
].map((event) => JSON.stringify(event)).join('\n');

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('unified-session debug logging', () => {
  it('is disabled by default', async () => {
    const { parseUnifiedSession, output } = await loadWithDebug('');
    parseUnifiedSession(content, 'a.jsonl');
    expect(() => parseUnifiedSession('{"type":"x","data":{}}', 'a.jsonl')).toThrow();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs parse counts only under its predictable category', async () => {
    const { parseUnifiedSession, output } = await loadWithDebug('?debug=unified-session');
    expect(parseUnifiedSession(content, 'secret/path.jsonl')).toHaveLength(1);
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:unified-session]', {
      event: 'parsed', records: 3, evidence: 1, skipped: 2, turns: 1
    });
  });

  it('logs rejected formats without paths or content', async () => {
    const { parseUnifiedSession, output } = await loadWithDebug('?debug=unified-session');
    expect(() => parseUnifiedSession('{"type":"x","data":{}}', 'secret/path.jsonl')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:unified-session]', { event: 'format-rejected', records: 1 });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/secret/);
  });

  it('respects exclusions', async () => {
    const { parseUnifiedSession, output } = await loadWithDebug('?debug=*,-unified-session,-model-routing');
    parseUnifiedSession(content, 'a.jsonl');
    expect(output.debug).not.toHaveBeenCalled();
  });
});
