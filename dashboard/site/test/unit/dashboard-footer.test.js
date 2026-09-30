// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderDashboardFooter } from '../../src/components/dashboard-footer.js';

const evaluatedAt = '2026-09-30T00:00:00Z';
const githubUrlBase = 'https://github.example.com';
const dashboardRepository = 'octo-org/agentic-operations';

describe('dashboard footer version', () => {
  it('links a commit SHA to the configured repository on the configured GitHub server', () => {
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const footer = renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository });
    const version = footer.querySelector('.report-footer-version');
    const link = version?.querySelector('a');

    expect(version?.textContent).toBe('Version 0123456');
    expect(version?.getAttribute('title')).toBe(commitSha);
    expect(link?.getAttribute('href')).toBe(`${githubUrlBase}/${dashboardRepository}/commit/${commitSha}`);
    expect(link?.getAttribute('aria-label')).toBe(`View commit ${commitSha} on GitHub`);
  });

  it('omits the version link when the SHA is unavailable or in development', () => {
    for (const commitSha of [undefined, 'development']) {
      const footer = renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository });
      expect(footer.querySelector('.report-footer-version')).toBeNull();
    }
  });

  it('does not link an invalid SHA', () => {
    const footer = renderDashboardFooter({ evaluatedAt, commitSha: 'not-a-commit', githubUrlBase, dashboardRepository });
    expect(footer.querySelector('.report-footer-version')?.querySelector('a')).toBeNull();
  });

  it('does not link a commit when no repository is configured', () => {
    const footer = renderDashboardFooter({
      evaluatedAt, commitSha: '0123456789abcdef0123456789abcdef01234567', githubUrlBase, dashboardRepository: null
    });
    expect(footer.querySelector('.report-footer-version')?.textContent).toBe('Version 0123456');
    expect(footer.querySelector('.report-footer-version a')).toBeNull();
  });
});
