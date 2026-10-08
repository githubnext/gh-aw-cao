// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { renderDashboardFooter } from '../../src/components/dashboard-footer.js';
import { dashboardAppUpdateDownloading } from '../../src/dashboard-app-update-state.js';

const evaluatedAt = '2026-09-30T00:00:00Z';
const githubUrlBase = 'https://github.example.com';
const dashboardRepository = 'octo-org/agentic-operations';

afterEach(() => {
  document.body.replaceChildren();
  dashboardAppUpdateDownloading.set(false);
});

describe('dashboard footer version', () => {
  it('reactively shows an accessible download icon beside the existing version link', () => {
    const footer = renderDashboardFooter({
      evaluatedAt, commitSha: '0123456789abcdef0123456789abcdef01234567', githubUrlBase, dashboardRepository
    });
    document.body.append(footer);
    const link = footer.querySelector('.report-footer-version a');
    const status = footer.querySelector('.report-footer-app-update');
    expect(status?.textContent).toBe('');
    expect(status?.querySelector('svg')).toBeNull();

    dashboardAppUpdateDownloading.set(true);
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('Downloading app update');
    expect(status?.querySelector('.octicon-download')?.getAttribute('aria-hidden')).toBe('true');
    expect(status?.parentElement?.className).toBe('report-footer-version');
    expect(footer.querySelector('.report-footer-version a')).toBe(link);

    dashboardAppUpdateDownloading.set(false);
    expect(status?.textContent).toBe('');
    expect(status?.querySelector('svg')).toBeNull();
    expect(footer.querySelector('.report-footer-version a')).toBe(link);
  });

  it('renders an update already in progress and stops reacting after removal', async () => {
    dashboardAppUpdateDownloading.set(true);
    const footer = renderDashboardFooter({
      evaluatedAt, commitSha: '0123456789abcdef0123456789abcdef01234567', githubUrlBase, dashboardRepository
    });
    document.body.append(footer);
    const status = footer.querySelector('.report-footer-app-update');
    expect(status?.querySelector('.octicon-download')).not.toBeNull();
    await Promise.resolve();
    footer.remove();
    await Promise.resolve();

    dashboardAppUpdateDownloading.set(false);
    expect(status?.querySelector('.octicon-download')).not.toBeNull();
  });

  it('links a commit SHA to the configured repository on the configured GitHub server', () => {
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const footer = renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository });
    const version = footer.querySelector('.report-footer-version');
    const link = version?.querySelector('a');

    expect(version?.textContent).toBe('Dashboard 0123456');
    expect(version?.getAttribute('title')).toBe(commitSha);
    expect(link?.getAttribute('href')).toBe(`${githubUrlBase}/${dashboardRepository}/commit/${commitSha}`);
    expect(link?.getAttribute('aria-label')).toBe(`View commit ${commitSha} on GitHub`);
  });

  it('omits the version link when the SHA is unavailable or in development', () => {
    for (const commitSha of [undefined, 'development']) {
      const footer = renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository });
      expect(footer.querySelector('.report-footer-version')).toBeNull();
      expect(footer.querySelector('.report-footer-app-update')).toBeNull();
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
    expect(footer.querySelector('.report-footer-version')?.textContent).toBe('Dashboard 0123456');
    expect(footer.querySelector('.report-footer-version a')).toBeNull();
  });

  it('shows CAO and control-repository gh-aw versions beside the dashboard commit', () => {
    const footer = renderDashboardFooter({
      evaluatedAt, commitSha: '0123456789abcdef0123456789abcdef01234567',
      caoVersion: '1.2.3', ghAwVersion: 'v0.91.1', githubUrlBase, dashboardRepository
    });
    expect(footer.querySelector('.report-footer-versions')?.textContent).toBe('CAO 1.2.3gh-aw v0.91.1Dashboard 0123456');
  });

  it('shows available versions when the dashboard commit is unavailable', () => {
    const footer = renderDashboardFooter({
      evaluatedAt, caoVersion: '1.2.3', githubUrlBase, dashboardRepository
    });
    expect(footer.querySelector('.report-footer-cao-version')?.textContent).toBe('CAO 1.2.3');
    expect(footer.querySelector('.report-footer-gh-aw-version')).toBeNull();
    expect(footer.querySelector('.report-footer-version')).toBeNull();
  });
});
