import { afterEach, describe, expect, it } from 'vitest';
import contract from '../fixtures/overview-ingestion-status-contract.json' with { type: 'json' };
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import { dashboardDataStatus } from '../../src/dashboard-data-status.js';
import { renderDashboardCurrentStatus, renderDashboardIngestionStatus } from '../../src/components/refresh-error.js';
import { updateRateLimitNotification } from '../../src/rate-limit-notification.js';

const snapshot = { createdAt: '2026-09-28T12:00:00.000Z' };
let controller = new AbortController();

afterEach(() => {
  controller.abort();
  controller = new AbortController();
  dashboardDataStatus.set({ phase: 'unknown', snapshot: null });
  updateRateLimitNotification('/api/v1/query', 200);
  document.body.replaceChildren();
});

describe('Overview ingestion status', () => {
  it('leaves ingestion status to the top-right indicator without adding data queries', () => {
    const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'overview');
    const header = page.views.find((/** @type {{ id: string }} */ view) => view.id === contract.view);
    expect(header.element).toBe('factory-header');
    expect(header.config[contract.config] === true).toBe(contract.enabled);
    expect(header.data.sources).toEqual(['overview-header-presentation', 'overview-rhythm']);
  });

  for (const entry of contract.cases) {
    it(`shows ${entry.value} for the ${entry.phase} lifecycle state`, () => {
      dashboardDataStatus.set({
        phase: /** @type {ReturnType<typeof dashboardDataStatus.get>['phase']} */ (entry.phase),
        snapshot
      });
      const status = renderDashboardIngestionStatus(controller.signal);
      expect(status.getAttribute('role')).toBe('status');
      expect(status.getAttribute('aria-live')).toBe('polite');
      expect(status.querySelector('span')?.textContent).toBe('Data ingestion');
      expect(status.querySelector('strong')?.textContent).toBe(entry.value);
      expect(status.querySelector(`.octicon-${entry.icon}`)).not.toBeNull();
      expect(status.dataset.tone).toBe(entry.tone);
    });
  }

  it('updates the same owned indicator across success, failure, and retry, then stops on abort', () => {
    const status = renderDashboardIngestionStatus(controller.signal);
    document.body.append(status);
    expect(status.textContent).not.toContain('Current');
    dashboardDataStatus.set({ phase: 'ready', snapshot });
    expect(status.textContent).toContain('Current');
    expect(status.querySelector('p')?.textContent).toContain('current as of');
    dashboardDataStatus.set({ phase: 'stale', snapshot });
    expect(status.textContent).toContain('Refresh failed');
    expect(status.querySelector('p')?.textContent).toContain('last complete snapshot');
    expect(status.querySelector('.octicon-check-circle-fill')).toBeNull();
    dashboardDataStatus.set({ phase: 'cached', snapshot });
    expect(status.textContent).toContain('Refreshing');
    controller.abort();
    dashboardDataStatus.set({ phase: 'ready', snapshot });
    expect(status.querySelector('strong')?.textContent).toBe('Refreshing');
  });

  it('does not invent a timestamp or completed snapshot for a failed first import or hosted success', () => {
    dashboardDataStatus.set({ phase: 'stale', snapshot: null });
    const status = renderDashboardIngestionStatus(controller.signal);
    expect(status.textContent).toContain('A complete dashboard snapshot is not available yet.');
    expect(status.textContent).not.toContain('last complete snapshot');
    dashboardDataStatus.set({ phase: 'ready', snapshot: null });
    expect(status.textContent).toContain('Dashboard data loaded successfully.');
    expect(status.textContent).not.toContain('as of');
  });

  it('shares icons and rate-limit feedback with the top-right indicator and recovers reactively', () => {
    dashboardDataStatus.set({ phase: 'ready', snapshot });
    const status = renderDashboardIngestionStatus(controller.signal);
    const headerStatus = renderDashboardCurrentStatus(snapshot);
    document.body.append(status, headerStatus);
    expect(status.querySelector('.octicon-check-circle-fill')).not.toBeNull();
    expect(headerStatus.querySelector('.octicon-check-circle-fill')).not.toBeNull();
    updateRateLimitNotification('/api/v1/query', 429);
    expect(status.querySelector('strong')?.textContent).toBe('Rate limited');
    expect(status.querySelector('.octicon-alert')).not.toBeNull();
    expect(headerStatus.querySelector('.octicon-alert')).not.toBeNull();
    updateRateLimitNotification('/api/v1/query', 200);
    expect(status.querySelector('strong')?.textContent).toBe('Current');
  });
});
