// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderDashboardFooter } from '../../src/components/dashboard-footer.js';

const evaluatedAt = '2026-09-30T00:00:00Z';

describe('dashboard footer version', () => {
  it('links a commit SHA to its shareable GitHub commit page', () => {
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const footer = renderDashboardFooter({ evaluatedAt, commitSha });
    const version = footer.querySelector('.report-footer-version');
    const link = version?.querySelector('a');

    expect(version?.textContent).toBe('Version 0123456');
    expect(version?.getAttribute('title')).toBe(commitSha);
    expect(link?.getAttribute('href')).toBe(`https://github.com/githubnext/gh-aw-cao/commit/${commitSha}`);
    expect(link?.getAttribute('aria-label')).toBe(`View commit ${commitSha} on GitHub`);
  });

  it('omits the version link when the SHA is unavailable or in development', () => {
    for (const commitSha of [undefined, 'development']) {
      const footer = renderDashboardFooter({ evaluatedAt, commitSha });
      expect(footer.querySelector('.report-footer-version')).toBeNull();
    }
  });

  it('does not link an invalid SHA', () => {
    const footer = renderDashboardFooter({ evaluatedAt, commitSha: 'not-a-commit' });
    expect(footer.querySelector('.report-footer-version')?.querySelector('a')).toBeNull();
  });
});
