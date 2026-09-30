// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const evaluatedAt = '2026-09-30T00:00:00Z';
const githubUrlBase = 'https://github.example.com';
const dashboardRepository = 'octo-org/agentic-operations';
const validCommitSha = '0123456789abcdef0123456789abcdef01234567';

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importDashboardFooterWithDebug({ search, output }) {
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
  return import('../../src/components/dashboard-footer.js');
}

describe('dashboard-footer debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFooter } = await importDashboardFooterWithDebug({ search: '', output });

    renderDashboardFooter({ evaluatedAt, commitSha: validCommitSha, githubUrlBase, dashboardRepository });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "dashboard-footer" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFooter } = await importDashboardFooterWithDebug({ search: '?debug=some-other-category', output });

    renderDashboardFooter({ evaluatedAt, commitSha: validCommitSha, githubUrlBase, dashboardRepository });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a linked version rendering under its category when enabled', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFooter } = await importDashboardFooterWithDebug({ search: '?debug=dashboard-footer', output });

    renderDashboardFooter({ evaluatedAt, commitSha: validCommitSha, githubUrlBase, dashboardRepository });

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-footer]', {
      event: 'rendered',
      hasVersion: true,
      validShaFormat: true,
      hasRepository: true,
      linked: true
    });
  });

  it('logs an unlinked version rendering when the SHA is invalid or the repository is unavailable, without leaking their raw values', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFooter } = await importDashboardFooterWithDebug({ search: '?debug=dashboard-footer', output });

    renderDashboardFooter({ evaluatedAt, commitSha: 'not-a-commit', githubUrlBase, dashboardRepository });
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-footer]', {
      event: 'rendered',
      hasVersion: true,
      validShaFormat: false,
      hasRepository: true,
      linked: false
    });

    output.debug.mockClear();
    renderDashboardFooter({ evaluatedAt, commitSha: validCommitSha, githubUrlBase, dashboardRepository: null });
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-footer]', {
      event: 'rendered',
      hasVersion: true,
      validShaFormat: true,
      hasRepository: false,
      linked: false
    });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(JSON.stringify(metadata)).not.toContain('not-a-commit');
      expect(JSON.stringify(metadata)).not.toContain(dashboardRepository);
    }
  });

  it('logs a no-version rendering when the SHA is unavailable or in development', async () => {
    const output = { debug: vi.fn() };
    const { renderDashboardFooter } = await importDashboardFooterWithDebug({ search: '?debug=dashboard-footer', output });

    for (const commitSha of [undefined, 'development']) {
      output.debug.mockClear();
      renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository });
      expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-footer]', {
        event: 'rendered',
        hasVersion: false,
        validShaFormat: false,
        hasRepository: true,
        linked: false
      });
    }
  });
});
