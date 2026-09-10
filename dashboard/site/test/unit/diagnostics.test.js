// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { collectFullDiagnostics } from '../../src/diagnostics.js';
import { deleteCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

afterEach(async () => {
  document.body.replaceChildren();
  await deleteCanonicalDatabase(indexedDB);
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

    const report = await collectFullDiagnostics({ indexedDB });

    expect(report.passed).toBe(false);
    expect(report.database.counts.events).toBe(0);
    expect(report.ui.activePageId).toBe('events');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'events populated',
      passed: false
    }));
  });
});
