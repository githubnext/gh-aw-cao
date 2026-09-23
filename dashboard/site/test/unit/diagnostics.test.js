// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFullDiagnostics } from '../../src/diagnostics.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('full dashboard diagnostics', () => {
  it('reports empty database and rendered UI consistency failures without throwing', async () => {
    document.body.innerHTML = `
      <main class="dashboard-root">
        <section data-page-id="events">
          <article data-view-id="event-inspection"></article>
        </section>
      </main>
    `;
    vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});

    const queryDatabase = vi.fn().mockResolvedValue({
      schemaVersion: 13,
      counts: {
        campaigns: 0,
        repositories: 0,
        workflows: 0,
        runs: 0,
        domains: 0,
        tools: 0,
        audits: 0,
        issues: 0
      },
      relationshipErrors: [],
      duplicateRecordIds: {
        campaigns: [],
        repositories: [],
        workflows: [],
        runs: [],
        domains: [],
        tools: [],
        audits: [],
        issues: []
      }
    });
    const report = await collectFullDiagnostics({ queryDatabase });

    expect(queryDatabase).toHaveBeenCalledOnce();
    expect(report.passed).toBe(false);
    expect(report.database.counts.campaigns).toBe(0);
    expect(report.database.counts.audits).toBe(0);
    expect(report.ui.activePageId).toBe('events');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'audits populated',
      passed: false
    }));
  });
});
