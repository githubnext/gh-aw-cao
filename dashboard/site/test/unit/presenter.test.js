// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderDashboard, enableDashboardKeyboardNavigation } from '../../src/presenter.js';
import { composeDashboardDocuments } from '../../../report/compose-dashboard-documents.mjs';
import { packageDashboardSources } from '../package-dashboard-documents.js';

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

describe('presenter built-in and custom pages', () => {
  it('renders distinct firewall enforcement, evidence, traffic, and drift scenarios', async () => {
    const metadata = /** @type {const} */ ({
      'source-id': 'firewall-fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-05T11:00:00Z',
      'retrieved-at': '2026-09-05T11:05:00Z',
      completeness: 'partial',
      freshness: 'fresh',
      availability: 'available'
    });
    const base = {
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/security.md',
      'rollout-mode': 'review',
      'run-conclusion': 'success',
      protocol: 'https',
      port: 443,
      'request-count': 1,
      'policy-rule-id': 'unavailable',
      'observed-at': '2026-09-05T11:00:00Z',
      'evidence-completeness': 'complete',
      'evidence-freshness': 'fresh'
    };
    const rows = [
      { ...base, run: '1', 'firewall-observation': '1', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'no-traffic', 'evidence-label': 'No observed traffic', domain: 'unknown', decision: 'unknown', 'decision-label': 'Unknown', 'drift-state': 'stable', 'drift-label': 'Stable', 'review-state': 'stable', 'review-label': 'Stable', 'review-priority': 9, 'request-count': null },
      { ...base, run: '2', 'firewall-observation': '2', 'firewall-enabled': 'disabled', 'enforcement-label': 'Enforcement disabled', 'evidence-state': 'disabled', 'evidence-label': 'Enforcement disabled', domain: 'unknown', decision: 'unknown', 'decision-label': 'Unknown', 'drift-state': 'unknown', 'drift-label': 'Unknown', 'review-state': 'enforcement-disabled', 'review-label': 'Enforcement disabled', 'review-priority': 1, 'request-count': null },
      { ...base, run: '3', 'firewall-observation': '3', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'unavailable', 'evidence-label': 'Evidence missing', 'evidence-completeness': 'unknown', domain: 'unknown', decision: 'unknown', 'decision-label': 'Unknown', 'drift-state': 'unknown', 'drift-label': 'Unknown', 'review-state': 'evidence-missing', 'review-label': 'Evidence missing', 'review-priority': 2, 'request-count': null },
      { ...base, run: '4', 'firewall-observation': '4', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'available', 'evidence-label': 'Evidence available', domain: 'api.github.com', decision: 'allowed', 'decision-label': 'Allowed by policy', 'drift-state': 'stable', 'drift-label': 'Stable', 'review-state': 'stable', 'review-label': 'Stable', 'review-priority': 9 },
      { ...base, run: '5', 'firewall-observation': '5', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'available', 'evidence-label': 'Evidence available', domain: 'new.example', decision: 'allowed', 'decision-label': 'Allowed by policy', 'current-decision': 'allowed', 'drift-state': 'newly-allowed', 'drift-label': 'Newly allowed', 'review-state': 'newly-allowed', 'review-label': 'Newly allowed', 'review-priority': 3 },
      { ...base, run: '6', 'firewall-observation': '6', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'available', 'evidence-label': 'Evidence available', domain: 'blocked.example', decision: 'denied', 'decision-label': 'Denied by policy', 'current-decision': 'denied', 'drift-state': 'stable', 'drift-label': 'Stable', 'review-state': 'stable', 'review-label': 'Stable', 'review-priority': 9, 'policy-rule-id': 'default-deny' },
      { ...base, run: '7', 'firewall-observation': '7', 'firewall-enabled': 'enabled', 'enforcement-label': 'Enabled', 'evidence-state': 'available', 'evidence-label': 'Evidence available', domain: 'changed.example', decision: 'denied', 'decision-label': 'Denied by policy', 'previous-decision': 'allowed', 'current-decision': 'denied', 'drift-state': 'decision-changed', 'drift-label': 'Decision changed', 'review-state': 'decision-changed', 'review-label': 'Decision changed', 'review-priority': 4 }
    ];
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'firewall-observations': { source: 'firewall-observations', rows, metadata },
        'firewall-policy-rules': { source: 'firewall-policy-rules', rows: [], metadata }
      }
    });

    const page = await activatePage(rendered, 'firewall');
    expect(page?.querySelector('[data-chart-widget="pie"]')).not.toBeNull();
    const text = page?.textContent ?? '';
    expect(text).toContain('Enforcement disabled');
    expect(text).toContain('Evidence missing');
    expect(text).toContain('Newly allowed');
    expect(text).toContain('Decision changed');
    expect(text).toContain('Allowed');
    expect(text).toContain('Denied');
    expect(text).not.toContain('firewall failure');
    rendered.remove();
  });

  it('renders cached source health without mixing in presentation-only sources', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [{ run: '1', 'run-conclusion': 'success' }],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-03T12:00:00Z',
            'retrieved-at': '2026-09-03T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        },
        usage: {
          source: 'usage',
          rows: [],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-03T12:00:00Z',
            'retrieved-at': '2026-09-03T12:01:00Z',
            completeness: 'unknown',
            freshness: 'unknown',
            availability: 'unavailable'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'data-health');
    const sourceView = [...(page?.querySelectorAll('.custom-view') ?? [])]
      .find((view) => view.querySelector('h4')?.textContent === 'Cached source shape');
    expect(page?.querySelector('[data-chart-widget="pie"]')).not.toBeNull();
    expect(sourceView?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(sourceView?.querySelector('tbody')?.textContent).toContain('runs');
    expect(sourceView?.querySelector('tbody')?.textContent).toContain('usage');
    expect(sourceView?.querySelector('tbody')?.textContent).toContain('unavailable');
    expect(sourceView?.querySelector('tbody')?.textContent).not.toContain('overview');
    rendered.remove();
  });

  it('renders data-health diagnostics when a cached source is unavailable', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        runs: {
          source: 'runs',
          rows: [],
          metadata: {
            'source-id': 'runs-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-03T12:00:00Z',
            'retrieved-at': '2026-09-03T12:01:00Z',
            completeness: 'unknown',
            freshness: 'unknown',
            availability: 'unavailable'
          }
        },
        usage: {
          source: 'usage',
          rows: [{ run: '1', aic: 3 }],
          metadata: {
            'source-id': 'usage-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-09-03T12:00:00Z',
            'retrieved-at': '2026-09-03T12:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    const page = await activatePage(rendered, 'data-health');
    expect(page?.querySelector('[data-chart-widget="pie"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-availability="unavailable"]')).toBeNull();
    expect(page?.textContent).toContain('Sources needing attention');
    expect(page?.textContent).toContain('runs');
    expect(page?.textContent).toContain('unavailable');
    rendered.remove();
  });

  it('renders built-in models and agents page with model and single-engine AIC summaries', () => {
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
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'models-agents-dashboard',
          title: 'Models Agents Dashboard',
          pages: [{
            id: 'engines-models',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'engines-models',
            title: 'Models & agents'
          }]
        }
      },
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
        usage: {
          source: 'usage',
          rows: [
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.yml', run: '1001', invocation: 'a', engine: 'copilot', 'engine-version': '0.87.6', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', aic: 10 },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/review.yml', run: '1002', invocation: 'b', engine: 'copilot', 'engine-version': '0.87.9', 'requested-model': 'gpt-5.6-sol', 'resolved-model': 'gpt-5.6-sol', aic: 15 },
            { organization: 'github', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.yml', run: '1003', invocation: 'c', engine: 'copilot', 'engine-version': '1.2.0', 'requested-model': 'claude-sonnet-5', 'resolved-model': 'claude-sonnet-5', aic: 5 }
          ],
          metadata
        },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = rendered.querySelector('[data-page-name="engines-models"]');
    expect(page?.textContent).toContain('AI Credit usage by model');
    expect(page?.textContent).toContain('Models, pricing, and totals');
    expect(page?.textContent).toContain('1 AIC = $0.01 USD');
    expect(page?.textContent).toContain('Total AIC');
    expect(page?.textContent).toContain('25');
    expect(page?.textContent).toContain('copilot');
    expect(page?.textContent).toContain('0.87.6');
    expect(page?.textContent).toContain('0.87.9');
    expect(page?.querySelectorAll('.chart-view-pie')).toHaveLength(2);
    expect(page?.querySelectorAll('.layout-section .pie-chart-card')).toHaveLength(2);
    const allocationSection = page?.querySelector('[data-section-id="model-agent-allocation"]');
    expect([...page?.querySelectorAll('.layout-section') ?? []].map((section) => section.getAttribute('data-section-id'))).toEqual([
      'model-agent-allocation',
      'model-allocation',
      'agentic-engine-allocation',
      'model-agent-run-aggregates'
    ]);
    expect(allocationSection?.querySelectorAll('.chart-view-pie')).toHaveLength(2);
    const engineChart = [...allocationSection?.querySelectorAll('.chart-view-pie') ?? []]
      .find((view) => view.querySelector('h4')?.textContent === 'AI Credit usage by agentic engine');
    expect(engineChart?.querySelector('[role="status"]')).toBeNull();
    expect(engineChart?.querySelector('[data-chart-category="copilot"]')).not.toBeNull();
    expect(allocationSection?.querySelector('.custom-table')).toBeNull();
    const runAggregates = page?.querySelector('[data-section-id="model-agent-run-aggregates"]');
    const disclosure = runAggregates?.querySelector('.view-disclosure');
    expect(disclosure?.hasAttribute('open')).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toContain('Runs by agent and model');
    disclosure?.setAttribute('open', '');
    expect(disclosure?.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(disclosure?.querySelector('tbody a')?.getAttribute('href')).toBe('#page-runs');
  });

  it('explains when model and agentic engine distribution data is missing', () => {
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
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'models-agents-dashboard',
          title: 'Models Agents Dashboard',
          pages: [{
            id: 'engines-models',
            kind: /** @type {'built-in'} */ ('built-in'),
            page: 'engines-models',
            title: 'Models & agents'
          }]
        }
      },
      sources: {
        runs: { source: 'runs', rows: [], metadata },
        usage: { source: 'usage', rows: [], metadata },
        outcomes: { source: 'outcomes', rows: [], metadata }
      }
    });

    const page = rendered.querySelector('[data-page-name="engines-models"]');
    expect(page?.textContent).toContain('No model usage data is available.');
    expect(page?.textContent).toContain('No agentic engine usage data is available.');
    rendered.remove();
  });

  it('renders JSON-declared package and standalone workflow inventory with a topology summary', () => {
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
      sources: {
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
      }
    });

    const page = rendered.querySelector('[data-page-name="workflows"]');
    expect(globalThis.document.title).toBe('Workflows · Workflow Topology');
    expect(page?.querySelector('.summary-grid')?.textContent).toBe('Packages1Package workflows2Standalone workflows1');
    expect(page?.getAttribute('data-page-description')).toContain('does not assert that a dispatch occurred');
    expect(page?.querySelector('.view-metadata-summary')).toBeNull();
    expect(rendered.querySelector('.dashboard-horizon [aria-label="Data status"]')?.textContent).toBe('CompletenesscompleteFreshnessfresh');
    expect(page?.querySelector('#workflows-operation-package-workflows-heading')?.parentElement?.parentElement?.textContent).toContain('dependabot.yml');
    expect(page?.querySelector('#workflows-operation-package-workflows-heading')?.parentElement?.parentElement?.textContent).toContain('release-train-updater.yml');
    expect(page?.querySelector('#workflows-repository-owned-workflows-heading')?.parentElement?.parentElement?.textContent).toContain('ci.yml');
    expect(page?.querySelector('#workflows-workflow-aic-layout-heading')?.textContent).toBe('AIC');
    expect(page?.querySelector('[data-chart-widget="pie"]')).not.toBeNull();
    const packagedRows = [...(page?.querySelector('#workflows-operation-package-workflows-heading')?.parentElement?.parentElement?.querySelectorAll('tbody tr') ?? [])];
    const standaloneRows = [...(page?.querySelector('#workflows-repository-owned-workflows-heading')?.parentElement?.parentElement?.querySelectorAll('tbody tr') ?? [])];
    expect(packagedRows.find((row) => row.textContent?.includes('dependabot.yml'))?.lastElementChild?.textContent).toBe('30');
    expect(standaloneRows.find((row) => row.textContent?.includes('ci.yml'))?.lastElementChild?.textContent).toBe('5');
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
      sources: {
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
      }
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
    expect(rendered.querySelector('.repository-link')).toBeNull();
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
    const repositoryLink = rendered.querySelector('.repository-link');
    expect(repositoryLink).not.toBeNull();
    expect(repositoryLink?.getAttribute('href')).toBe('https://github.example.com/octo-org/agentic-operations');
    expect(repositoryLink?.getAttribute('aria-label')).toBe('View octo-org/agentic-operations on GitHub');
    expect(repositoryLink?.getAttribute('title')).toBe('View octo-org/agentic-operations on GitHub');
    expect(rendered.querySelector('.sidebar-brand > span')?.textContent).toBe('agentic-operations');
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

  it('renders section-labeled operational navigation groups in the sidebar', () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });

    const labels = [...rendered.querySelectorAll('.nav-section-label')].map((node) => node.textContent?.trim());
    const sections = [...rendered.querySelectorAll('.nav-section')];
    const controlPlaneNavigation = authoritativeDashboardDocument.dashboard.navigation?.find(
      /** @param {{ label?: string }} section */
      (section) => section.label === 'Control plane'
    );
    expect(labels).toEqual(['Attention', 'Dashboard Next', 'Investigate', 'Insights', 'Control plane', 'Explore', 'Package operations']);
    expect(sections.map((section) => /** @type {HTMLDetailsElement} */ (section).open)).toEqual([true, false, true, true, false, false, false]);
    expect(rendered.querySelector('[data-nav-page-id="overview"]')?.closest('.nav-section')?.textContent).toContain('Attention');
    expect(rendered.querySelector('[data-nav-page-id="runtime"]')?.closest('.nav-section')?.textContent).toContain('Investigate');
    expect(rendered.querySelector('[data-nav-page-id="preview"]')?.closest('.nav-section')?.textContent).toContain('Control plane');
    expect(rendered.querySelector('[data-nav-page-id="readiness"]')?.closest('.nav-section')?.textContent).toContain('Control plane');
    expect(controlPlaneNavigation?.pages).toEqual(expect.arrayContaining(['github-api']));
    expect([...rendered.querySelectorAll('.nav-label')].map((node) => node.textContent)).toEqual([
      'Overview',
      'Home',
      'Work',
      'Agents',
      'Evidence',
      'Insights',
      'Runtime',
      'Performance',
      'Security',
      'Experiments',
      'Value',
      'Cost',
      'Configuration',
      'Admission',
      'Preview',
      'Readiness',
      'Data health',
      'GitHub API',
      'Updates',
      'Safe Outputs',
      'Detection',
      'Dispatches',
      'Firewall',
      'MCPs',
      'Workflows',
      'Repositories',
      'Packages',
      'Models & agents',
      'UK AI advisory',
      'AW Doctor',
      'Dependabot',
      'EU CRA',
      'AW Optimization'
    ]);
    expect(rendered.querySelector('[data-nav-page-id="runs"]')).toBeNull();
    expect(rendered.querySelector('[data-nav-page-id="findings"]')).toBeNull();
    expect(rendered.querySelector('[data-page-id="overview"]')?.classList.contains('overview-page')).toBe(true);
    expect(rendered.querySelector('[data-page-id="organizations"]')?.classList.contains('organizations-page')).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Overview');

    /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="cost"]'))?.click();

    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Cost & efficiency');
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
    const attentionSection = sections.find((section) => section.querySelector('summary')?.textContent?.trim() === 'Attention');
    const investigateSection = sections.find((section) => section.querySelector('summary')?.textContent?.trim() === 'Investigate');
    expect(/** @type {HTMLDetailsElement | undefined} */ (attentionSection)?.open).toBe(true);
    expect(/** @type {HTMLDetailsElement | undefined} */ (investigateSection)?.open).toBe(true);
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
    localStorage.clear();
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
            icon: 'megaphone'
          },
          {
            id: 'rate-limit-message',
            title: 'Dashboard data is partial',
            description: 'Some data could not be downloaded.',
            icon: 'alert',
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
    const dismiss = /** @type {HTMLButtonElement | null} */ (
      rendered.querySelector('[data-site-callout="operator-message"] .site-callout-dismiss')
    );
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss Operator message');
    dismiss?.click();
    expect(rendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);

    const rerendered = renderDashboard({ document, sources });
    expect(rerendered.querySelector('[data-site-callout="operator-message"]')).toBeNull();
    expect(rerendered.querySelector('[data-site-callout="rate-limit-message"]')).not.toBeNull();

    const complete = renderDashboard({ document, sources: {} });
    expect(complete.querySelector('[data-site-callout="rate-limit-message"]')).toBeNull();
  });

  it('collapses the sidebar to icons and restores the persisted display mode', () => {
    localStorage.clear();
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
      expect(overviewLink?.getAttribute('title')).toBe('Overview');

      toggle?.click();

      expect(shell?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(toggle?.getAttribute('aria-label')).toBe('Expand navigation');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.querySelector('.octicon-sidebar-expand')).not.toBeNull();
      expect(localStorage.getItem('central-agentic-ops.dashboard.sidebar-collapsed')).toBe('true');

      const restored = renderDashboard({
        document: authoritativeDashboardDocument,
        sources: {}
      });
      expect(restored.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(true);
      expect(restored.querySelector('.sidebar-toggle')?.getAttribute('aria-label')).toBe('Expand navigation');
    } finally {
      localStorage.clear();
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
    expect(menuLinks.every((link) => link.querySelector('.octicon') !== null)).toBe(true);
    expect(menuLinks.map((link) => link.textContent?.trim())).toEqual([
      'Overview',
      'Home',
      'Work',
      'Agents',
      'Evidence',
      'Insights',
      'Runtime',
      'Performance',
      'Security',
      'Experiments',
      'Value',
      'Cost',
      'Configuration',
      'Admission',
      'Preview',
      'Readiness',
      'Data health',
      'GitHub API',
      'Updates',
      'Safe Outputs',
      'Detection',
      'Dispatches',
      'Firewall',
      'MCPs',
      'Workflows',
      'Repositories',
      'Packages',
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
    window.history.replaceState(null, '', '/');
  });

  it('renders filter bars for the Runtime, Security, and Value pages', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {}
    });

    expect(authoritativeDashboardDocument.dashboard.defaults?.time).toEqual({ range: '1w' });
    expect(rendered.querySelector('.dashboard-horizon')?.getAttribute('aria-label')).toBe('Horizon unavailable');
    expect(rendered.querySelector('.dashboard-horizon')?.classList.contains('dashboard-horizon-skeleton')).toBe(true);
    expect(rendered.querySelectorAll('.dashboard-horizon')).toHaveLength(1);
    expect(rendered.querySelector('.freshness')?.getAttribute('aria-label')).toBe('Last updated date unavailable');
    expect(rendered.querySelector('.freshness')?.classList.contains('freshness-skeleton')).toBe(true);
    expect(rendered.querySelector('.freshness')?.textContent).toBe('Last updated');
    expect(rendered.querySelector('.freshness')?.hasAttribute('datetime')).toBe(false);
    expect(rendered.querySelector('.freshness > span:last-child')?.textContent).toBe('');
    const horizonHelp = rendered.querySelector('.dashboard-horizon .tooltip-trigger');
    const horizonTooltip = rendered.querySelector('.dashboard-horizon .tooltip-content');
    expect(horizonHelp).toBeNull();
    expect(horizonTooltip).toBeNull();

    for (const pageId of ['runtime', 'security', 'firewall', 'operational-value']) {
      await activatePage(rendered, pageId);
      const filterBar = rendered.querySelector('.report-actions > .filter-bar');
      expect(filterBar?.querySelector('input')?.value).toBe('');
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

  it('renders workflow and job performance charts from declarative sources', async () => {
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
    expect(page?.querySelectorAll('.custom-view-grid > [data-view-layout="half"]')).toHaveLength(3);
    expect(page?.querySelector('[data-chart-widget="histogram"]')).not.toBeNull();
    expect(page?.querySelectorAll('[data-chart-widget="histogram"] .histogram-chart-bar')).toHaveLength(2);
    expect(page?.querySelector('[data-chart-widget="heatmap"]')).not.toBeNull();
    expect(page?.querySelectorAll('[data-chart-widget="bar"]')).toHaveLength(2);
    expect(page?.textContent).toContain('1m 0s');
    expect(page?.textContent).toContain('2m 30s');
    expect(page?.textContent).toContain('gvisor');
    expect(page?.textContent).toContain('gpt-5.4');
  });

  it('applies the JSON horizon against one evaluated time while retaining timeless rows', () => {
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
      }
    });

    const table = rendered.querySelector('.custom-table');
    expect(table?.textContent).toContain('recent');
    expect(table?.textContent).toContain('timeless');
    expect(table?.textContent).not.toContain('expired');
    expect(rendered.querySelector('.dashboard-horizon')?.getAttribute('data-dashboard-evaluated-at')).toBe('2026-09-01T12:00:00.000Z');
    expect(rendered.querySelector('.horizon-toggle')?.textContent).toBe('Data horizon 2 days');
    expect(rendered.querySelector('.dashboard-horizon .tooltip-content')?.textContent).toBe(
      'Data is included from the start up to the exclusive end.StartAug 30, 2026, 12:30 PM UTCEndSep 1, 2026, 12:00 PM UTCDuration2 days'
    );
    expect(rendered.querySelector('.dashboard-horizon .tooltip-content time:first-of-type')?.getAttribute('datetime')).toBe('2026-08-30T12:30:00.000Z');
    expect(rendered.querySelectorAll('.dashboard-horizon .tooltip-content time')[1]?.getAttribute('datetime')).toBe('2026-09-01T12:00:00.000Z');
  });

  it('renders the Security assurance view without a findings summary table', async () => {
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
    expect(dashboardPage.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'operational-assurance',
        'count-source': 'security-signals',
        'count-label': 'signals'
      })
    ]));
    expect(rendered.querySelector('[data-nav-page-id="security"] .octicon-shield')).not.toBeNull();
    expect(page?.querySelector('.layout-section-header > strong')?.textContent).toBe('4 signals');
    expect(page?.querySelector('[data-chart-widget="pie"]')).toBeNull();
    expect(page?.textContent).not.toContain('Security findings summary');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Approval gates2');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Explicit warnings2');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Package integrity gaps1');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Vulnerability findings—');
    expect(page?.textContent).toContain('No vulnerability feed is retained.');
    expect(page?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(page?.querySelector('img')).toBeNull();
  });

  it('renders the custom JSON-composed Value page from shared summary, signal, and table elements', async () => {
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
    expect(rendered.querySelector('[data-nav-page-id="operational-value"] .octicon-beaker')).not.toBeNull();
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Grader coverage4 / 5');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Mature evidence3');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Mean operational value50%');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Open outputs1');
    expect([...(page?.querySelectorAll('.layout-section-header > strong') ?? [])].map((node) => node.textContent)).toEqual([
      '5 signals',
      '2 outputs',
      '2 observations',
      '5 records'
    ]);

    const signals = [...(page?.querySelectorAll('.signal-item') ?? [])];
    expect(signals.map((signal) => signal.querySelector('.signal-copy > span')?.textContent)).toEqual([
      'Grader unavailable',
      'Maturity pending',
      'AIC coverage',
      'Open output',
      'Experiment readiness'
    ]);
    expect(signals[3]?.querySelector('a')?.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao/issues/1');
    expect(signals[4]?.querySelector('a')?.getAttribute('href')).toBe('#page-experiments');

    const tables = page?.querySelectorAll('.custom-table') ?? [];
    expect(tables).toHaveLength(3);
    expect(tables[0]?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(tables[0]?.querySelector('a')?.getAttribute('href')).toBe('#page-outcome-detail?outcome=outcome-1');
    expect(tables[1]?.textContent).toContain('daily-value');
    expect(tables[1]?.textContent).toContain('0.7');
    expect(tables[2]?.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(tables[2]?.querySelector('.status-success')?.textContent).toBe('pass');
    expect(tables[2]?.querySelector('.status-attention')?.textContent).toBe('unavailable');
    expect(tables[2]?.textContent).toContain('Mature');
    expect(tables[2]?.textContent).toContain('Interim');
    expect(tables[2]?.textContent).toContain('—');
    expect(tables[2]?.textContent).toContain('sha256:curre');
    expect(tables[2]?.querySelector('a[aria-label="View run 103"]')?.getAttribute('href')).toContain('/actions/runs/103');
    expect(page?.querySelectorAll('.table-filter')).toHaveLength(2);
    const graderRegion = /** @type {HTMLElement} */ (tables[2]?.closest('.table-region'));
    const graderFilter = /** @type {HTMLInputElement} */ (graderRegion?.querySelector('[data-table-filter]'));
    expect(graderFilter.closest('label')?.textContent).toContain('Filter Collected observations');
    graderFilter.value = 'review-value';
    graderFilter.dispatchEvent(new Event('input'));
    expect([...graderRegion.querySelectorAll('tbody tr')]
      .filter((row) => row instanceof HTMLTableRowElement && !row.hidden)).toHaveLength(1);
    expect(graderRegion.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 result');
    expect(page?.textContent).toContain('not proof that a workflow caused an outcome');
    const experimentBoundary = page?.querySelector('.dashboard-callout');
    expect(experimentBoundary?.querySelector('.scope-kicker')?.textContent).toBe('Evidence boundary');
    expect(experimentBoundary?.querySelector('.octicon-beaker')).not.toBeNull();
    expect(experimentBoundary?.querySelector('h3')?.textContent).toBe('Experiment comparisons unavailable');
    expect(experimentBoundary?.textContent).toContain('Experiment comparisons unavailable');
    expect(experimentBoundary?.textContent).toContain('does not infer control or treatment groups');
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
    expect(supplemental.querySelector(':scope > .page-section')?.textContent).toContain('1');
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
                availability: true,
                completeness: true,
                freshness: true
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
    expect(cards[5]?.textContent).toContain('35 AIC');
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
              'data-state': { availability: true, completeness: true, freshness: true },
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
            'data-state': { availability: true, completeness: true, freshness: true },
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
    expect(packagesPage?.querySelectorAll('.package-utilization-card')).toHaveLength(2);
    expect(packagesPage?.querySelector('[data-package-id="daily-ops"]')?.textContent).toContain('40 of 250 AIC across 2 reported runs');
    expect(packagesPage?.querySelector('[data-package-id="daily-ops"]')?.textContent).toContain('16%');
    expect(packagesPage?.querySelector('[data-package-id="empty-ops"]')?.textContent).toContain('No AIC usage was reported');
    expect(packagesPage?.querySelector('[data-package-id="daily-ops"] .package-utilization-identity a')?.getAttribute('href')).toBe('#page-package-insights?package=daily-ops');
    expect(packagesPage?.querySelector('[data-package-id="daily-ops"] .octicon-workflow')).not.toBeNull();
    expect(packagesPage?.querySelector('.package-summary-heading')?.textContent).toContain('All output by package');
    expect(packagesPage?.querySelector('.package-trend-panel + .package-summary')).not.toBeNull();
    const packageSummaryRows = [...(packagesPage?.querySelectorAll('.package-summary-table tbody tr') ?? [])];
    expect(packageSummaryRows).toHaveLength(2);
    expect(packageSummaryRows[0]?.querySelector('th a')?.getAttribute('href')).toBe('#page-package-insights?package=daily-ops');
    expect(packageSummaryRows[0]?.querySelector('.octicon-workflow')).not.toBeNull();
    expect(packageSummaryRows[1]?.querySelector('.octicon-package')).not.toBeNull();
    expect([...packageSummaryRows[0]?.children ?? []].map((cell) => cell.textContent)).toEqual([
      'Daily Ops', '2', '1', '1', '1', '2', '40', 'Aug 29, 2026, 10:06 AM'
    ]);
    expect([...packageSummaryRows[1]?.children ?? []].map((cell) => cell.textContent)).toEqual([
      'Empty Ops', '0', '0', '0', '0', '0', '0', 'No activity yet'
    ]);
    expect(packagesPage?.querySelector('.package-trend-panel header')?.textContent).toContain('2as of');
    expect(packagesPage?.querySelector('.package-utilization')?.textContent).toContain('Partial usage coverage.');
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
    const alphaCard = packagesPage?.querySelector('[data-package-repository="alpha"]');
    const betaCard = packagesPage?.querySelector('[data-package-repository="beta"]');
    expect(packagesPage?.querySelectorAll('.package-utilization-card')).toHaveLength(2);
    expect(alphaCard?.textContent).toContain('10 of 100 AIC');
    expect(betaCard?.textContent).toContain('20 of 200 AIC');
    expect(betaCard?.textContent).not.toContain('999');
    expect(packagesPage?.querySelector('.package-utilization')?.textContent).toContain('Usage coverage is unknown.');

    const unavailable = renderDashboard({
      document,
      sources: {
        workflows,
        runs: { ...runs, rows: [], metadata: { ...metadata, availability: /** @type {'unavailable'} */ ('unavailable'), completeness: /** @type {'unknown'} */ ('unknown') } },
        usage
      }
    });
    const unavailablePackagesPage = unavailable.querySelector('[data-page-name="packages"]');
    expect(unavailablePackagesPage?.querySelector('.package-trend-chart')).toBeNull();
    expect(unavailablePackagesPage?.querySelector('.package-trend-panel')?.textContent).toContain('Package run data is unavailable.');
  });

  it('DLS-PAGE-001 DLS-PAGE-002 DLS-PAGE-003 DLS-PAGE-004 DLS-PAGE-005 DLS-PAGE-006 DLS-PAGE-007 DLS-PAGE-008 DLS-PAGE-009 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 DLS-PAGE-015 authoritative dashboard.json keeps the remaining built-in pages declarative', () => {
    const pages = authoritativeDashboardDocument.dashboard.pages.filter(
      (/** @type {{ kind: string }} */ page) => page.kind === 'built-in'
    );
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(12);
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
      'engines-models',
      'findings'
    ]);

    for (const page of pages) {
      expect(page.kind).toBe('built-in');
      expect(page.id).toBe(page.page);
      expect(typeof page.icon).toBe('string');
      expect(page.definition?.['data-state']).toEqual({
        availability: true,
        completeness: true,
        freshness: true
      });
      expect(Array.isArray(page.definition?.views)).toBe(true);
      expect(page.definition.views.length).toBeGreaterThan(0);
      expect(page.definition.views.every((/** @type {{ data?: { source?: unknown, sources?: unknown } }} */ view) => (
        typeof view?.data?.source === 'string'
        || (Array.isArray(view?.data?.sources) && view.data.sources.every((source) => typeof source === 'string'))
      ))).toBe(true);
    }

    const runsPage = pages.find((/** @type {{ page: string }} */ page) => page.page === 'runs');
    expect(runsPage?.definition.views.map((/** @type {{ data: { source: string } }} */ view) => view.data.source)).toEqual(['runs', 'runs']);

    const repositoriesPage = pages.find((/** @type {{ page: string }} */ page) => page.page === 'repositories');
    expect(repositoriesPage?.definition.views).toMatchObject([
      {
        id: 'repositories-run-health',
        mark: 'chart',
        chart: 'line',
        data: { source: 'runs' }
      },
      {
        id: 'repository-scope',
        title: 'Repository scope',
        data: { sources: ['repository-summary', 'repositories', 'runs', 'usage', 'operational-values'] },
        mark: 'element',
        element: 'context-summary'
      },
      {
        id: 'repository-discovery-coverage',
        data: { sources: ['repository-coverage'] },
        mark: 'element',
        element: 'summary-grid'
      },
      {
        id: 'repositories-by-aic',
        title: 'AI Credit usage by AW repository',
        description: 'Read-only usage reported by AW runs, deduplicated by workflow run.',
        data: {
          source: 'usage',
          'order-by': [{ field: 'total-aic', direction: 'desc' }]
        },
        mark: 'chart',
        chart: 'pie',
        encoding: {
          x: { field: 'repository', type: 'nominal', title: 'Repository' },
          y: {
            field: 'aic',
            type: 'quantitative',
            aggregate: 'sum',
            as: 'total-aic',
            title: 'Total AIC',
            unit: 'aic'
          },
          href: { field: 'repository-link', type: 'nominal' }
        }
      },
      {
        id: 'repositories-activity',
        title: 'Activity by repository',
        description: 'Repository-local execution health and all attributed package or local-workflow outcomes.',
        data: { source: 'repository-activity' },
        mark: 'table',
        controls: 'static',
        'empty-message': 'No repositories discovered.',
        encoding: {
          columns: [
            { field: 'repository', type: 'nominal', title: 'Repository' },
            { field: 'workflows', type: 'quantitative', title: 'Local AWs' },
            { field: 'reports', type: 'quantitative', title: 'Reports' },
            { field: 'evaluated-workflows', type: 'quantitative', title: 'Evaluated AWs' },
            { field: 'runs', type: 'quantitative', title: 'Local runs' },
            { field: 'failure-summary', type: 'nominal', title: 'Failure rate' },
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
                availability: true,
                completeness: true,
                freshness: true
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
      }
    });

    const headings = [...rendered.querySelectorAll('[data-page-id="runs"] .page-section h3')].map((element) => element.textContent);
    expect(headings).toEqual(['Run health trend', 'Runs Runs Source']);
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
                availability: true,
                completeness: true,
                freshness: true
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
                availability: true,
                completeness: true,
                freshness: true
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
                table: true,
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
    expect(chartSection?.querySelectorAll('.custom-chart-table tbody tr')).toHaveLength(2);
    const chartLink = chartSection?.querySelector('.custom-chart-table tbody a');
    expect(chartLink?.getAttribute('href')).toBe('https://github.com/github/central-agentic-ops/actions/runs/1001');
    expect(chartLink?.getAttribute('aria-label')).toBe('Run 1001');
    expect(chartSection?.querySelectorAll('.view-source')).toHaveLength(0);

    const emptySection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Empty Usage'));
    expect(emptySection?.querySelector('[data-view-availability="empty"]')?.textContent).toBe('No observations matched the effective context.');
    expect(emptySection?.textContent).toContain('Affected source: empty-usage');

    const unavailableSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Source'));
    expect(unavailableSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view is unavailable.');
    expect(unavailableSection?.textContent).toContain('Source unavailable: missing-source');

    const missingElementSourceSection = [...rendered.querySelectorAll('.page-section')].find((section) => section.textContent?.includes('Missing Element Source'));
    expect(missingElementSourceSection?.querySelector('[data-view-availability="unavailable"]')?.textContent).toBe('This view is unavailable.');
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
    rendered.ownerDocument.documentElement.scrollTop = 320;
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-root]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-root]')?.hasAttribute('href')).toBe(false);
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.getAttribute('href')).toBe('#page-first');
    expect(rendered.querySelector('[data-breadcrumb-dashboard]')?.textContent).toBe('Overview');
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

    rendered.ownerDocument.documentElement.scrollTop = 80;
    firstLink.click();

    expect(renderedSecond.hasAttribute('data-page-pending')).toBe(true);
    expect(renderedSecond.childElementCount).toBe(0);
    expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).not.toBeNull();
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-first .dashboard-view-skeleton')).toBeNull();
    });
    const rehydratedFirst = /** @type {HTMLElement} */ (rendered.querySelector('#page-first'));
    expect(/** @type {HTMLDetailsElement | null} */ (rehydratedFirst.querySelector('details'))?.open).toBe(true);
    expect(rendered.ownerDocument.documentElement.scrollTop).toBe(320);
    rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
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
      'Reporting coverage gaps for the configured githubnext/gh-aw-cao repository.'
    );
    expect(rendered.querySelector('[data-breadcrumb-root]')?.textContent).toBe('Overview');
    expect(/** @type {HTMLElement | null} */ (rendered.querySelector('[data-breadcrumb-dashboard]'))?.hidden).toBe(true);
    expect(rendered.querySelector('[data-breadcrumb-page]')?.textContent).toBe('Coverage diagnostics');
    expect(rendered.querySelector('[data-nav-page-id="overview"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered.querySelectorAll('.org-sidebar [data-nav-page-id="coverage"]')).toHaveLength(0);
    const coveragePage = authoritativeDashboardDocument.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'coverage'
    );
    expect(coveragePage.route).toEqual({ 'navigation-page': 'overview' });
    expect(coveragePage.views[1]).toMatchObject({
      mark: 'element',
      element: 'summary-grid',
      data: { sources: ['repository-coverage'] }
    });
    expect(coveragePage.views[2]).toMatchObject({
      mark: 'table',
      controls: 'static',
      data: { source: 'coverage-diagnostics' }
    });
    expect(coveragePage.views[2]).not.toHaveProperty('element');
    expect(coveragePage.views[3]).toMatchObject({
      mark: 'table',
      controls: 'static',
      disclosure: 'supplemental',
      data: { source: 'coverage-diagnostics' }
    });
    await vi.waitFor(() => {
      expect(rendered.querySelector('#page-coverage')?.hasAttribute('data-page-pending')).toBe(false);
    });
    const essentialRows = rendered.querySelectorAll('#page-coverage [data-disclosure="essential"] .custom-table tbody tr');
    expect(essentialRows).toHaveLength(2);
    expect(essentialRows[1]?.textContent).toContain('Durable output evidence is partial because GitHub rate-limited collection.');
    expect(essentialRows[1]?.textContent).not.toContain('GitHub API rate limit exceeded');
    const technicalDetails = /** @type {HTMLDetailsElement | null} */ (
      rendered.querySelector('#page-coverage .view-disclosure[data-disclosure="supplemental"]')
    );
    expect(technicalDetails?.open).toBe(false);
    expect(technicalDetails?.textContent).toContain('GitHub API rate limit exceeded');

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
    expect(rendered.querySelector('.freshness')?.textContent).toMatch(/^\d+[smhdw] ago$/);
    expect(rendered.querySelector('.freshness')?.getAttribute('datetime')).toBe('2026-08-30T12:01:00Z');
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
