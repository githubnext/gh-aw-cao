// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderDashboard, enableDashboardKeyboardNavigation, enableDashboardPageNavigation } from '../../src/presenter.js';
import { composeDashboardDocuments } from '../../../report/compose-dashboard-documents.mjs';
import { packageDashboardSources } from '../package-dashboard-documents.js';
import { applyDashboardQueries } from '../workflow-inventory-query.js';
import { setAutomaticDashboardDataUpdatesEnabled } from '../../src/dashboard-data-updates.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const builtInDashboardDocument = JSON.parse(
  readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')
);
const packageDashboardDocuments = packageDashboardSources.map((source) => JSON.parse(source));
const authoritativeDashboardDocument = composeDashboardDocuments(
  builtInDashboardDocument,
  packageDashboardDocuments
);

/** @param {HTMLElement} rendered @param {string} pageId */
async function activatePage(rendered, pageId) {
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector(`[data-nav-page-id="${pageId}"]`));
  expect(link).not.toBeNull();
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector(`[data-page-id="${pageId}"]`)?.hasAttribute('data-page-pending')).toBe(false);
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  return rendered.querySelector(`[data-page-id="${pageId}"]`);
}

describe('dashboard DOM provenance', () => {
  it('maps every rendered element and dynamic descendant to its owning JSON view when ?debug=1 is set', async () => {
    window.history.pushState(null, '', '?debug=1');
    try {
      const rendered = renderDashboard({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'provenance-dashboard',
            title: 'Provenance dashboard',
            pages: [{
              id: 'trace',
              kind: 'custom',
              title: 'Trace',
              views: [
                {
                  id: 'summary',
                  title: 'Summary',
                  mark: 'element',
                  element: 'summary-grid',
                  data: { source: 'summary' }
                },
                {
                  id: 'total',
                  title: 'Total',
                  mark: 'metric',
                  data: { source: 'summary' },
                  encoding: { value: { field: 'value', aggregate: 'sum' } }
                }
              ],
              sections: [{
                id: 'main',
                title: 'Main',
                layout: 'full',
                views: ['summary', 'total']
              }]
            }]
          }
        },
        sources: {
          summary: {
            source: 'summary',
            rows: [{ label: 'Runs', value: 2 }],
            metadata: {
              'source-id': 'summary-fixture',
              'source-kind': 'fixture',
              'as-of': '2026-09-07T18:00:00Z',
              'retrieved-at': '2026-09-07T18:01:00Z',
              completeness: 'complete',
              freshness: 'fresh',
              availability: 'available'
            }
          }
        }
      });

      const page = rendered.querySelector('[data-page-id="trace"]');
      const section = page?.querySelector('[data-section-id="main"]');
      const summary = page?.querySelector('[data-view-id="summary"]');
      const metric = page?.querySelector('[data-view-id="total"]');
      await vi.waitFor(() => {
        expect(rendered.getAttribute('data-json-path')).toBe('$.dashboard');
      });
      expect(rendered.querySelector('[data-nav-page-id="trace"]')?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0]');
      expect(page?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0]');
      expect(section?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].sections[0]');
      expect(summary?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
      expect(summary?.querySelector('dt')?.getAttribute('data-js-view')).toBe('summary-grid');
      expect(metric?.querySelector('.metric-value')?.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[1]');
      await vi.waitFor(() => {
        expect([...rendered.querySelectorAll('*')].every((element) => element.hasAttribute('data-json-path'))).toBe(true);
      });

      const dynamicChild = rendered.ownerDocument.createElement('span');
      summary?.append(dynamicChild);
      await vi.waitFor(() => {
        expect(dynamicChild.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
        expect(dynamicChild.getAttribute('data-js-view')).toBe('summary-grid');
      });

      const replacementSection = rendered.ownerDocument.createElement('section');
      replacementSection.setAttribute('data-section-id', 'main');
      const replacementView = rendered.ownerDocument.createElement('article');
      replacementView.className = 'custom-view';
      replacementView.setAttribute('data-view-id', 'summary');
      replacementView.append(rendered.ownerDocument.createElement('dt'));
      replacementSection.append(replacementView);
      page?.replaceChildren(replacementSection);
      await vi.waitFor(() => {
        expect(replacementSection.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].sections[0]');
        expect(replacementView.getAttribute('data-json-path')).toBe('$.dashboard.pages[0].views[0]');
        expect(replacementView.querySelector('dt')?.getAttribute('data-js-view')).toBe('summary-grid');
      });
    } finally {
      window.history.pushState(null, '', '/');
    }
  });

  it('surfaces a dom-provenance-error data attribute when the debug-only loader fails', async () => {
    vi.resetModules();
    vi.doMock('../../src/dom-provenance.js', () => {
      return {
        enableDashboardDomProvenance: () => {
          throw new Error('provenance module failed to load');
        },
        annotatePageDom: () => {
          throw new Error('provenance module failed to load');
        }
      };
    });
    const { renderDashboard: renderDashboardWithFailingProvenance } = await import('../../src/presenter.js');
    window.history.pushState(null, '', '?debug=1');
    try {
      const rendered = renderDashboardWithFailingProvenance({
        document: {
          languageVersion: '0.1.0',
          dashboard: {
            id: 'provenance-error-dashboard',
            title: 'Provenance error dashboard',
            pages: [{
              id: 'trace',
              kind: 'custom',
              title: 'Trace',
              views: [],
              sections: []
            }]
          }
        },
        sources: {}
      });

      await vi.waitFor(() => {
        expect(rendered.dataset.domProvenanceError).toContain('provenance module failed to load');
      });
    } finally {
      window.history.pushState(null, '', '/');
      vi.doUnmock('../../src/dom-provenance.js');
      vi.resetModules();
    }
  });

  it('does not annotate the dashboard when ?debug=1 is absent', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'no-provenance-dashboard',
          title: 'No provenance dashboard',
          pages: [{
            id: 'trace',
            kind: 'custom',
            title: 'Trace',
            views: [],
            sections: []
          }]
        }
      },
      sources: {}
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
    expect(rendered.hasAttribute('data-json-path')).toBe(false);
  });

  it('shows the loading skeleton instead of unavailable source errors during an empty initial load', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'initial-load-dashboard',
          title: 'Initial Load',
          pages: [{
            id: 'repositories',
            kind: 'custom',
            title: 'Repositories',
            views: [{
              id: 'repository-activity',
              title: 'Repository Activity',
              mark: 'table',
              data: { source: 'repository-activity' }
            }],
            sections: [{
              id: 'main',
              title: 'Main',
              layout: 'full',
              views: ['repository-activity']
            }]
          }]
        }
      },
      sources: {},
      loading: true
    });

    const page = rendered.querySelector('[data-page-id="repositories"]');
    expect(page?.getAttribute('aria-busy')).toBe('true');
    expect(page?.querySelector('.dashboard-view-skeleton')).not.toBeNull();
    expect(page?.textContent).toContain('Loading view');
    expect(page?.textContent).not.toContain('This view cannot be shown because its data source is unavailable.');
    expect(page?.textContent).not.toContain('Affected source: repository-activity');
  });
});

describe('presenter built-in and custom pages', () => {
  it('renders aggregated firewall domains in a full-view lazy table', async () => {
    const metadata = /** @type {const} */ ({
      'source-id': 'firewall-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-05T11:00:00Z',
      'retrieved-at': '2026-09-05T11:05:00Z',
      completeness: 'partial',
      freshness: 'fresh',
      availability: 'available'
    });
    const rows = [
      { domain: 'api.github.com', run: 4, accepted: 12, blocked: 1 },
      { domain: 'new.example', run: 2, accepted: 3, blocked: 0 },
      { domain: 'blocked.example', run: 1, accepted: 0, blocked: 7 },
      { domain: 'changed.example', run: 2, accepted: 1, blocked: 2 }
    ];
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'firewall-domain-totals': { source: 'firewall-domain-totals', rows, metadata },
        'firewall-policy-rules': { source: 'firewall-policy-rules', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'firewall');
    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    const text = page?.textContent ?? '';
    expect(text).toContain('api.github.com');
    expect(text).toContain('new.example');
    expect(text).toContain('blocked.example');
    expect(text).toContain('changed.example');
    expect(text).toContain('Accepted');
    expect(text).toContain('Blocked');
    expect(text).not.toContain('firewall failure');
    rendered.remove();
  });

  it('renders the configured empty state when the firewall data binding is empty', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'firewall-domain-totals': {
          source: 'firewall-domain-totals',
          rows: [],
          metadata: {
            'source-id': 'firewall-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-05T11:00:00Z',
            'retrieved-at': '2026-09-05T11:05:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'empty'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'firewall');
    const view = page?.querySelector('[data-view-id="security-firewall-domains"]');
    expect(view?.getAttribute('data-view-layout')).toBe('full-view');
    expect(view?.querySelector('.table-region')?.textContent).toContain(
      'No observed firewall domains are available for this selection.'
    );
    rendered.remove();
  });

  it('binds deployed workflow versions, update state, and source paths in Updates', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'acme',
            repository: 'service',
            workflow: '.github/workflows/remote-agent.md',
            'workflow-name': 'Remote agent',
            'gh-aw-version': 'v0.88.7',
            'gh-aw-current-version': 'v0.89.0',
            'gh-aw-version-label': 'v0.88.7',
            'gh-aw-update-state': 'update-available'
          }],
          metadata: {
            'source-id': 'deployed-workflows-fixture',
            'source-kind': 'github',
            'as-of': '2026-09-08T17:24:49.713Z',
            'retrieved-at': '2026-09-08T17:24:49.713Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'updates');
    const inventory = page?.querySelector('[data-view-id="workflow-updates"]');
    expect(page?.querySelector('[data-chart-widget]')).toBeNull();
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(inventory?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(inventory?.textContent).toContain('v0.88.7');
    expect(inventory?.textContent).toContain('v0.89.0');
    expect(inventory?.textContent).toContain('update-available');
    expect(inventory?.querySelector('tbody a')?.getAttribute('href')).toBe(
      '#page-workflow-runtime?workflow=acme%2Fservice%3A.github%2Fworkflows%2Fremote-agent.md'
    );
    rendered.remove();
  });

  it('renders engine and model usage as one full-view lazy table', async () => {
    const metadata = {
      'source-id': 'usage-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', 'run-conclusion': 'success', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1001', label: 'View run 1001' } },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1002', 'run-conclusion': 'failure', engine: 'copilot', 'engine-version': '0.87.9', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1002', label: 'View run 1002' } },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.yml', run: '1003', 'run-conclusion': 'success', engine: 'pi', 'engine-version': '1.2.0', 'requested-model': 'claude-sonnet-5', 'resolved-model': 'claude-sonnet-5', 'run-link': { relation: 'run', href: 'https://github.com/github/gh-aw-cao/actions/runs/1003', label: 'View run 1003' } }
          ],
          metadata
        },
        'engines-models-usage': {
          source: 'engines-models-usage',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'event-type': 'agent_turn', 'event-summary': 'Daily agent turn' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', engine: 'copilot', 'engine-version': '0.87.9', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', 'event-type': 'assistant_message', 'event-summary': 'Review response' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.yml', engine: 'copilot', 'engine-version': '1.2.0', 'requested-model': 'claude-sonnet-5', 'resolved-model': 'claude-sonnet-5', 'event-type': 'agent_turn', 'event-summary': 'Audit agent turn' }
          ],
          metadata
        },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'engines-models');
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('[data-chart-widget]')).toBeNull();
    expect(page?.textContent).toContain('Review response');
    expect(page?.textContent).toContain('copilot');
    expect(page?.textContent).toContain('0.87.6');
    expect(page?.textContent).toContain('0.87.9');
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('renders event inspection as one full-view lazy table', async () => {
    const metadata = {
      'source-id': 'event-inspection-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'event-inspection': {
          source: 'event-inspection',
          rows: [
            {
              'observed-at': '2026-09-02T12:00:00Z', 'event-source': 'agent', 'event-type': 'assistant_message',
              'event-status': 'completed', 'event-summary': 'Produced a review', repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.yml', run: '1002', 'run-attempt': 1, session: 'session-1',
              event: 'event-1', 'correlation-id': 'correlation-1', 'source-sequence': 3,
              'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/1002', label: 'View run 1002' }
            }
          ],
          metadata
        }
      }
    });

    const page = await activatePage(rendered, 'events');
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.textContent).toContain('Produced a review');
    expect(page?.textContent).toContain('assistant_message');
    expect(page?.querySelector('thead')?.textContent).toContain('Correlation');
    expect(page?.querySelector('tbody')?.textContent).toContain('correlation-1');
    expect(page?.querySelector('tbody tr td:first-child a')?.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/1002');
  });

  it('renders transaction entries as one full-view interactive lazy table', async () => {
    const metadata = {
      'source-id': 'transactions-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        transactions: {
          source: 'transactions',
          rows: [{
            transaction: 'ingest-jsonl:current:test',
            kind: 'ingest-jsonl',
            'created-at': '2026-09-02T12:00:00Z',
            'payload-scope': 'gh-aw-jsonl',
            records: 12,
            'committed-records': 10
          }],
          metadata
        }
      }
    });

    const page = await activatePage(rendered, 'transactions');
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('input[type="search"]')).not.toBeNull();
    expect(page?.textContent).toContain('ingest-jsonl');
    expect(page?.textContent).toContain('gh-aw-jsonl');
    expect(page?.querySelector('thead')?.textContent).toContain('Committed records');
  });

  it('explains when engine and model usage data is missing', async () => {
    const metadata = {
      'source-id': 'usage-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-02T12:00:00Z',
      'retrieved-at': '2026-09-02T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'empty'} */ ('empty')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: { source: 'runs', rows: [], metadata },
        'engines-models-usage': { source: 'engines-models-usage', rows: [], metadata },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'engines-models');
    expect(page?.textContent).toContain('No engine or model usage metadata is available.');
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    rendered.remove();
  });

  it('renders a JSON-declared full-view workflow inventory', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'workflow-topology-dashboard',
        title: 'Workflow Topology',
        pages: [{
          id: 'workflows',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'workflows',
          title: 'Workflows',
          icon: 'rocket'
        }]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', run: '1', 'aic-total': 12 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', run: '2', 'aic-total': 18 },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', run: '3', 'aic-total': 5 }
          ],
          metadata: {
            'source-id': 'workflow-runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'dependabot', 'package-name': 'Dependabot', workflow: '.github/workflows/dependabot.yml', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'dependabot', 'package-name': 'Dependabot', workflow: '.github/workflows/dependabot-release-train-updater.yml', 'workflow-name': 'Release Train Updater', 'workflow-role': 'worker', 'workflow-active': 'true', 'rollout-mode': 'review' },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', 'workflow-name': 'CI', 'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'live' }
          ],
          metadata: {
            'source-id': 'workflow-topology-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', aic: 12 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dependabot.yml', aic: 18 },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', aic: 5 }
          ],
          metadata: {
            'source-id': 'workflow-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        historical: {
          source: 'historical',
          rows: [{ record: 'older-window' }],
          metadata: {
            'source-id': 'historical-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-01T12:00:00Z',
            'retrieved-at': '2026-09-01T12:00:00Z',
            'coverage-start': '2026-01-01T00:00:00Z',
            'coverage-end': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      })
    });

    const page = rendered.querySelector('[data-page-name="workflows"]');
    expect(globalThis.document.title).toBe('Workflows · Workflow Topology');
    expect(page?.getAttribute('data-page-description')).toContain('does not assert that a dispatch occurred');
    expect(page?.querySelector('.view-metadata-summary')).toBeNull();
    expect(rendered.querySelector('.horizon-summary [aria-label="Data status"]')).toBeNull();
    expect(rendered.querySelector('.filter-tuning-controls .horizon-details [aria-label="Data status"]')).toBeNull();
    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('[data-table-filter]')).not.toBeNull();
    const rows = [...(page?.querySelectorAll('tbody tr') ?? [])];
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.textContent?.includes('dependabot.yml'))?.textContent).toContain('30');
    expect(rows.find((row) => row.textContent?.includes('ci.yml'))?.textContent).toContain('5');
    expect(page?.querySelector('.mode-review')).not.toBeNull();
    expect(page?.querySelector('.mode-live')).not.toBeNull();
    expect(page?.querySelector('.status-success')).not.toBeNull();
    const rocket = rendered.querySelector('[data-nav-page-id="workflows"] .octicon-rocket');
    expect(rocket?.querySelector('use')?.getAttribute('href')).toMatch(/\/src\/octicons\.svg#octicon-rocket$/);
  });

  it('DLS-LINK-006 DLS-LINK-007 derives organization, repository, and workflow links from raw identity fields in the topology view', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'workflow-topology-links-dashboard',
        title: 'Workflow Topology Links',
        pages: [
          {
            id: 'workflows',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'workflows',
            title: 'Workflows'
          },
          {
            id: 'repository-detail',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Repository',
            route: { 'hash-query-parameter': 'repository' },
            views: []
          },
          {
            id: 'workflow-runtime',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Workflow runtime',
            route: { 'hash-query-parameter': 'workflow' },
            views: []
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [],
          metadata: {
            'source-id': 'workflow-runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [],
          metadata: {
            'source-id': 'workflow-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'dependabot', 'package-name': 'Dependabot', workflow: '.github/workflows/dependabot.yml', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'live' },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', 'workflow-name': 'CI', 'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'unknown' }
          ],
          metadata: {
            'source-id': 'workflow-topology-links-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      })
    });

    const links = [...rendered.querySelectorAll('[data-page-name="workflows"] table a')]
      .map((link) => link.getAttribute('href'));
    expect(links).toContain('#page-package-insights?package=dependabot');
    expect(links).toContain('#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdependabot.yml');
    expect(links).toContain('#page-workflow-runtime?workflow=github%2Ftarget-service%3A.github%2Fworkflows%2Fci.yml');
    expect(links).toContain('#page-repository-detail?repository=github%2Ftarget-service');
  });

  it('DLS-LINK-006 DLS-LINK-007 renders derived entity links in table columns and honours a custom github-url-base plus explicit link overrides', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'entity-link-table-dashboard',
        title: 'Entity Link Table',
        'github-url-base': 'https://github.example.com',
        pages: [
          {
            id: 'repositories',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Repositories',
            views: [
              {
                id: 'repositories-table',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'organization' },
                    { field: 'repository' }
                  ]
                }
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        repositories: {
          source: 'repositories',
          rows: [
            { organization: 'octo-org', repository: 'platform' },
            {
              organization: 'octo-org',
              repository: 'overridden',
              'repository-link': { relation: 'repository', href: 'https://example.com/custom', label: 'Custom link' }
            }
          ],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const table = rendered.querySelector('table');
    const links = [...(table?.querySelectorAll('tbody a') ?? [])];
    const derivedOrganizationLink = links.find((link) => link.getAttribute('href') === 'https://github.example.com/octo-org');
    expect(derivedOrganizationLink).toBeDefined();
    const derivedRepositoryLink = links.find((link) => link.getAttribute('href') === 'https://github.example.com/octo-org/platform');
    expect(derivedRepositoryLink).toBeDefined();
    const overriddenRepositoryLink = links.find((link) => link.getAttribute('href') === 'https://example.com/custom');
    expect(overriddenRepositoryLink).toBeDefined();
    expect(links.some((link) => link.getAttribute('href') === 'https://github.example.com/octo-org/overridden')).toBe(false);
  });

  it('DLS-SAFE-011 renders a descriptive refresh control and omits the GitHub repository link when repository is absent', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'no-repository-dashboard',
        title: 'No Repository',
        pages: [{ id: 'usage', kind: /** @type {'built-in'} */ ('built-in'), page: 'usage', title: 'Usage' }]
      }
    };

    const rendered = renderDashboard({ document, sources: {} });

    const refreshButton = rendered.querySelector('.refresh-button');
    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.tagName).toBe('BUTTON');
    expect(refreshButton?.getAttribute('title')).toBeTruthy();
    expect(refreshButton?.getAttribute('aria-label')).toBeTruthy();
    expect(refreshButton?.closest('.account-menu')).not.toBeNull();
    expect(rendered.querySelector('.report-footer .refresh-button')).toBeNull();
    expect(rendered.querySelector('.report-footer-status time')?.getAttribute('datetime')).toBeTruthy();
    expect(rendered.querySelector('.repository-link')).toBeNull();
    expect(rendered.querySelector('.account-menu-avatar .octicon-kebab-horizontal')).not.toBeNull();
    expect(rendered.querySelector('.account-menu-avatar')?.classList.contains('account-menu-icon')).toBe(true);
    expect(rendered.querySelector('.account-menu-avatar-image')).toBeNull();
  });

  it('DLS-DOC-012 DLS-SAFE-011 renders a labeled GitHub repository link resolved against a custom github-url-base', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'repository-dashboard',
        title: 'Repository Dashboard',
        'github-url-base': 'https://github.example.com',
        repository: 'octo-org/agentic-operations',
        pages: [{ id: 'usage', kind: /** @type {'built-in'} */ ('built-in'), page: 'usage', title: 'Usage' }]
      }
    };

    const rendered = renderDashboard({ document, sources: {} });

    const refreshLink = rendered.querySelector('.refresh-button');
    expect(refreshLink?.tagName).toBe('A');
    expect(refreshLink?.getAttribute('href')).toBe('https://github.example.com/octo-org/agentic-operations/actions/workflows/dashboard.yml');
    expect(refreshLink?.getAttribute('aria-label')).toBe('Open the dashboard workflow on GitHub Actions');
    expect(refreshLink?.getAttribute('title')).toBe('Open the dashboard workflow on GitHub Actions');
    expect(refreshLink?.closest('.account-menu')).not.toBeNull();
    const repositoryLink = rendered.querySelector('.repository-link');
    expect(repositoryLink).not.toBeNull();
    expect(repositoryLink?.getAttribute('href')).toBe('https://github.example.com/octo-org/agentic-operations');
    expect(repositoryLink?.getAttribute('aria-label')).toBe('View octo-org/agentic-operations on GitHub');
    expect(repositoryLink?.getAttribute('title')).toBe('View octo-org/agentic-operations on GitHub');
    expect(rendered.querySelector('.sidebar-brand > span')?.textContent).toBe('agentic-operations');
    expect(rendered.querySelector('.mobile-page-header .mobile-brand-name')?.textContent).toBe('agentic-operations');
  });

  it('routes repository entity links to the repository detail view while retaining GitHub Actions links', async () => {
    window.history.replaceState(null, '', '/#page-repositories');
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repository-routing-dashboard',
          title: 'Repository routing',
          pages: [
            {
              id: 'repositories',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repositories',
              views: [{
                id: 'repository-list',
                title: 'Repositories',
                data: { source: 'repositories' },
                mark: 'table',
                encoding: { columns: [{ field: 'repository' }] }
              }]
            },
            {
              id: 'repository-detail',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository', 'navigation-page': 'repositories' },
              views: [{
                id: 'repository-workflow-count',
                title: 'Authored workflows',
                data: { source: 'repository-detail-summary', 'route-field': 'repository' },
                mark: 'metric',
                encoding: {
                  value: { field: 'workflows', type: 'quantitative' },
                  href: { field: 'external-link', type: 'nominal' }
                }
              }]
            }
          ]
        }
      },
      sources: {
        repositories: {
          source: 'repositories',
          rows: [{ organization: 'octo-org', repository: 'platform' }],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'octo-org',
            repository: 'platform',
            workflow: '.github/workflows/review.md',
            'workflow-name': 'Review',
            'workflow-active': 'true'
          }],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    document.body.append(rendered);

    const repositoryLink = rendered.querySelector('[data-page-id="repositories"] tbody a');
    expect(repositoryLink?.getAttribute('href')).toBe('#page-repository-detail?repository=octo-org%2Fplatform');
    expect(repositoryLink?.getAttribute('target')).toBeNull();

    window.history.replaceState(null, '', `/${repositoryLink?.getAttribute('href')}`);
    window.dispatchEvent(new Event('hashchange'));

    expect(rendered.querySelector('[data-page-id="repository-detail"]')?.hasAttribute('hidden')).toBe(false);
    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="repository-detail"]')?.hasAttribute('data-page-pending')).toBe(false);
    });
    expect(rendered.querySelector('[data-page-id="repository-detail"] [data-route-view] .metric-value')?.textContent).toBe('1');
    expect(rendered.querySelector('[data-page-id="repository-detail"] [data-route-view] .metric-link a')?.getAttribute('href')).toBe('https://github.com/octo-org/platform/actions');
    expect(rendered.querySelector('[data-nav-page-id="repositories"]')?.getAttribute('aria-current')).toBe('page');
    rendered.remove();
    window.history.replaceState(null, '', '/');
  });

  it('groups all experimental views in one section collapsed by default', () => {
    window.history.replaceState(null, '', '/');
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {},
      viewer: {
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4'
      }
    });
    document.body.append(rendered);

    const labels = [...rendered.querySelectorAll('.nav-section-label')].map((node) => node.textContent?.trim());
    const sections = [...rendered.querySelectorAll('.nav-section')];
    expect(labels).toEqual(['Data', 'Experimental']);
    expect([...rendered.querySelectorAll('.mobile-nav-section-label')].map((node) => node.textContent?.trim())).toEqual(['Data', 'Experimental']);
    expect([...rendered.querySelectorAll('.primary-nav > [data-nav-page-id] .nav-label')].map((node) => node.textContent)).toEqual([
      'Overview',
      'Repositories',
      'Packages'
    ]);
    expect(rendered.querySelector('[data-nav-page-id="workflows"] .octicon-workflow')).not.toBeNull();
    expect(rendered.querySelector('[data-nav-page-id="agents"] .octicon-sparkles-fill')).not.toBeNull();
    expect(rendered.querySelector('[data-mobile-nav-page-id="agents"] .octicon-sparkles-fill')).not.toBeNull();
    expect(rendered.querySelector('[data-nav-page-id="configuration"]')).toBeNull();
    expect(rendered.querySelector('.account-menu-settings')?.getAttribute('href')).toBe('#page-configuration');
    expect(rendered.querySelector('.account-menu-avatar')?.getAttribute('aria-label')).toBe('Open dashboard menu');
    expect(rendered.querySelector('.account-menu-avatar')?.classList.contains('account-menu-icon')).toBe(true);
    expect(rendered.querySelector('.account-menu-avatar .octicon-kebab-horizontal')).not.toBeNull();
    expect(rendered.querySelector('.account-menu-avatar-image')).toBeNull();
    const backgroundSync = /** @type {HTMLInputElement | null} */ (
      rendered.querySelector('.database-counts .background-sync-setting input')
    );
    expect(backgroundSync?.getAttribute('aria-label')).toBe('Background sync');
    expect(backgroundSync?.checked).toBe(false);
    expect(backgroundSync?.disabled).toBe(true);
    expect(backgroundSync?.closest('label')?.getAttribute('title')).toBe('Periodic Background Sync is not supported by this browser.');
    backgroundSync?.click();
    expect(window.localStorage.getItem('central-agentic-ops.dashboard.automatic-data-updates')).toBeNull();
    setAutomaticDashboardDataUpdatesEnabled(false);
    expect(backgroundSync?.checked).toBe(false);
    expect(rendered.querySelector('.appearance-settings legend')?.textContent).toBe('Appearance');
    expect([...rendered.querySelectorAll('[data-theme-value]')].map((node) => node.textContent)).toEqual(['System', 'Light', 'Dark']);
    const systemTheme = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('[data-theme-value="system"]'));
    const darkTheme = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('[data-theme-value="dark"]'));
    const lightTheme = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('[data-theme-value="light"]'));
    expect(rendered.hasAttribute('data-theme')).toBe(false);
    expect(systemTheme?.getAttribute('aria-pressed')).toBe('true');
    darkTheme?.click();
    expect(rendered.dataset.theme).toBe('dark');
    expect(darkTheme?.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('dark');
    lightTheme?.click();
    expect(rendered.dataset.theme).toBe('light');
    expect(lightTheme?.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('light');
    systemTheme?.click();
    expect(rendered.hasAttribute('data-theme')).toBe(false);
    expect(systemTheme?.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('central-agentic-ops.dashboard.theme')).toBe('system');
    expect(sections.map((section) => /** @type {HTMLDetailsElement} */ (section).open)).toEqual([false, false]);
    expect(rendered.querySelector('[data-experimental-toggle]')).toBeNull();
    expect(rendered.querySelector('[data-nav-page-id="workflows"]')?.closest('.nav-section')).toBe(sections[0]);
    expect(rendered.querySelector('[data-nav-page-id="runs"]')?.closest('.nav-section')).toBe(sections[0]);
    expect(rendered.querySelector('[data-nav-page-id="events"]')?.closest('.nav-section')).toBe(sections[0]);
    expect(rendered.querySelector('[data-nav-page-id="operations"]')?.closest('.nav-section')?.textContent).toContain('Experimental');
    expect(rendered.querySelector('[data-nav-page-id="runtime"]')?.closest('.nav-section')).toBe(sections[1]);
    expect(rendered.querySelector('[data-nav-page-id="preview"]')?.closest('.nav-section')).toBe(sections[1]);
    expect(rendered.querySelector('[data-nav-page-id="uk-ai-advisory-dashboard"]')?.closest('.nav-section')).toBe(sections[1]);
    expect([...rendered.querySelectorAll('.nav-label')].map((node) => node.textContent)).toEqual([
      'Overview',
      'Repositories',
      'Packages',
      'Workflows',
      'Runs',
      'Events',
      'Transactions',
      'Firewall',
      'Work',
      'Operations',
      'Insights',
      'Operational health',
      'Runtime',
      'Performance',
      'Security',
      'Experiments',
      'Value',
      'Cost',
      'Admission',
      'Preview',
      'Readiness',
      'GitHub API',
      'Updates',
      'Safe Outputs',
      'Detection',
      'Dispatches',
      'MCPs',
      'Models & agents',
      'UK AI advisory',
      'AW Doctor',
      'Dependabot',
      'EU CRA',
      'AW Optimization'
    ]);
    expect(rendered.querySelector('[data-nav-page-id="runs"] .octicon-play')).not.toBeNull();
    expect(rendered.querySelector('[data-nav-page-id="findings"]')).toBeNull();
    expect(rendered.querySelector('[data-page-id="overview"]')?.classList.contains('dashboard-overview-page')).toBe(true);
    expect(rendered.querySelector('[data-page-id="organizations"]')?.classList.contains('organizations-page')).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Overview');

    /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="cost"]'))?.click();

    expect(window.location.hash).toBe('#page-cost');
    expect(/** @type {HTMLDetailsElement} */ (sections[1]).open).toBe(true);
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Cost & efficiency');
    rendered.remove();
    window.history.replaceState(null, '', '/');
  });

  it('does not turn agent smells into Home notifications', async () => {
    window.history.replaceState(null, '', '/#page-agents');
    const metadata = /** @type {const} */ ({
      'source-id': 'notification-agent-smell-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-07T09:00:00Z',
      'retrieved-at': '2026-09-07T09:01:00Z',
      completeness: 'complete',
      freshness: 'fresh',
      availability: 'available'
    });
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'attention-signals': { source: 'attention-signals', rows: [], metadata },
        'overview-failed-run-count': { source: 'overview-failed-run-count', rows: [{ count: 0 }], metadata },
        'overview-blocked-work-count': { source: 'overview-blocked-work-count', rows: [{ count: 0 }], metadata },
        'overview-awaiting-review-count': { source: 'overview-awaiting-review-count', rows: [{ count: 0 }], metadata },
        'overview-security-finding-count': {
          source: 'overview-security-finding-count',
          rows: [],
          metadata: { ...metadata, availability: 'unavailable' }
        },
        outcomes: { source: 'outcomes', rows: [], metadata },
        'safe-output-performance': { source: 'safe-output-performance', rows: [], metadata },
        'operational-values': { source: 'operational-values', rows: [], metadata },
        usage: { source: 'usage', rows: [], metadata },
        runs: { source: 'runs', rows: [], metadata },
        repositories: { source: 'repositories', rows: [], metadata },
        'work-items': { source: 'work-items', rows: [], metadata },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'githubnext', repository: 'gh-aw', 'workflow-role': 'standalone',
            workflow: '.github/workflows/review.md', 'workflow-name': 'Review agent',
            'workflow-active': 'false', 'observed-at': '2020-01-01T00:00:00Z'
          }],
          metadata
        },
        'agent-assignments': { source: 'agent-assignments', rows: [], metadata },
        'security-observations': {
          source: 'security-observations',
          rows: [{
            organization: 'githubnext', repository: 'gh-aw', workflow: '.github/workflows/review.lock.yml',
            'security-feature': 'threat-detection', 'security-analysis': 'summary',
            'security-signal': 'Malicious patch', 'security-status': 'detected',
            'observed-at': '2020-01-01T00:00:00Z'
          }],
          metadata
        }
      }
    });
    document.body.append(rendered);

    const page = await activatePage(rendered, 'overview');
    expect(page?.querySelector('.agent-factory')).not.toBeNull();
    expect(page?.querySelectorAll('.factory-station')).toHaveLength(4);
    expect(page?.querySelector('.factory-intro h2')?.textContent).toBe('Your factory is idle.');
    expect(page?.querySelector('.notifications-inbox')).toBeNull();
    expect(page?.querySelector('.factory-status')).toBeNull();
    expect(page?.querySelector('.factory-all-clear')).toBeNull();
    expect(page?.querySelector('.home-attention-detail')).toBeNull();
    expect(page?.textContent).not.toContain('Malicious patch detected');
    rendered.remove();
  });

  it('expands experimental navigation for a directly linked experimental page', () => {
    window.history.replaceState(null, '', '/#page-cost');
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });

    const experimentalSection = [...rendered.querySelectorAll('.nav-section')]
      .find((section) => section.querySelector('summary')?.textContent?.trim() === 'Experimental');
    expect(/** @type {HTMLDetailsElement | undefined} */ (experimentalSection)?.open).toBe(true);
    expect(rendered.querySelector('[data-nav-page-id="cost"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered.querySelector('[data-mobile-nav-page-id="overview"]')?.getAttribute('href')).toBe('#page-overview');

    rendered.remove();
    window.history.replaceState(null, '', '/');
  });

  it('expands the menu section containing the current view', () => {
    window.history.replaceState(null, '', '/#page-security');
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    document.body.append(rendered);

    const sections = [...rendered.querySelectorAll('.nav-section')];
    const experimentalSection = sections.find((section) => section.querySelector('summary')?.textContent?.trim() === 'Experimental');
    expect(/** @type {HTMLDetailsElement | undefined} */ (experimentalSection)?.open).toBe(true);
    expect(rendered.querySelector('[data-nav-page-id="security"]')?.getAttribute('aria-current')).toBe('page');

    rendered.remove();
    window.history.replaceState(null, '', '/');
  });

  it('shows only known-worker issues in Preview and filters them by open or closed state', async () => {
    const metadata = {
      'source-id': 'outcomes-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-03T12:00:00Z',
      'retrieved-at': '2026-09-03T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [
            { package: 'daily', 'workflow-name': 'Open worker', 'workflow-role': 'worker', 'outcome-category': 'issue', 'outcome-title': 'Open issue', 'outcome-status': 'open', repository: 'control', 'observed-at': '2026-09-03T10:00:00Z' },
            { package: 'daily', 'workflow-name': 'Closed worker', 'workflow-role': 'worker', 'outcome-category': 'issue', 'outcome-title': 'Closed issue', 'outcome-status': 'closed', repository: 'control', 'observed-at': '2026-09-03T09:00:00Z' },
            { package: 'unknown', 'workflow-name': 'Unknown workflow', 'workflow-role': 'unknown', 'outcome-category': 'issue', 'outcome-title': 'Unattributed issue', 'outcome-status': 'open', repository: 'control', 'observed-at': '2026-09-03T08:00:00Z' }
          ]
        }
      }
    });

    const page = await activatePage(rendered, 'preview');
    const rows = [...(page?.querySelectorAll('.custom-table tbody tr') ?? [])];
    const status = /** @type {HTMLSelectElement | null} */ (
      page?.querySelector('[data-table-facet="outcome-status"]') ?? null
    );
    expect(rows).toHaveLength(2);
    expect(page?.textContent).not.toContain('Unattributed issue');
    expect([...status?.options ?? []].map((option) => option.value)).toEqual(['', 'closed', 'open']);

    if (status) {
      status.value = 'closed';
      status.dispatchEvent(new Event('input'));
    }
    expect(rows.map((row) => row.hasAttribute('hidden'))).toEqual([true, false]);
    rendered.remove();
    window.history.replaceState(null, '', '/');
  });

  it('renders conditional site-wide callouts and remembers dismissal only in memory', () => {
    window.localStorage.clear();
    sessionStorage.clear();
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'callout-dashboard',
        title: 'Callout Dashboard',
        callouts: [
          {
            id: 'operator-message',
            title: 'Operator message',
            description: 'A message for every dashboard user.',
            icon: 'megaphone',
            'navigation-page': 'usage'
          },
          {
            id: 'rate-limit-message',
            title: 'Dashboard data is partial',
            description: 'Some data could not be downloaded.',
            icon: 'alert',
            'navigation-page': 'coverage',
            'visible-when': {
              source: 'coverage-diagnostics',
              field: 'kind',
              equals: 'github-api-rate-limit-403'
            }
          }
        ],
        pages: [{
          id: 'usage',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'usage',
          title: 'Usage'
        }]
      }
    };
    const sources = {
      'coverage-diagnostics': {
        source: 'coverage-diagnostics',
        rows: [{ kind: 'github-api-rate-limit-403' }],
        metadata: {
          'source-id': 'coverage-diagnostics-fixture',
          'source-kind': 'fixture',
          'as-of': '2026-09-02T23:00:00Z',
          'retrieved-at': '2026-09-02T23:00:00Z',
          completeness: /** @type {'complete'} */ ('complete'),
          freshness: /** @type {'fresh'} */ ('fresh'),
          availability: /** @type {'available'} */ ('available')
        }
      }
    };

    const rendered = renderDashboard({ document, sources });
    expect(rendered.querySelectorAll('.site-callout')).toHaveLength(2);
    expect(rendered.querySelector('[data-site-callout="rate-limit-message"]')?.textContent).toContain('Dashboard data is partial');
    const detailsLink = /** @type {HTMLAnchorElement | null} */ (
      rendered.querySelector('[data-site-callout="rate-limit-message"] .site-callout-link')
    );
    expect(detailsLink?.getAttribute('href')).toBe('#page-coverage');
    expect(detailsLink?.textContent).toBe('View coverage');
    const navigationLink = /** @type {HTMLAnchorElement | null} */ (
      rendered.querySelector('[data-site-callout="operator-message"] .site-callout-link')
    );
    expect(navigationLink?.getAttribute('href')).toBe('#page-usage');
    expect(navigationLink?.textContent).toBe('View usage');
    const dismiss = /** @type {HTMLButtonElement | null} */ (
      rendered.querySelector('[data-site-callout="operator-message"] .site-callout-dismiss')
    );
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss Operator message');
    dismiss?.click();
    expect(rendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(window.localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);

    const rerendered = renderDashboard({ document, sources });
    expect(rerendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(rerendered.querySelector('[data-site-callout="rate-limit-message"]')).not.toBeNull();

    const complete = renderDashboard({ document, sources: {} });
    expect(complete.querySelector('[data-site-callout="rate-limit-message"]')).toBeNull();
  });

  it('collapses the sidebar to icons and restores the persisted display mode', () => {
    window.localStorage.clear();
    try {
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      const toggle = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.sidebar-toggle'));
      const shell = rendered.querySelector('.app-shell');
      const overviewLink = rendered.querySelector('[data-nav-page-id="overview"]');

      expect(toggle?.getAttribute('aria-label')).toBe('Collapse navigation');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.querySelector('.octicon-sidebar-expand')).not.toBeNull();
      expect(overviewLink?.getAttribute('title')).toBe('Overview');

      toggle?.click();

      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(toggle?.getAttribute('aria-label')).toBe('Expand navigation');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.querySelector('.octicon-sidebar-collapse')).not.toBeNull();
      expect(window.localStorage.getItem('central-agentic-ops.dashboard.sidebar-collapsed')).toBe('true');

      const restored = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      expect(restored.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(restored.querySelector('.sidebar-toggle')?.getAttribute('aria-label')).toBe('Expand navigation');
    } finally {
      window.localStorage.clear();
    }
  });

  it('keeps the sidebar interactive when localStorage is unavailable', () => {
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
    try {
      const rendered = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      const toggle = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.sidebar-toggle'));
      const shell = rendered.querySelector('.app-shell');

      expect(shell?.classList.contains('sidebar-collapsed')).toBe(false);
      toggle?.click();
      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(toggle?.getAttribute('aria-label')).toBe('Expand navigation');
    } finally {
      if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
    }
  });

  it('renders a mobile view menu with full labels and closes it after selection', () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    const menu = /** @type {HTMLDetailsElement | null} */ (rendered.querySelector('.mobile-nav-menu'));
    const menuLinks = [...rendered.querySelectorAll('.mobile-nav-menu-list [data-mobile-nav-page-id]')];

    expect(menu?.querySelector('summary')?.getAttribute('aria-label')).toBe('Select view');
    expect(rendered.classList.contains('dashboard-mobile-overview-actions')).toBe(true);
    expect(menuLinks.every((link) => link.querySelector('.octicon') !== null)).toBe(true);
    expect(menuLinks.map((link) => link.textContent?.trim())).toEqual([
      'Overview',
      'Repositories',
      'Packages',
      'Workflows',
      'Runs',
      'Events',
      'Transactions',
      'Firewall',
      'Work',
      'Operations',
      'Insights',
      'Operational health',
      'Runtime',
      'Performance',
      'Security',
      'Experiments',
      'Value',
      'Cost',
      'Admission',
      'Preview',
      'Readiness',
      'GitHub API',
      'Updates',
      'Safe Outputs',
      'Detection',
      'Dispatches',
      'MCPs',
      'Models & agents',
      'UK AI advisory',
      'AW Doctor',
      'Dependabot',
      'EU CRA',
      'AW Optimization'
    ]);

    const costLink = menuLinks.find((link) => link.textContent?.trim() === 'Cost');
    menu?.setAttribute('open', '');
    /** @type {HTMLAnchorElement | undefined} */ (costLink)?.click();

    expect(menu?.hasAttribute('open')).toBe(false);
    expect(costLink?.getAttribute('aria-current')).toBe('page');
    expect(rendered.classList.contains('dashboard-mobile-overview-actions')).toBe(false);
    /** @type {HTMLAnchorElement | undefined} */ (menuLinks.find((link) => link.textContent?.trim() === 'Overview'))?.click();
    expect(rendered.classList.contains('dashboard-mobile-overview-actions')).toBe(true);
    window.history.replaceState(null, '', '/');
  });

  it('reveals mobile history navigation after an in-app route and goes back through browser history', () => {
    window.history.replaceState(null, '', '/');
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    const back = /** @type {HTMLButtonElement | null} */ (rendered.querySelector('.mobile-history-back'));
    const cost = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="cost"]'));

    expect(back?.hidden).toBe(true);
    cost?.click();
    expect(back?.hidden).toBe(false);

    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    back?.click();
    expect(historyBack).toHaveBeenCalledOnce();
    historyBack.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  it('closes the mobile view menu on Escape and restores focus to its toggle', () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });
    document.body.append(rendered);
    const menu = /** @type {HTMLDetailsElement | null} */ (rendered.querySelector('.mobile-nav-menu'));
    const summary = menu?.querySelector('summary');

    menu?.setAttribute('open', '');
    menu?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(menu?.hasAttribute('open')).toBe(false);
    expect(rendered.ownerDocument.activeElement).toBe(summary);
    rendered.remove();
  });

  it('renders filter bars for the Runtime, Security, and Value pages', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });

    expect(authoritativeDashboardDocument.dashboard.defaults?.time).toBeUndefined();
    expect(rendered.querySelector('.dashboard-horizon')?.getAttribute('aria-label')).toBe('Horizon unavailable');
    expect(rendered.querySelector('.dashboard-horizon')?.classList.contains('dashboard-horizon-skeleton')).toBe(true);
    expect(rendered.querySelectorAll('.dashboard-horizon')).toHaveLength(1);
    expect(rendered.querySelector('.freshness')).toBeNull();
    const horizonHelp = rendered.querySelector('.dashboard-horizon .tooltip-trigger');
    const horizonTooltip = rendered.querySelector('.dashboard-horizon .tooltip-content');
    expect(horizonHelp).toBeNull();
    expect(horizonTooltip).toBeNull();

    for (const pageId of ['runtime', 'security', 'firewall', 'operational-value']) {
      await activatePage(rendered, pageId);
      const filterBar = rendered.querySelector('.report-actions > .filter-bar');
      expect(filterBar?.querySelector('input')?.value).toBe('');
      expect(/** @type {HTMLSelectElement | null} */ (
        filterBar?.querySelector('[aria-label="Time window"]')
      )?.value).toBe('all');
      expect(filterBar?.querySelector('.count-badge')?.textContent).toBe('3');
      expect([...filterBar?.querySelectorAll('.mode-filter-control input') ?? []].every(
        (input) => /** @type {HTMLInputElement} */ (input).checked
      )).toBe(true);
      const filterControl = filterBar?.querySelector('.filter-control');
      const horizon = rendered.querySelector('.dashboard-horizon');
      expect(filterControl).not.toBeNull();
      expect(horizon).not.toBeNull();
      expect(filterBar?.contains(horizon)).toBe(true);
      expect(filterBar?.querySelector('.scope-period')).toBeNull();
      expect(filterBar?.querySelector('.export-control')).toBeNull();
    }
  });

  it('renders job performance as one full-view lazy table', async () => {
    const metadata = {
      'source-id': 'performance-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-03T12:00:00Z',
      'retrieved-at': '2026-09-03T12:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'run-performance': {
          source: 'run-performance',
          metadata,
          rows: [
            { run: '1', 'started-at': '2026-09-03T10:00:00Z', 'run-duration-seconds': 60 },
            { run: '2', 'started-at': '2026-09-03T11:00:00Z', 'run-duration-seconds': 180 }
          ]
        },
        'job-performance': {
          source: 'job-performance',
          metadata,
          rows: [
            { run: '1', 'started-at': '2026-09-03T10:00:00Z', job: 'agent', runner: 'ubuntu-latest', 'sandbox-runtime': 'gvisor', engine: 'copilot', model: 'gpt-5.4', 'job-duration-seconds': 45 },
            { run: '2', 'started-at': '2026-09-03T11:00:00Z', job: 'agent', runner: 'ubuntu-latest', 'sandbox-runtime': 'docker', engine: 'pi', model: 'claude-sonnet-5', 'job-duration-seconds': 150 }
          ]
        }
      }
    });

    const page = await activatePage(rendered, 'performance');
    const configuredPages = /** @type {Array<{ id: string, views: Array<{ id: string }> }>} */ (
      authoritativeDashboardDocument.dashboard.pages
    );
    const configuredPage = configuredPages
      .find(({ id }) => id === 'performance');
    expect([...page?.querySelectorAll('[data-view-id]') ?? []].map((view) => view.getAttribute('data-view-id')))
      .toEqual(configuredPage?.views.map(({ id }) => id));
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('[data-chart-widget]')).toBeNull();
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(page?.textContent).toContain('45s');
    expect(page?.textContent).toContain('2m 30s');
    expect(page?.textContent).toContain('gvisor');
    expect(page?.textContent).toContain('gpt-5.4');
  });

  it('applies the JSON horizon and lazily loads database counts for its tooltip', async () => {
    const loadHorizonSources = vi.fn().mockResolvedValue({
      'database-package-count': { rows: [{ packages: 2 }] },
      'database-repository-count': { rows: [{ repositories: 3 }] },
      'database-workflow-count': { rows: [{ workflows: 4 }] },
      'database-run-count': { rows: [{ runs: 12 }] },
      'database-event-count': { rows: [{ events: 89 }] }
    });
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'horizon-dashboard',
          title: 'Horizon Dashboard',
          horizon: {
            label: 'Data horizon',
            tooltip: {
              label: 'Data horizon details',
              description: 'Data is included from the start up to the exclusive end.',
              icon: 'question'
            }
          },
          defaults: { time: { range: '1w' } },
          pages: [{
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Runs',
            views: [{
              id: 'recent-runs',
              title: 'Recent runs',
              data: { source: 'runs' },
              mark: 'table',
              encoding: { columns: [{ field: 'run' }] }
            }]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: 'recent', 'observed-at': '2026-08-30T12:00:00Z' },
            { run: 'expired', 'observed-at': '2026-08-20T12:00:00Z' },
            { run: 'timeless' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-01T12:00:00Z',
            'retrieved-at': '2026-09-01T12:00:00Z',
            'coverage-start': '2026-08-30T12:30:00Z',
            'coverage-end': '2026-09-01T12:00:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      },
      loadHorizonSources
    });

    const table = rendered.querySelector('.custom-table');
    expect(table?.textContent).toContain('recent');
    expect(table?.textContent).toContain('timeless');
    expect(table?.textContent).not.toContain('expired');
    expect(rendered.querySelector('.dashboard-horizon')?.getAttribute('data-dashboard-evaluated-at')).toBe('2026-09-01T12:00:00.000Z');
    expect(rendered.querySelector('.horizon-toggle')?.getAttribute('aria-label')).toContain('2 days');
    expect(rendered.querySelector('.filter-tuning-controls .horizon-details')?.textContent).toBe(
      'Data is included from the start up to the exclusive end.StartAug 30, 2026, 12:30 PM UTCEndSep 1, 2026, 12:00 PM UTCDuration2 days'
    );
    expect(rendered.querySelector('.filter-tuning-controls .horizon-details time:first-of-type')?.getAttribute('datetime')).toBe('2026-08-30T12:30:00.000Z');
    expect(rendered.querySelectorAll('.filter-tuning-controls .horizon-details time')[1]?.getAttribute('datetime')).toBe('2026-09-01T12:00:00.000Z');
    expect(loadHorizonSources).not.toHaveBeenCalled();
    expect(rendered.querySelector('.horizon-tooltip-counts')?.textContent).toBe('Database counts load on hover');

    rendered.querySelector('.horizon-summary')?.dispatchEvent(new Event('pointerenter'));

    await vi.waitFor(() => {
      expect(rendered.querySelector('.horizon-tooltip-counts')?.textContent)
        .toBe('2 packages · 3 repositories · 4 workflows · 12 runs · 89 events');
    });
    expect(loadHorizonSources).toHaveBeenCalledOnce();

    const accountMenu = /** @type {HTMLDetailsElement | null} */ (rendered.querySelector('.account-menu'));
    if (!accountMenu) throw new Error('account menu did not render');
    accountMenu.open = true;
    accountMenu.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => {
      expect([...rendered.querySelectorAll('[data-database-count]')].map((node) => node.textContent))
        .toEqual(['2', '3', '4', '12', '89']);
    });
    expect(rendered.querySelector('.database-counts-status')?.textContent).toBe('Database totals');
    expect(loadHorizonSources).toHaveBeenCalledOnce();

    rendered.querySelector('.horizon-toggle')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(loadHorizonSources).toHaveBeenCalledOnce();
  });

  it('renders Security assurance records as one full-view lazy table', async () => {
    const metadata = {
      'source-id': 'security-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-31T05:00:00Z',
      'retrieved-at': '2026-08-31T05:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { workflow: '.github/workflows/daily.md', 'workflow-name': 'Daily operations', package: 'daily', 'package-name': 'Daily', 'inventory-ready': true },
            { workflow: '.github/workflows/release.md', 'workflow-name': '<img src=x onerror=alert(1)>', package: 'release', 'package-name': 'Release', 'inventory-ready': false }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { workflow: '.github/workflows/daily.md', run: '101', 'run-conclusion': 'action-required', 'started-at': '2026-08-31T04:00:00Z', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/101', label: 'View run 101' } },
            { workflow: '.github/workflows/daily.md', run: '102', 'run-conclusion': 'action-required', 'started-at': '2026-08-31T05:00:00Z', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/102', label: 'View run 102' } }
          ],
          metadata
        },
        findings: {
          source: 'findings',
          rows: [
            {
              workflow: '.github/workflows/release.md',
              finding: 'warning-1',
              'finding-kind': 'authored-warning',
              'finding-summary': '<img src=x onerror=alert(1)>',
              'finding-severity': 'high',
              'finding-status': 'open',
              'observed-at': '2026-08-31T05:00:00Z',
              'external-link': { relation: 'external', href: 'https://github.com/githubnext/gh-aw-cao/issues/1', label: 'View warning output' }
            },
            {
              workflow: '.github/workflows/daily.md',
              finding: 'warning-2',
              'finding-kind': 'authored-warning',
              'finding-summary': 'Second warning',
              'finding-severity': 'high',
              'finding-status': 'open',
              'observed-at': '2026-08-31T04:00:00Z'
            }
          ],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [{
            'safe-output': 'warning-1',
            'outcome-title': 'Release warning'
          }],
          metadata
        }
      }
    });

    const page = await activatePage(rendered, 'security');
    const dashboardPage = authoritativeDashboardDocument.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'security');
    expect(dashboardPage).toMatchObject({ kind: 'custom' });
    expect(dashboardPage).not.toHaveProperty('page');
    expect(dashboardPage).not.toHaveProperty('sections');
    expect(rendered.querySelector('[data-nav-page-id="security"] .octicon-shield')).not.toBeNull();
    expect(page?.querySelectorAll('.layout-section')).toHaveLength(0);
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('[data-chart-widget="pie"]')).toBeNull();
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(page?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(page?.querySelector('img')).toBeNull();
  });

  it('renders operational-value observations as one full-view lazy table', async () => {
    const metadata = {
      'source-id': 'value-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-31T05:00:00Z',
      'retrieved-at': '2026-08-31T05:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    /** @param {string} run */
    const evidenceLink = (run) => ({
      relation: 'evidence',
      href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`,
      label: `View run ${run}`
    });
    /** @param {string} run */
    const runLink = (run) => ({
      relation: 'run',
      href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`,
      label: `View run ${run}`
    });
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'operational-values': {
          source: 'operational-values',
          rows: [
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.md',
              run: '100',
              'operational-value': 0.2,
              'operational-value-definition': 'daily-value',
              'operational-case': 'triage',
              'evaluator-digest': 'sha256:old',
              'requested-evidence-at': '2026-08-27T05:00:00Z',
              'observed-at': '2026-08-27T05:10:00Z',
              'maturity-status': 'matured',
              'delta-from-baseline': 0,
              'evidence-link': evidenceLink('100')
            },
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.md',
              run: '101',
              'operational-value': 0.8,
              'operational-value-definition': 'daily-value',
              'operational-case': 'triage',
              'evaluator-digest': 'sha256:current',
              'requested-evidence-at': '2026-08-29T05:00:00Z',
              'observed-at': '2026-08-29T05:10:00Z',
              'maturity-status': 'matured',
              'delta-from-baseline': 0.1,
              'evidence-link': evidenceLink('101')
            },
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.md',
              run: '102',
              'operational-value': 0.6,
              'operational-value-definition': 'daily-value',
              'operational-case': 'release',
              'evaluator-digest': 'sha256:current',
              'requested-evidence-at': '2026-08-29T05:00:00Z',
              'observed-at': '2026-08-30T05:10:00Z',
              'maturity-status': 'matured',
              'delta-from-baseline': 0.05,
              'evidence-link': evidenceLink('102')
            },
            {
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.md',
              run: '103',
              'operational-value': 0.4,
              'operational-value-definition': 'review-value',
              'operational-case': 'review',
              'evaluator-digest': 'sha256:review',
              'requested-evidence-at': '2026-08-31T04:00:00Z',
              'observed-at': '2026-08-31T04:10:00Z',
              'maturity-status': 'interim',
              'delta-from-baseline': null,
              'evidence-link': evidenceLink('103')
            }
          ],
          metadata
        },
        'grader-observations': {
          source: 'grader-observations',
          rows: [
            {
              grader: 'daily-value',
              run: '100',
              status: 'pass',
              value: 0.2,
              'maturity-status': 'matured',
              'baseline-value': 0.2,
              'delta-from-baseline': 0,
              'evaluator-digest': 'sha256:old',
              'run-link': runLink('100')
            },
            {
              grader: 'daily-value',
              run: '101',
              status: 'pass',
              value: 0.8,
              'maturity-status': 'matured',
              'baseline-value': 0.7,
              'delta-from-baseline': 0.1,
              'evaluator-digest': 'sha256:current',
              'run-link': runLink('101')
            },
            {
              grader: 'daily-value',
              run: '102',
              status: 'pass',
              value: 0.6,
              'maturity-status': 'matured',
              'baseline-value': 0.55,
              'delta-from-baseline': 0.05,
              'evaluator-digest': 'sha256:current',
              'run-link': runLink('102')
            },
            {
              grader: 'review-value',
              run: '103',
              status: 'pass',
              value: 0.4,
              'maturity-status': 'interim',
              'baseline-value': null,
              'delta-from-baseline': null,
              'evaluator-digest': 'sha256:review',
              'run-link': runLink('103')
            },
            {
              grader: 'missing-value',
              run: 'Unavailable',
              status: 'unavailable',
              value: null,
              'maturity-status': 'unavailable',
              'baseline-value': null,
              'delta-from-baseline': null,
              'evaluator-digest': ''
            }
          ],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              'safe-output': 'outcome-1',
              'outcome-state': 'pending',
              'observed-at': '2026-08-31T04:15:00Z',
              'external-link': { relation: 'external', href: 'https://github.com/githubnext/gh-aw-cao/issues/1', label: 'View pending output' }
            },
            { 'safe-output': 'outcome-2', 'outcome-state': 'accepted', 'observed-at': '2026-08-30T04:15:00Z' }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [],
          metadata: { ...metadata, completeness: /** @type {'partial'} */ ('partial') }
        }
      }
    });

    const page = await activatePage(rendered, 'operational-value');
    const dashboardPage = authoritativeDashboardDocument.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'operational-value');
    expect(dashboardPage).toMatchObject({ kind: 'custom', title: 'Value & outcomes' });
    expect(dashboardPage).not.toHaveProperty('page');
    expect(dashboardPage).not.toHaveProperty('sections');
    expect(rendered.querySelector('[data-nav-page-id="operational-value"] .octicon-beaker')).not.toBeNull();
    const tables = page?.querySelectorAll('.custom-table') ?? [];
    expect(tables).toHaveLength(1);
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(tables[0]?.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(tables[0]?.querySelector('.status-success')?.textContent).toBe('pass');
    expect(tables[0]?.querySelector('.status-attention')?.textContent).toBe('unavailable');
    expect(tables[0]?.textContent).toContain('Mature');
    expect(tables[0]?.textContent).toContain('Interim');
    expect(tables[0]?.textContent).toContain('sha256:curre');
    expect(tables[0]?.querySelector('a[aria-label="View run 103"]')?.getAttribute('href')).toContain('/actions/runs/103');
    const graderRegion = /** @type {HTMLElement} */ (tables[0]?.closest('.table-region'));
    const graderFilter = /** @type {HTMLInputElement} */ (graderRegion?.querySelector('[data-table-filter]'));
    expect(graderFilter.closest('label')?.textContent).toContain('Filter Operational Value Ledger');
    graderFilter.value = 'review-value';
    graderFilter.dispatchEvent(new Event('input'));
    expect([...graderRegion.querySelectorAll('tbody tr')]
      .filter((row) => row instanceof HTMLTableRowElement && !row.hidden)).toHaveLength(1);
    expect(graderRegion.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 result');
  });

  it('DLS-VIEW-018 DLS-VIEW-019 DLS-VIEW-020 progressively discloses supplemental views in source order', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'progressive-disclosure-dashboard',
        title: 'Progressive Disclosure',
        pages: [
          {
            id: 'runs',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'run-count',
                title: 'Run count',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              },
              {
                id: 'completed-runs',
                title: 'Completed runs',
                disclosure: 'supplemental',
                data: { source: 'runs', filters: { 'run-status': 'completed' } },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-status': 'completed' },
            { run: '2', 'run-status': 'queued' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const views = rendered.querySelectorAll('[data-page-id="runs"] > .custom-view-grid > .custom-view');
    expect(views).toHaveLength(2);
    expect(views[0]?.getAttribute('data-disclosure')).toBe('essential');
    const supplemental = /** @type {HTMLDetailsElement} */ (views[1]);
    expect(supplemental.tagName).toBe('DETAILS');
    expect(supplemental.getAttribute('data-disclosure')).toBe('supplemental');
    expect(supplemental.open).toBe(false);
    expect(supplemental.querySelector('summary')?.textContent).toContain('Completed runs');
    const supplementalContent = supplemental.querySelector(':scope > .page-section');
    expect(supplementalContent?.textContent).toContain('1');
    expect(supplementalContent?.classList.contains('custom-view')).toBe(false);
    expect(supplementalContent?.hasAttribute('data-view-layout')).toBe(false);
  });

  it('DLS-PAGE-002 DLS-PAGE-014 renders the report-style six-domain operational overview deterministically', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'overview-dashboard',
        title: 'Overview Dashboard',
        pages: [
          {
            id: 'overview',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'overview',
            title: 'Overview',
            definition: {
              'data-state': {
                availability: true
              },
              views: [
                { id: 'workflows-source', data: { source: 'workflows' } },
                { id: 'runs-source', data: { source: 'runs' } },
                { id: 'usage-source', data: { source: 'usage' } },
                { id: 'findings-source', data: { source: 'findings' } },
                { id: 'operational-values-source', data: { source: 'operational-values' } }
              ]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        repositories: {
          source: 'repositories',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao' },
            { organization: 'github', repository: 'dashboard-service' }
          ],
          metadata: {
            'source-id': 'repositories-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', 'workflow-role': 'orchestrator', workflow: '.github/workflows/daily.yml', 'workflow-active': 'true', 'rollout-mode': 'review', 'package-rollout-percent': 100, 'package-targets': [{ repository: 'github/gh-aw', mode: 'live' }, { repository: 'github/gh-aw-firewall', mode: 'review' }, { repository: 'github/gh-aw-mcpg', mode: 'review' }, { repository: 'github/gh-aw-actions', mode: 'review' }, { repository: 'github/gh-aw-threat-detection', mode: 'review' }, { repository: 'githubnext/gh-aw-workshop', mode: 'review' }], 'max-ai-credits': 10, 'observed-at': '2026-08-29T09:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', 'workflow-role': 'worker', workflow: '.github/workflows/review.yml', 'workflow-active': 'false', 'rollout-mode': 'review', 'max-ai-credits': 20, 'observed-at': '2026-08-29T09:05:00Z' }
          ],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        runs: {
          source: 'runs',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', event: 'workflow_dispatch', 'started-at': '2026-08-29T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success', 'rollout-mode': 'live', engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', event: 'workflow_dispatch', 'started-at': '2026-08-29T11:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure', 'rollout-mode': 'live', engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1003', 'started-at': '2026-08-29T12:00:00Z', 'run-status': 'in-progress', 'run-conclusion': 'unknown', 'rollout-mode': 'review', engine: 'anthropic', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            { package: 'daily-ops', 'runtime-repository': 'github/gh-aw-cao', run: '1001', 'safe-output': 'daily-output-1', 'outcome-state': 'accepted', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:10:00Z' }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [
            { repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', 'rollout-mode': 'live', aic: 12, engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'observed-at': '2026-08-29T10:05:00Z' },
            { repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', 'rollout-mode': 'live', aic: 18, engine: 'openai', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'observed-at': '2026-08-29T11:05:00Z' },
            { repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1003', 'rollout-mode': 'review', aic: 5, engine: 'anthropic', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7', 'observed-at': '2026-08-29T12:05:00Z' }
          ],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        findings: {
          source: 'findings',
          rows: [
            {
              finding: 'finding-2',
              'finding-summary': 'Review workflow needs triage',
              'finding-kind': 'authored-warning',
              'finding-severity': 'medium',
              'finding-status': 'unknown',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.yml',
              'observed-at': '2026-08-29T12:30:00Z',
              'issue-link': { relation: 'issue', href: 'https://example.com/issues/2', label: 'Issue 2' },
              'pull-request-link': { relation: 'pull-request', href: 'https://example.com/pulls/2', label: 'PR 2' },
              'run-link': { relation: 'run', href: 'https://example.com/runs/1003', label: 'Run 1003' }
            },
            {
              finding: 'finding-1',
              'finding-summary': 'Daily workflow regression',
              'finding-kind': 'authored-warning',
              'finding-severity': 'high',
              'finding-status': 'unknown',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              'observed-at': '2026-08-29T11:30:00Z',
              'issue-link': { relation: 'issue', href: 'https://example.com/issues/1', label: 'Issue 1' },
              'pull-request-link': { relation: 'pull-request', href: 'https://example.com/pulls/1', label: 'PR 1' },
              'run-link': { relation: 'run', href: 'https://example.com/runs/1002', label: 'Run 1002' }
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        'operational-values': {
          source: 'operational-values',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'operational-value': 0.65,
              'operational-value-definition': 'ship-success',
              'observed-at': '2026-08-29T10:30:00Z',
              'evidence-link': { relation: 'evidence', href: 'https://example.com/evidence/1', label: 'Evidence 1' }
            },
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/review.yml',
              run: '1003',
              'operational-value': 0.8,
              'operational-value-definition': 'review-quality',
              'observed-at': '2026-08-29T12:45:00Z',
              'evidence-link': { relation: 'evidence', href: 'https://example.com/evidence/2', label: 'Evidence 2' }
            }
          ],
          metadata: {
            'source-id': 'operational-values-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const overviewPage = rendered.querySelector('[data-page-name="overview"]');
    expect(overviewPage?.getAttribute('data-page-kind')).toBe('custom');
    expect(overviewPage?.querySelectorAll('.custom-view')).toHaveLength(2);
    expect(overviewPage?.querySelectorAll('.layout-section')).toHaveLength(0);
    expect(overviewPage?.querySelector('.overview-observability h2')?.textContent).toBe('Attention by domain');
    const cards = [...(overviewPage?.querySelectorAll('.attention-domain-card') ?? [])];
    expect(cards).toHaveLength(6);
    expect(cards.map((card) => card.querySelector('header strong')?.textContent)).toEqual([
      'Runtime health',
      'Episodes & autonomy',
      'Security & controls',
      'Evidence quality',
      'Value & outcomes',
      'Cost & efficiency'
    ]);
    expect(cards[0]?.classList.contains('attention-domain-critical')).toBe(true);
    expect(cards[0]?.textContent).toContain('1 failed');
    expect(cards[1]?.classList.contains('attention-domain-critical')).toBe(true);
    expect(cards[1]?.textContent).toContain('2 observed');
    expect(cards[2]?.textContent).toContain('2 signals');
    expect(cards[3]?.textContent).toContain('3 gaps');
    expect(cards[4]?.textContent).toContain('Threshold unavailable');
    expect(cards[5]?.textContent).toContain('35');
    expect(cards[5]?.textContent).not.toContain('35 AIC');
    expect(cards[5]?.textContent).toContain('Monitor');
    expect(cards.map((card) => card.getAttribute('href'))).toEqual([
      '#page-runtime',
      '#page-runtime?section=runtime-observed-root-episodes-heading',
      '#page-security',
      '#page-coverage',
      '#page-operational-value',
      '#page-cost'
    ]);
    expect(cards.every((card) => card.textContent?.includes('Open evidence'))).toBe(true);
    expect(overviewPage?.querySelector('.overview-method-note')?.textContent).toContain('State key:');
    expect(overviewPage?.querySelector('.overview-package-status')).toBeNull();
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('.data-state-summary'))?.hidden).toBe(true);
  });

  it('DLS-PAGE-002 keeps unavailable prerequisites visible in the domain overview', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'overview-no-allowance-dashboard',
        title: 'Overview Dashboard',
        pages: [
          {
            id: 'overview',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'overview',
            title: 'Overview',
            definition: {
              'data-state': { availability: true },
              views: [{ id: 'workflows-source', data: { source: 'workflows' } }]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', package: 'daily-ops', 'package-name': 'Daily Ops', 'workflow-role': 'orchestrator', workflow: '.github/workflows/daily.yml', 'workflow-active': 'true', 'rollout-mode': 'live' }
          ],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const overviewPage = rendered.querySelector('[data-page-name="overview"]');
    const cards = [...(overviewPage?.querySelectorAll('.attention-domain-card') ?? [])];
    expect(cards).toHaveLength(6);
    const runtimeCard = cards.find((card) => card.textContent?.includes('Runtime health'));
    const valueCard = cards.find((card) => card.textContent?.includes('Value & outcomes'));
    const evidenceCard = cards.find((card) => card.textContent?.includes('Evidence quality'));
    expect(runtimeCard?.textContent).toContain('Unavailable');
    expect(runtimeCard?.textContent).toContain('Not observed');
    expect(runtimeCard?.textContent).toContain('workflow registrations may still be current');
    expect(valueCard?.textContent).toContain('Threshold unavailable');
    expect(valueCard?.textContent).toContain('no ROI is inferred');
    expect(evidenceCard?.textContent).toContain('2 gaps');
    expect(overviewPage?.querySelector('.package-status-card')).toBeNull();
  });

  it('DLS-PAGE-014 DLS-PAGE-015 renders mode-filtered package AIC utilization and package-run trends', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'packages-dashboard',
        title: 'Packages Dashboard',
        pages: [{
          id: 'packages',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'packages',
          title: 'Packages',
          description: 'Activity from centrally managed packages.',
          definition: {
            'data-state': { availability: true },
            views: [
              { id: 'package-workflows', data: { source: 'workflows' } },
              { id: 'package-runs', data: { source: 'runs' } },
              { id: 'package-outcomes', data: { source: 'outcomes' } },
              { id: 'package-usage', data: { source: 'usage' } },
              { id: 'packages-utilization', title: 'Package AIC utilization', data: { sources: ['workflows', 'usage'] }, mark: 'element', element: 'package-utilization' },
              { id: 'packages-run-trend', title: 'All runs over time', data: { sources: ['workflows', 'runs', 'outcomes'] }, mark: 'element', element: 'package-run-trend' },
              { id: 'packages-summary', title: 'All output by package', data: { sources: ['workflows', 'usage', 'findings', 'outcomes', 'runs'] }, mark: 'element', element: 'package-summary-table' }
            ]
          }
        }]
      }
    };
    const metadata = {
      'source-id': 'packages-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-29T20:00:00Z',
      'retrieved-at': '2026-08-29T20:01:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'} */ ('available')
    };
    const rendered = renderDashboard({
      document,
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'package-aic-allowance': 250, 'package-inventory-warnings': 2 },
            { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'package-aic-allowance': 250, 'package-inventory-warnings': 2 },
            { package: 'empty-ops', 'package-name': 'Empty Ops', workflow: '.github/workflows/empty.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'live', 'max-ai-credits': 80, 'inventory-ready': true }
          ],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' },
            { workflow: '.github/workflows/unmanaged.md', run: '3', 'started-at': '2026-08-29T11:00:00Z', 'run-conclusion': 'cancelled', 'rollout-mode': 'review' }
          ],
          metadata
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            { package: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' },
            { package: 'daily-ops', run: '2', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:05:00Z' },
            { package: 'daily-ops', run: '2', 'run-conclusion': 'failure', 'rollout-mode': 'live', 'published-at': '2026-08-29T10:00:00Z', 'observed-at': '2026-08-29T10:06:00Z' },
            { package: 'daily-ops', run: 'old', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-07-01T10:00:00Z', 'observed-at': '2026-07-01T10:00:00Z' }
          ],
          metadata
        },
        usage: {
          source: 'usage',
          rows: [
            { workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 4, 'rollout-mode': 'review' },
            { workflow: '.github/workflows/daily.md', run: '1', invocation: 'b', aic: 6, 'rollout-mode': 'review' },
            { workflow: '.github/workflows/daily-worker.md', run: '2', invocation: 'c', aic: 30, 'rollout-mode': 'live' }
          ],
          metadata: { ...metadata, completeness: /** @type {'partial'} */ ('partial') }
        },
        findings: {
          source: 'findings',
          rows: [
            { workflow: '.github/workflows/daily-worker.md', run: '2', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:05:00Z' },
            { workflow: '.github/workflows/daily-worker.md', run: '2', finding: 'warning-2', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-29T10:06:00Z' }
          ],
          metadata
        }
      }
    });

    const packagesPage = rendered.querySelector('[data-page-name="packages"]');
    expect(packagesPage?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(packagesPage?.querySelector('[data-table-filter]')).not.toBeNull();
    const packageSummaryRows = [...(packagesPage?.querySelectorAll('.custom-table tbody tr') ?? [])];
    expect(packageSummaryRows).toHaveLength(2);
    expect(packageSummaryRows[0]?.textContent).toContain('Daily Ops');
    expect(packageSummaryRows[0]?.textContent).toContain('40');
    expect(packageSummaryRows[1]?.textContent).toContain('Empty Ops');
    expect(/** @type {HTMLElement | null} */ (packagesPage?.querySelector('.data-state-summary'))?.hidden).toBe(true);

  });

  it('DLS-SEM-022 DLS-SEM-023 DLS-PAGE-014 DLS-PAGE-015 keeps packages repository-scoped and distinguishes unknown or unavailable telemetry', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'repository-scoped-packages',
        title: 'Repository-scoped packages',
        pages: [{
          id: 'packages',
          kind: /** @type {'built-in'} */ ('built-in'),
          page: 'packages',
          title: 'Packages'
        }]
      }
    };
    const metadata = {
      'source-id': 'packages-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-08-29T20:00:00Z',
      'retrieved-at': '2026-08-29T20:01:00Z',
      completeness: /** @type {'complete'|'unknown'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh'),
      availability: /** @type {'available'|'unavailable'} */ ('available')
    };
    const workflows = {
      source: 'workflows',
      rows: [
        { organization: 'octo-org', repository: 'alpha', package: 'daily-ops', 'package-name': 'Daily Ops', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'max-ai-credits': 100, 'package-aic-allowance': 100 },
        { organization: 'octo-org', repository: 'beta', package: 'daily-ops', 'package-name': 'Daily Ops', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'max-ai-credits': 200, 'package-aic-allowance': 999 }
      ],
      metadata
    };
    const runs = {
      source: 'runs',
      rows: [
        { organization: 'octo-org', repository: 'alpha', workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-29T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' },
        { organization: 'octo-org', repository: 'beta', workflow: '.github/workflows/daily.md', run: '2', 'started-at': '2026-08-29T11:00:00Z', 'run-conclusion': 'failure', 'rollout-mode': 'review' }
      ],
      metadata
    };
    const usage = {
      source: 'usage',
      rows: [
        { organization: 'octo-org', repository: 'alpha', workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 10, 'rollout-mode': 'review' },
        { organization: 'octo-org', repository: 'beta', workflow: '.github/workflows/daily.md', run: '2', invocation: 'b', aic: 20, 'rollout-mode': 'review' }
      ],
      metadata: { ...metadata, completeness: /** @type {'unknown'} */ ('unknown') }
    };

    const rendered = renderDashboard({ document, sources: { workflows, runs, usage } });
    const packagesPage = rendered.querySelector('[data-page-name="packages"]');
    const rows = [...(packagesPage?.querySelectorAll('.custom-table tbody tr') ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('10');
    expect(rows[1]?.textContent).toContain('20');
    expect(packagesPage?.querySelector('[data-table-filter]')).not.toBeNull();

    const unavailable = renderDashboard({
      document,
      sources: {
        workflows,
        runs: { ...runs, rows: [], metadata: { ...metadata, availability: /** @type {'unavailable'} */ ('unavailable'), completeness: /** @type {'unknown'} */ ('unknown') } },
        usage
      }
    });
    const unavailablePackagesPage = unavailable.querySelector('[data-page-name="packages"]');
    expect(unavailablePackagesPage?.querySelector('.custom-table')).not.toBeNull();
  });

  it('DLS-PAGE-001 DLS-PAGE-002 DLS-PAGE-003 DLS-PAGE-004 DLS-PAGE-005 DLS-PAGE-006 DLS-PAGE-007 DLS-PAGE-008 DLS-PAGE-009 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 DLS-PAGE-015 authoritative dashboard.json keeps the remaining built-in pages declarative', () => {
    const pages = authoritativeDashboardDocument.dashboard.pages.filter(
      (/** @type {{ kind: string }} */ page) => page.kind === 'built-in'
    );
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(11);
    expect(pages.map((/** @type {{ page: string }} */ page) => page.page)).toEqual([
      'overview',
      'organizations',
      'repositories',
      'packages',
      'workflows',
      'runs',
      'experiments',
      'graders',
      'evals',
      'usage',
      'findings'
    ]);

    for (const page of pages) {
      expect(page.kind).toBe('built-in');
      expect(page.id).toBe(page.page === 'overview' ? 'operations' : page.page);
      expect(typeof page.icon).toBe('string');
      expect(page.definition?.['data-state']).toEqual({
        availability: true
      });
      expect(Array.isArray(page.definition?.views)).toBe(true);
      expect(page.definition.views.length).toBeGreaterThan(0);
      expect(page.definition.views.every((/** @type {{ data?: { source?: unknown, sources?: unknown } }} */ view) => (
        typeof view?.data?.source === 'string'
        || (Array.isArray(view?.data?.sources) && view.data.sources.every((source) => typeof source === 'string'))
      ))).toBe(true);
    }

    const runsPage = pages.find((/** @type {{ page: string }} */ page) => page.page === 'runs');
    expect(runsPage?.definition.views.map((/** @type {{ data: { source: string } }} */ view) => view.data.source))
      .toEqual(['runs-table', 'runs-table']);

    const repositoriesPage = pages.find((/** @type {{ page: string }} */ page) => page.page === 'repositories');
    expect(repositoriesPage?.definition.views).toMatchObject([
      {
        id: 'repositories-activity',
        title: 'Repositories',
        description: 'Repository-local execution health and all attributed package or local-workflow outcomes.',
        data: { source: 'repository-activity' },
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
        'empty-message': 'No repositories discovered.',
        encoding: {
          columns: [
            { field: 'repository', type: 'nominal', title: 'Repository' },
            { field: 'workflows', type: 'quantitative', title: 'Local AWs' },
            { field: 'reports', type: 'quantitative', title: 'Reports' },
            { field: 'evaluated-workflows', type: 'quantitative', title: 'Evaluated AWs' },
            { field: 'runs', type: 'quantitative', title: 'Local runs' },
            { field: 'failure-summary', type: 'nominal', title: 'Failure rate', filter: false },
            { field: 'aic', type: 'quantitative', title: 'Local AIC', unit: 'aic' },
            { field: 'status', type: 'nominal', title: 'Status', display: 'status' }
          ],
          href: { field: 'repository-link', type: 'nominal' }
        }
      }
    ]);
  });

  it('DLS-PAGE-002 DLS-PAGE-006 DLS-PAGE-008 DLS-PAGE-009 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 renders built-in sections in authoritative dashboard.json view order grouped by declared source instead of hard-coded section index positions', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'view-order-dashboard',
        title: 'View Order Dashboard',
        pages: [
          {
            id: 'runs',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'runs',
            title: 'Runs',
            definition: {
              'data-state': {
                availability: true
              },
              views: [
                { id: 'runs-table', title: 'Runs Inventory First', data: { source: 'runs' } },
                { id: 'runs-status', title: 'Run Status Second', data: { source: 'runs' } },
                { id: 'outcome-counts', title: 'Outcome Counts Third', data: { source: 'outcomes' } },
                { id: 'run-conclusions', title: 'Run Conclusions Fourth', data: { source: 'runs' } }
              ]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: applyDashboardQueries({
        runs: {
          source: 'runs',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'rollout-mode': 'live',
              engine: 'actions',
              'requested-model': 'gpt-4o',
              'resolved-model': 'gpt-4.1',
              'started-at': '2026-08-29T10:00:00Z'
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              run: '1001',
              'outcome-state': 'accepted'
            }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }, ['runs-table'])
    });

    const headings = [...rendered.querySelectorAll('[data-page-id="runs"] .page-section h3')].map((element) => element.textContent);
    expect(headings).toEqual(['Runs in the last week', 'Runs']);
    expect(rendered.querySelectorAll('[data-page-id="runs"] [data-chart-widget="swimlane"]')).toHaveLength(1);
    expect(rendered.querySelectorAll('[data-page-id="runs"] .custom-table')).toHaveLength(1);
    expect(rendered.querySelector('[data-page-id="runs"]')?.getAttribute('data-page-kind')).toBe('custom');
  });

  it('DLS-PAGE-009 DLS-PAGE-014 renders built-in evals page with distinguishable definitions and observations, observed subject, YES/NO/UNKNOWN result, evaluation model when available, time, provenance, and independent data state deterministically', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'evals-dashboard',
        title: 'Evals Dashboard',
        pages: [
          {
            id: 'evals',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'evals',
            title: 'Evals',
            definition: {
              'data-state': {
                availability: true
              },
              views: [
                { id: 'evals-source', data: { source: 'evals' } },
                { id: 'eval-observations-source', data: { source: 'eval-observations' } }
              ]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        evals: {
          source: 'evals',
          rows: [
            { eval: 'release-risk', 'eval-name': 'Release Risk', 'eval-question': 'Is the release risky?', 'requested-model': 'gpt-4o', 'observed-at': '2026-08-29T09:00:00Z' },
            { eval: 'doc-quality', 'eval-name': 'Documentation Quality', 'eval-question': 'Is the documentation complete?', 'requested-model': 'claude-3.5', 'observed-at': '2026-08-29T09:05:00Z' }
          ],
          metadata: {
            'source-id': 'evals-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        'eval-observations': {
          source: 'eval-observations',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', eval: 'release-risk', 'eval-result': 'YES', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', eval: 'release-risk', 'eval-result': 'UNKNOWN', 'requested-model': 'gpt-4o', 'resolved-model': '', 'rollout-mode': 'live', 'observed-at': '2026-08-29T10:10:00Z' },
            { organization: 'octo-org', repository: 'octo-repo', workflow: '.github/workflows/nightly.yml', run: '2001', eval: 'doc-quality', 'eval-result': 'NO', 'requested-model': 'claude-3.5', 'resolved-model': 'claude-3.7', 'rollout-mode': 'review', 'observed-at': '2026-08-29T10:20:00Z' }
          ],
          metadata: {
            'source-id': 'eval-observations-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const evalsPage = rendered.querySelector('[data-page-name="evals"]');
    expect(evalsPage?.textContent).toContain('Evals Evals Source');
    expect(evalsPage?.textContent).toContain('Evals Observations Source');
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('.data-state-summary'))?.hidden).toBe(true);
    expect(evalsPage?.querySelectorAll('.custom-table')[0]?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(evalsPage?.querySelectorAll('.custom-table')[1]?.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(evalsPage?.textContent).toContain('release-risk');
    expect(evalsPage?.textContent).toContain('UNKNOWN');

    const sidebarCurrentPage = rendered.querySelector('.primary-nav a[aria-current="page"]');
    expect(sidebarCurrentPage?.getAttribute('aria-current')).toBe('page');
    expect(sidebarCurrentPage?.textContent).toContain('Evals');

    const skipLink = rendered.querySelector('.skip-link');
    expect(skipLink?.getAttribute('href')).toBe('#main-content');

    expect(evalsPage?.textContent).toContain('NO');
    expect(evalsPage?.textContent).toContain('claude-3.7');
    expect(evalsPage?.textContent).not.toContain('Source: evals');
    expect(evalsPage?.textContent).not.toContain('Source: eval-observations');
  });

  it('DLS-SAFE-003 DLS-SAFE-004 DLS-SAFE-007 DLS-SAFE-010 renders non-empty accessible names and inert text labels while preserving only safe https external link attributes', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'findings-dashboard',
        title: 'Security Dashboard',
        pages: [
          {
            id: 'findings',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'findings',
            title: 'Findings',
            definition: {
              'data-state': {
                availability: true
              },
              views: [
                { id: 'findings-source', data: { source: 'findings' } }
              ]
            }
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        findings: {
          source: 'findings',
          rows: [
            {
              finding: 'unsafe-html',
              'finding-summary': '<img src=x onerror=alert(1)>',
              'finding-severity': 'critical',
              'finding-status': 'open',
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              'observed-at': '2026-08-29T12:00:00Z',
              'issue-link': {
                relation: 'issue',
                href: 'https://example.com/issues/1',
                label: 'Issue 1 label'
              }
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelector('#page-title')?.textContent).toBe('Findings');
    expect(rendered.querySelector('.sidebar-brand > span')?.textContent).toBe('github');
    expect(rendered.querySelector('[data-page-id="findings"] .custom-table thead')?.textContent).toContain('Issue Link');

    const summaryCell = rendered.querySelector('[data-page-id="findings"] .custom-table tbody td');
    expect(summaryCell?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(summaryCell?.querySelector('img')).toBeNull();

    const issueLink = rendered.querySelector('[data-page-id="findings"] .custom-table tbody a');
    expect(issueLink?.getAttribute('href')).toBe('https://example.com/issues/1');
    expect(issueLink?.getAttribute('aria-label')).toBe('Issue 1 label');
    expect(issueLink?.getAttribute('target')).toBe('_blank');
    expect(issueLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(issueLink?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('DLS-VIEW-013 DLS-VIEW-014 DLS-VIEW-015 DLS-SAFE-006 renders custom views with available, empty, and unavailable states while exposing only context-permitted observations and links', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'custom-dashboard',
        title: 'Custom Dashboard',
        pages: [
          {
            id: 'custom-views',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Custom Views',
            views: [
              {
                id: 'total-aic',
                title: 'Total AI Credits',
                data: {
                  source: 'usage',
                  filters: {
                    'rollout-mode': ['review', 'live']
                  }
                },
                mark: 'metric',
                encoding: {
                  value: {
                    field: 'aic',
                    type: 'quantitative',
                    aggregate: 'sum'
                  }
                }
              },
              {
                id: 'findings-table',
                title: 'Findings Table',
                data: {
                  source: 'findings',
                  scope: {
                    repositories: ['gh-aw-cao']
                  },
                  time: {
                    start: '2026-08-29T00:00:00Z',
                    end: '2026-08-30T00:00:00Z'
                  }
                },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'finding-summary' },
                    { field: 'finding-severity' },
                    { field: 'finding-status' }
                  ],
                  href: {
                    field: 'pull-request-link'
                  }
                }
              },
              {
                id: 'daily-runs',
                title: 'Daily Runs',
                data: {
                  source: 'runs'
                },
                mark: 'chart',
                encoding: {
                  x: {
                    field: 'started-at',
                    type: 'temporal',
                    'time-unit': 'day'
                  },
                  y: {
                    field: 'run',
                    type: 'quantitative',
                    aggregate: 'count'
                  },
                  color: {
                    field: 'run-conclusion',
                    type: 'nominal'
                  },
                  href: {
                    field: 'run-link'
                  }
                }
              },
              {
                id: 'empty-usage',
                title: 'Empty Usage',
                data: {
                  source: 'empty-usage'
                },
                mark: 'metric',
                encoding: {
                  value: {
                    field: 'aic',
                    type: 'quantitative',
                    aggregate: 'sum'
                  }
                }
              },
              {
                id: 'missing-source',
                title: 'Missing Source',
                data: {
                  source: 'missing-source'
                },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'finding-summary' }
                  ]
                }
              },
              {
                id: 'missing-element-source',
                title: 'Missing Element Source',
                mark: 'element',
                element: 'control-plane-status'
              }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'live', aic: 2, 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1002', engine: 'actions', 'requested-model': 'gpt-4o', 'resolved-model': 'gpt-4.1', 'rollout-mode': 'review', aic: 3, 'observed-at': '2026-08-29T11:00:00Z' }
          ],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        findings: {
          source: 'findings',
          rows: [
            {
              finding: 'finding-1',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-29T12:00:00Z',
              'finding-summary': 'Unsafe dependency',
              'finding-severity': 'high',
              'finding-status': 'open',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/1',
                label: 'PR 1'
              }
            },
            {
              finding: 'finding-2',
              organization: 'github',
              repository: 'other-repo',
              'observed-at': '2026-08-29T13:00:00Z',
              'finding-summary': 'Out of scope finding',
              'finding-severity': 'medium',
              'finding-status': 'resolved',
              'pull-request-link': {
                relation: 'pull-request',
                href: 'https://example.com/pull/2',
                label: 'PR 2'
              }
            },
            {
              finding: 'finding-3',
              organization: 'github',
              repository: 'gh-aw-cao',
              'observed-at': '2026-08-30T01:00:00Z',
              'finding-summary': 'Out of range finding',
              'finding-severity': 'low',
              'finding-status': 'open'
            }
          ],
          metadata: {
            'source-id': 'findings-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'partial',
            freshness: 'stale',
            availability: 'available'
          }
        },
        runs: {
          source: 'runs',
          rows: [
            {
              run: '1001',
              'started-at': '2026-08-29T10:00:00Z',
              'run-conclusion': 'success',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1001', label: 'Run 1001' }
            },
            {
              run: '1002',
              'started-at': '2026-08-29T11:00:00Z',
              'run-conclusion': 'failure',
              'run-link': { relation: 'run', href: 'https://github.com/github/central-agentic-ops/actions/runs/1002', label: 'Run 1002' }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        'empty-usage': {
          source: 'empty-usage',
          rows: [],
          metadata: {
            'source-id': 'empty-usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'unknown',
            freshness: 'unknown',
            availability: 'empty'
          }
        }
      }
    });

    expect(rendered.querySelector('#page-title')?.textContent).toBe('Custom Views');

    const metricSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Total AI Credits'));
    expect(metricSection?.querySelector('[data-metric-value="aic"]')?.textContent).toBe('5');
    expect(metricSection?.textContent).not.toContain('Source: usage');
    expect(metricSection?.textContent).not.toContain('Filters:');

    const tableSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Findings Table'));
    const tableRows = tableSection ? tableSection.querySelectorAll('.custom-table tbody tr') : null;
    expect(tableRows).toHaveLength(1);
    const linkedCell = tableRows?.[0]?.querySelector('a');
    expect(linkedCell?.textContent).toBe('Unsafe dependency');
    expect(linkedCell?.getAttribute('aria-label')).toBe('PR 1');
    expect(tableSection?.textContent).not.toContain('Scope:');
    expect(tableSection?.textContent).not.toContain('Time:');
    expect(tableSection?.textContent).not.toContain('Out of scope finding');
    expect(tableSection?.textContent).not.toContain('Out of range finding');

    const chartSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Daily Runs'));
    const chartLegendLabels = chartSection ? [...chartSection.querySelectorAll('[data-chart-legend="visual"] li span')] : [];
    expect(chartSection?.querySelector('.chart-default')).toBeNull();
    expect(chartSection?.querySelector('[data-chart-legend="text"]')).toBeNull();
    expect(chartSection?.querySelectorAll('[data-chart-legend="visual"] li')).toHaveLength(2);
    expect(chartLegendLabels.map((item) => item.textContent)).toEqual(['failure', 'success']);
    expect(chartSection?.querySelector('.table-region')).toBeNull();
    expect(chartSection?.querySelectorAll('.view-source')).toHaveLength(0);

    const emptySection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Empty Usage'));
    const emptyCard = emptySection?.querySelector('.view-state-card[data-view-state="empty"]');
    expect(emptyCard?.getAttribute('role')).toBe('status');
    expect(emptyCard?.querySelector('.octicon-info')).not.toBeNull();
    expect(emptySection?.querySelector('[data-view-availability="empty"]')?.textContent).toBe('No observations matched the effective context.');
    expect(emptySection?.textContent).toContain('Affected source: empty-usage');

    const unavailableSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Source'));
    const unavailableCard = unavailableSection?.querySelector('.view-state-card[data-view-state="unavailable"]');
    expect(unavailableCard?.getAttribute('role')).toBe('alert');
    expect(unavailableCard?.querySelector('.octicon-alert')).not.toBeNull();
    expect(unavailableSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view cannot be shown because its data source is unavailable.');
    expect(unavailableSection?.textContent).toContain('Source unavailable: missing-source');

    const missingElementSourceSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Element Source'));
    expect(missingElementSourceSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view cannot be shown because its data source is unavailable.');
    expect(missingElementSourceSection?.textContent).toContain('No sources declared for element view.');
  });

  it('DLS-SAFE-007 DLS-SAFE-008 enables keyboard navigation across labeled page sections without relying on color alone', () => {
    /** @type {import('../../src/presenter.js').PresentationInput['document']} */
    const dashboardDocument = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'runs-dashboard',
        title: 'Runs Dashboard',
        pages: [
          {
            id: 'keyboard-navigation',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Keyboard Navigation',
            views: [
              { id: 'runs-source', data: { source: 'runs' } },
              { id: 'outcomes-source', data: { source: 'outcomes' } }
            ]
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document: dashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [
            {
              organization: 'github',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/daily.yml',
              run: '1001',
              'run-status': 'completed',
              'run-conclusion': 'success',
              'rollout-mode': 'live',
              engine: 'actions',
              'requested-model': 'gpt-4o',
              'resolved-model': 'gpt-4.1',
              'started-at': '2026-08-29T10:00:00Z',
              'run-link': {
                relation: 'run',
                href: 'https://example.com/runs/1001',
                label: 'Run 1001'
              }
            }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        outcomes: {
          source: 'outcomes',
          rows: [
            {
              run: '1001',
              'outcome-state': 'accepted'
            }
          ],
          metadata: {
            'source-id': 'outcomes-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    rendered.ownerDocument.body.append(rendered);
    enableDashboardKeyboardNavigation(rendered);

    const sections = rendered.querySelectorAll('[data-page-id="keyboard-navigation"] .page-section');
    expect(sections).toHaveLength(2);
    expect(sections[0]?.getAttribute('aria-labelledby')).toContain('keyboard-navigation-runs-source-heading');
    expect([...sections].map((section) => section.getAttribute('aria-labelledby'))).toEqual([
      'keyboard-navigation-runs-source-heading',
      'keyboard-navigation-outcomes-source-heading'
    ]);

    const firstSection = /** @type {HTMLElement} */ (sections[0]);
    const secondSection = /** @type {HTMLElement} */ (sections[1]);

    firstSection.focus();
    firstSection.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(rendered.ownerDocument.activeElement).toBe(secondSection);

    secondSection.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(rendered.ownerDocument.activeElement).toBe(firstSection);
  });

  it('DLS-VIEW-005 DLS-VIEW-006 renders explicit line and pie widgets in the requested structural layout', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'chart-dashboard',
          title: 'Chart Dashboard',
          pages: [{
            id: 'charts',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'run-trend',
                title: 'Run Trend',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'line',
                layout: 'half',
                encoding: {
                  x: { field: 'started-at', type: 'temporal' },
                  y: { field: 'run-count', type: 'quantitative', aggregate: 'none' }
                }
              },
              {
                id: 'conclusions',
                title: 'Conclusions',
                description: 'Run conclusions grouped across the selected window.',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'pie',
                layout: 'half',
                encoding: {
                  x: { field: 'run-conclusion', type: 'nominal' },
                  y: { field: 'run', type: 'quantitative', aggregate: 'count' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { organization: 'octo-org', repository: 'repo', run: '1', 'run-count': 2, 'started-at': '2026-08-28T00:00:00Z', 'run-conclusion': 'success' },
            { organization: 'octo-org', repository: 'repo', run: '2', 'run-count': 3, 'started-at': '2026-08-29T00:00:00Z', 'run-conclusion': 'failure' }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelectorAll('.custom-view-grid > [data-view-layout="half"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] polyline')?.getAttribute('points')).not.toBe('');
    expect(rendered.querySelectorAll('[data-chart-widget="line"] [role="img"][tabindex="0"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] [role="img"][tabindex="0"]')?.getAttribute('aria-label')).toContain(': 2');
    expect(rendered.querySelectorAll('[data-chart-widget="line"] .point-tooltip')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="line"] .point-tooltip')?.getAttribute('aria-hidden')).toBe('true');
    expect(rendered.querySelectorAll('[data-chart-widget="pie"] [data-chart-category]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="pie"] svg')?.getAttribute('aria-label')).toContain('Pie chart:');
    expect(rendered.querySelector('.chart-view-pie .view-description')?.textContent).toContain('Run conclusions grouped');
    expect(rendered.querySelector('.chart-view-pie .pie-chart-layout')).not.toBeNull();
  });

  it('shows one hash-addressable page at a time and updates active navigation without scrolling', async () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'page-navigation',
          title: 'Page Navigation',
          pages: [
            {
              id: 'first',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'First',
              description: 'First page description',
              views: [{
                id: 'first-details',
                title: 'First details',
                disclosure: 'supplemental',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: { value: { field: 'run', aggregate: 'count' } }
              }]
            },
            { id: 'second', kind: /** @type {'custom'} */ ('custom'), title: 'Second', description: 'Second page description', views: [] }
          ]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [{ run: '1' }],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    rendered.ownerDocument.body.append(rendered);

    const first = /** @type {HTMLElement} */ (rendered.querySelector('#page-first'));
    const second = /** @type {HTMLElement} */ (rendered.querySelector('#page-second'));
    const firstLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-nav-page-id="first"]'));
    const secondLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-nav-page-id="second"]'));
    const firstDetails = /** @type {HTMLDetailsElement} */ (first.querySelector('details'));
    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);
    expect(first.hasAttribute('data-page-pending')).toBe(false);
    expect(second.hasAttribute('data-page-pending')).toBe(true);
    firstDetails.open = true;
    const pageScroller = /** @type {HTMLElement} */ (rendered.querySelector('main.dashboard-prototype'));
    pageScroller.scrollTop = 320;
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-root]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-root]')?.hasAttribute('href')).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.getAttribute('href')).toBe('#page-first');
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(/** @type {HTMLElement} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('#page-title')?.textContent).toBe('First');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('First');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe('First page description');
    expect(rendered.ownerDocument.title).toBe('First · Page Navigation');
    first.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
      bubbles: true,
      detail: {
        title: 'Linked issue',
        titleLink: {
          href: 'https://github.com/octo/repo/issues/42',
          label: '#42'
        }
      }
    }));
    const titleLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('[data-page-title-link]'));
    expect(titleLink.hidden).toBe(false);
    expect(titleLink.textContent).toBe('#42');
    expect(titleLink.getAttribute('href')).toBe('https://github.com/octo/repo/issues/42');
    expect(titleLink.getAttribute('target')).toBe('_blank');
    expect(titleLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rendered.ownerDocument.title).toBe('Linked issue · Page Navigation');

    secondLink.click();

    expect(first.hidden).toBe(true);
    expect(first.hasAttribute('data-page-pending')).toBe(true);
    expect(first.childElementCount).toBe(0);
    expect(rendered.querySelector('#page-second')).toBe(second);
    expect(second.hidden).toBe(false);
    expect(second.hasAttribute('data-page-pending')).toBe(true);
    expect(second.getAttribute('aria-busy')).toBe('true');
    expect(second.querySelector('.dashboard-view-skeleton')).not.toBeNull();
    expect(secondLink.getAttribute('aria-current')).toBe('page');
    expect(rendered.ownerDocument.defaultView?.location.hash).toBe('#page-second');
    expect(rendered.querySelector('#page-title')?.textContent).toBe('Second');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Second');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe('Second page description');
    expect(rendered.ownerDocument.title).toBe('Second · Page Navigation');
    expect(titleLink.hidden).toBe(true);
    expect(titleLink.hasAttribute('href')).toBe(false);
    expect(rendered.ownerDocument.activeElement).toBe(rendered.querySelector('#page-title'));
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-second')).not.toBe(second);
    });
    const renderedSecond = /** @type {HTMLElement} */ (rendered.querySelector('#page-second'));
    expect(renderedSecond.hidden).toBe(false);
    expect(renderedSecond.hasAttribute('data-page-pending')).toBe(false);
    expect(renderedSecond.hasAttribute('aria-busy')).toBe(false);

    pageScroller.scrollTop = 80;
    firstLink.click();

    expect(renderedSecond.hasAttribute('data-page-pending')).toBe(true);
    expect(renderedSecond.childElementCount).toBe(0);
    expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).not.toBeNull();
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).toBeNull();
    });
    const rehydratedFirst = /** @type {HTMLElement} */ (rendered.querySelector('#page-first'));
    expect(/** @type {HTMLDetailsElement | null} */ (rehydratedFirst.querySelector('details'))?.open).toBe(true);
    expect(pageScroller.scrollTop).toBe(320);
    rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  });

  it('replaces a failed asynchronous page render with an accessible error message', async () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a data-nav-page-id="first" href="#page-first">First</a>
      <a data-nav-page-id="second" href="#page-second">Second</a>
      <main class="dashboard-prototype">
        <section class="dashboard-page" id="page-first" data-page-id="first" data-page-pending></section>
        <section class="dashboard-page" id="page-second" data-page-id="second" data-page-pending></section>
      </main>
    `;
    document.body.append(root);
    /** @param {string} pageId */
    const renderPage = (pageId) => {
      if (pageId === 'second') return Promise.reject(new Error('Page rendering failed.'));
      const page = document.createElement('section');
      page.className = 'dashboard-page';
      page.id = `page-${pageId}`;
      page.dataset.pageId = pageId;
      return page;
    };
    try {
      enableDashboardPageNavigation(root, 'Dashboard', renderPage, 'first');
      await vi.waitFor(() => {
        expect(root.querySelector('#page-first')?.hasAttribute('data-page-pending')).toBe(false);
      });

      /** @type {HTMLAnchorElement} */ (root.querySelector('[data-nav-page-id="second"]')).click();

      await vi.waitFor(() => {
        expect(root.querySelector('#page-second .empty')?.textContent).toBe('Unable to load this page.');
      });
      const page = /** @type {HTMLElement} */ (root.querySelector('#page-second'));
      expect(page.getAttribute('aria-busy')).toBeNull();
      expect(page.querySelector('.empty')?.getAttribute('role')).toBe('alert');
    } finally {
      root.remove();
      window.history.replaceState(null, '', '/');
    }
  });

  it('opens coverage diagnostics as an Overview subpage with canonical breadcrumbs', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'coverage-diagnostics': {
          source: 'coverage-diagnostics',
          rows: [
            {
              title: 'Private repository discovery is off',
              effect: 'Private repositories are excluded from workflow inventory and run-health totals.',
              'technical-detail': 'Raw private repository collection detail.'
            },
            {
              kind: 'github-api-rate-limit-403',
              title: 'Durable output collection unavailable',
              effect: 'Durable output evidence is partial because GitHub rate-limited collection.',
              'technical-detail': 'GitHub API rate limit exceeded for /repos/githubnext/gh-aw-cao/actions/runs.',
              endpoint: '/repos/githubnext/gh-aw-cao/actions/runs'
            }
          ],
          metadata: {
            'source-id': 'coverage-diagnostics-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-31T22:00:00Z',
            'retrieved-at': '2026-08-31T22:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    rendered.ownerDocument.body.append(rendered);
    const window = rendered.ownerDocument.defaultView;

    window?.history.replaceState(null, '', '/#page-coverage');
    window?.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('#page-coverage'))?.hidden).toBe(false);
    expect(rendered.querySelector('#page-title')?.textContent).toBe('Coverage diagnostics');
    expect(rendered.querySelector('[data-page-description]')?.textContent).toBe(
      'Drill-down into the canonical Data Health coverage and collection evidence.'
    );
    expect(rendered.querySelector('[data-breadcrumb-root]')?.textContent).toBe('Operational health');
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Coverage diagnostics');
    expect(rendered.querySelector('[data-nav-page-id="operations"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered.querySelectorAll('.org-sidebar [data-nav-page-id="coverage"]')).toHaveLength(0);
    const coveragePage = authoritativeDashboardDocument.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'coverage'
    );
    expect(coveragePage.route).toEqual({ 'navigation-page': 'operations' });
    expect(coveragePage.views[1]).toMatchObject({
      mark: 'table',
      controls: 'static',
      data: { source: 'data-health-coverage' }
    });
    expect(coveragePage.views[2]).toMatchObject({
      mark: 'table',
      controls: 'static',
      disclosure: 'supplemental',
      data: { source: 'data-health-collections' }
    });
    expect(coveragePage.views[2]).not.toHaveProperty('element');
    expect(coveragePage.views[3]).toMatchObject({
      mark: 'table',
      controls: 'static',
      disclosure: 'supplemental',
      data: { source: 'data-health-collections' }
    });
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-coverage')?.hasAttribute('data-page-pending')).toBe(false);
    });
    const essentialRows = rendered.querySelectorAll('#page-coverage [data-disclosure="essential"] .custom-table tbody tr');
    expect(essentialRows.length).toBeGreaterThanOrEqual(9);
    const essentialText = [...rendered.querySelectorAll('#page-coverage [data-disclosure="essential"]')]
      .map((view) => view.textContent).join(' ');
    expect(essentialText).not.toContain('GitHub API rate limit exceeded');
    const supplementalDetails = rendered.querySelectorAll(
      '#page-coverage .view-disclosure[data-disclosure="supplemental"]'
    );
    expect(supplementalDetails).toHaveLength(2);
    expect(/** @type {HTMLDetailsElement} */ (supplementalDetails[0]).open).toBe(false);
    expect(supplementalDetails[0].textContent).toContain(
      'Durable output evidence is partial because GitHub rate-limited collection.'
    );
    expect(supplementalDetails[0].textContent).not.toContain('GitHub API rate limit exceeded');
    expect(/** @type {HTMLDetailsElement} */ (supplementalDetails[1]).open).toBe(false);
    expect(supplementalDetails[1].textContent).toContain('GitHub API rate limit exceeded');

    window?.history.replaceState(null, '', '/');
  });

  it('DLS-SAFE-004 DLS-SAFE-008 DLS-SAFE-009 renders accessible bars, visual chart legends, and rejects unsafe runtime links', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'bar-dashboard',
          title: 'Bar Dashboard',
          pages: [{
            id: 'bars',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'bar-chart',
                data: { source: 'runs' },
                mark: 'chart',
                chart: 'bar',
                encoding: {
                  x: { field: 'run-conclusion', type: 'nominal' },
                  y: { field: 'run', type: 'quantitative', aggregate: 'count' },
                  color: { field: 'run-conclusion', type: 'nominal' }
                }
              },
              {
                id: 'unsafe-link',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-conclusion': 'success', 'run-link': { href: 'javascript:alert(1)', label: 'Unsafe' } },
            { run: '2', 'run-conclusion': 'failure', 'run-link': { href: 'https://example.com/runs/2', label: 'Run 2' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelectorAll('[data-chart-widget="bar"] rect[role="img"]')).toHaveLength(2);
    expect(rendered.querySelector('[data-chart-widget="bar"] rect')?.getAttribute('aria-label')).toContain('failure');
    expect(rendered.querySelector('[data-chart-legend="visual"]')?.getAttribute('class')).toContain('chart-legend-bar');
    expect([...rendered.querySelectorAll('[data-chart-legend="visual"] li span')].map((item) => item.textContent)).toEqual(['failure', 'success']);
    expect(rendered.querySelectorAll('.custom-table a')).toHaveLength(1);
    expect(rendered.querySelector('.custom-table a')?.textContent).toBe('2');
  });

  it('DLS-SAFE-004 rejects runtime links with embedded credentials, ftp schemes, and blank labels while preserving safe links', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'credential-link-dashboard',
          title: 'Credential Link Dashboard',
          pages: [{
            id: 'credential-links',
            kind: /** @type {'custom'} */ ('custom'),
            views: [
              {
                id: 'credential-links-table',
                title: 'Credential Links Table',
                data: { source: 'runs' },
                mark: 'table',
                encoding: {
                  columns: [{ field: 'run' }],
                  href: { field: 'run-link' }
                }
              },
              {
                id: 'credential-links-metric',
                title: 'Credential Links Metric',
                data: { source: 'runs' },
                mark: 'metric',
                encoding: {
                  value: { field: 'run', type: 'nominal', aggregate: 'count' },
                  href: { field: 'run-link' }
                }
              }
            ]
          }]
        }
      },
      sources: {
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'run-link': { href: 'https://user:secret@example.com/runs/1', label: 'Credentialed Run' } },
            { run: '2', 'run-link': { href: 'ftp://example.com/runs/2', label: 'FTP Run' } },
            { run: '3', 'run-link': { href: 'https://example.com/runs/3', label: '   ' } },
            { run: '4', 'run-link': { href: 'https://example.com/runs/4', label: 'Run 4' } }
          ],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const safeLinks = rendered.querySelectorAll('.custom-table a, .metric-link a');
    expect(safeLinks).toHaveLength(2);
    expect([...safeLinks].map((link) => link.textContent)).toEqual(['4', 'Run 4']);
    expect([...safeLinks].every((link) => !String(link.getAttribute('href')).includes('user:secret@'))).toBe(true);
    expect([...safeLinks].every((link) => String(link.getAttribute('href')).startsWith('https://example.com/runs/4'))).toBe(true);
    expect(rendered.textContent).not.toContain('Credentialed Run');
    expect(rendered.textContent).not.toContain('FTP Run');
    expect(rendered.textContent).toContain('Run 4');
  });

  it('DLS-AGG-008 DLS-VIEW-003 renders report-style aggregate rankings in declared order before applying limit', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'ranked-usage',
          title: 'Ranked usage',
          pages: [{
            id: 'usage',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Usage',
            views: [{
              id: 'repository-usage',
              title: 'Repository usage',
              data: {
                source: 'usage',
                'order-by': [{ field: 'total-aic', direction: 'desc' }],
                limit: 2
              },
              mark: 'table',
              encoding: {
                columns: [
                  { field: 'repository', type: 'nominal' },
                  { field: 'aic', type: 'quantitative', aggregate: 'sum', as: 'total-aic', title: 'Total AIC' }
                ]
              }
            }]
          }]
        }
      },
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { repository: 'charlie', aic: 2 },
            { repository: 'alpha', aic: 4 },
            { repository: 'bravo', aic: 3 },
            { repository: 'charlie', aic: 4 },
            { repository: 'alpha', aic: 1 }
          ],
          metadata: {
            'source-id': 'aic-usage',
            'source-kind': 'report-artifact',
            'as-of': '2026-08-30T12:00:00Z',
            'retrieved-at': '2026-08-30T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const rows = [...rendered.querySelectorAll('.custom-table tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.textContent)).toEqual(['charlie6', 'alpha5']);
    const filter = /** @type {HTMLInputElement} */ (rendered.querySelector('.table-filter input'));
    expect(filter).toBeTruthy();
    expect(filter.closest('label')?.textContent).toContain('Filter Repository usage');
    filter.value = 'alpha';
    filter.dispatchEvent(new Event('input'));
    expect(rows.map((row) => row.hasAttribute('hidden'))).toEqual([true, false]);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 result');
    expect(rendered.querySelector('.freshness')).toBeNull();
  });

  it('renders report-style semantic badges through the generic table presenter', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'workflow-status',
          title: 'Workflow status',
          pages: [{
            id: 'workflows',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Workflows',
            views: [{
              id: 'workflow-statuses',
              title: 'Workflow statuses',
              data: { source: 'workflows' },
              mark: 'table',
              encoding: {
                columns: [
                  { field: 'workflow', type: 'nominal' },
                  { field: 'workflow-active', type: 'nominal', display: 'active-state' },
                  { field: 'rollout-mode', type: 'nominal', display: 'mode' },
                  { field: 'run-conclusion', type: 'nominal', display: 'status' }
                ]
              }
            }]
          }]
        }
      },
      sources: {
        workflows: {
          source: 'workflows',
          rows: [{
            workflow: 'review',
            'workflow-active': 'true',
            'rollout-mode': 'review',
            'run-conclusion': 'failure'
          }],
          metadata: {
            'source-id': 'deployed-workflows',
            'source-kind': 'report-artifact',
            'as-of': '2026-08-30T12:00:00Z',
            'retrieved-at': '2026-08-30T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.querySelector('.custom-table .status-success')?.textContent).toBe('true');
    expect(rendered.querySelector('.custom-table .mode-review')?.textContent).toBe('review');
    expect(rendered.querySelector('.custom-table .status-danger')?.textContent).toBe('failure');
  });

  it('routes and reallocates a JSON-selected repository workflow view from a hash query argument', () => {
    window.history.replaceState(null, '', '/#page-repository-detail?repository=octo-org%2Focto-repo');
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'repository-detail-dashboard',
          title: 'Repository detail',
          pages: [
            {
              id: 'repository-detail',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Repository',
              route: { 'hash-query-parameter': 'repository' },
              views: [{
                id: 'repository-workflows',
                title: 'Agentic workflows',
                data: {
                  source: 'repository-workflows',
                  'route-field': 'repository'
                },
                mark: 'table',
                controls: 'static',
                encoding: {
                  columns: [
                    { field: 'workflow-name', type: 'nominal', title: 'Workflow' },
                    { field: 'workflow-active', type: 'nominal', title: 'State', display: 'active-state' }
                  ],
                  href: { field: 'workflow-link', type: 'nominal' }
                }
              }]
            },
            {
              id: 'workflow-runtime',
              kind: /** @type {'custom'} */ ('custom'),
              title: 'Workflow runtime',
              route: { 'hash-query-parameter': 'workflow' },
              views: []
            }
          ]
        }
      },
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'octo-org', repository: 'octo-repo', workflow: '.github/workflows/review.md', 'workflow-name': 'Review', 'workflow-role': 'standalone', 'workflow-active': 'true', 'observed-at': '2026-08-29T10:00:00Z' },
            { organization: 'other-org', repository: 'other-repo', workflow: '.github/workflows/other.md', 'workflow-name': 'Other', 'workflow-role': 'standalone', 'workflow-active': 'true', 'observed-at': '2026-08-29T10:00:00Z' }
          ],
          metadata: {
            'source-id': 'workflows-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-29T20:00:00Z',
            'retrieved-at': '2026-08-29T20:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });
    document.body.append(rendered);

    const repositoryView = rendered.querySelector('[data-route-view]');
    expect(repositoryView?.textContent).toContain('Review');
    expect(repositoryView?.textContent).not.toContain('Other');
    expect(rendered.querySelector('#page-title')?.textContent).toBe('octo-org/octo-repo');
    expect(rendered.ownerDocument.title).toBe('octo-org/octo-repo · Repository detail');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('octo-org/octo-repo');
    expect(repositoryView?.querySelector('tbody a')?.getAttribute('href')).toBe('#page-workflow-runtime?workflow=octo-org%2Focto-repo%3A.github%2Fworkflows%2Freview.md');
    expect(repositoryView?.querySelector('tbody a')?.getAttribute('target')).toBeNull();

    window.history.replaceState(null, '', '/#page-repository-detail?repository=other-org%2Fother-repo');
    window.dispatchEvent(new Event('hashchange'));

    expect(repositoryView?.textContent).toContain('Other');
    expect(repositoryView?.textContent).not.toContain('Review');
    expect(rendered.querySelector('#page-title')?.textContent).toBe('other-org/other-repo');
    expect(rendered.ownerDocument.title).toBe('other-org/other-repo · Repository detail');
    expect(document.activeElement).toBe(rendered.querySelector('#page-title'));
    rendered.remove();
    window.history.replaceState(null, '', '/');
  });
});
