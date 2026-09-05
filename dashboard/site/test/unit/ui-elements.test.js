// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';

const metadata = {
  'source-id': 'signal-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('UI elements', () => {
  it('renders anomaly readiness as a reusable note widget', () => {
    const rendered = renderUiElement('anomaly-readiness', {
      pageId: 'runtime',
      title: 'Statistical anomaly readiness',
      sourceNames: ['runtime-anomaly-readiness'],
      sources: {
        'runtime-anomaly-readiness': {
          source: 'runtime-anomaly-readiness',
          rows: [{
            icon: 'pulse',
            title: 'Statistical anomalies · not evaluated',
            detail: 'A representative historical baseline is unavailable.'
          }],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.getAttribute('role')).toBe('note');
    expect(rendered?.querySelector('.octicon-pulse')).not.toBeNull();
    expect(rendered?.textContent).toContain('Statistical anomalies · not evaluated');
    expect(rendered?.textContent).toContain('A representative historical baseline is unavailable.');
    expect(renderUiElement('anomaly-readiness', {
      pageId: 'runtime',
      title: 'Statistical anomaly readiness',
      sourceNames: [],
      sources: {},
      contextDetails: [],
      headingTag: 'h3'
    })).toBeNull();
  });

  it('renders suggested configuration changes as a list without a table header', () => {
    const rendered = renderUiElement('configuration-actions', {
      pageId: 'configuration',
      title: 'Suggested changes',
      description: 'Copy a bounded prompt to make a policy change.',
      sourceNames: ['configuration-actions'],
      sources: {
        'configuration-actions': {
          source: 'configuration-actions',
          rows: [{
            action: 'Promote self-care to live',
            path: 'control-plane.packages.self-care.mode',
            current: 'review',
            recommended: 'live',
            prompt: 'Update the policy.'
          }],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('table')).toBeNull();
    expect(rendered?.querySelectorAll('.configuration-action-list > li')).toHaveLength(1);
    expect(rendered?.textContent).toContain('Promote self-care to live');
    expect(rendered?.textContent).toContain('control-plane.packages.self-care.mode');
    expect(rendered?.querySelector('[data-intent-presentation="copy-prompt"]')).not.toBeNull();
  });

  it('renders the suggested configuration changes empty state inside the list widget', () => {
    const rendered = renderUiElement('configuration-actions', {
      pageId: 'configuration',
      title: 'Suggested changes',
      sourceNames: ['configuration-actions'],
      sources: {
        'configuration-actions': {
          source: 'configuration-actions',
          rows: [],
          metadata: { ...metadata, availability: /** @type {'empty'} */ ('empty') }
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('.configuration-actions-empty')?.textContent)
      .toBe('No configuration changes are currently suggested.');
  });

  it('allows same-document signal navigation and rejects non-fragment URLs', () => {
    const rendered = renderUiElement('signal-list', {
      pageId: 'runtime',
      title: 'Signals',
      sourceNames: ['runtime-signals'],
      sources: {
        'runtime-signals': {
          source: 'runtime-signals',
          rows: [
            { title: 'Safe', 'navigation-href': '#runtime-evidence' },
            { title: 'Unsafe', 'navigation-href': 'javascript:alert(1)' }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('a')?.getAttribute('href')).toBe('#runtime-evidence');
    expect(rendered?.querySelectorAll('a')).toHaveLength(1);
  });

  it('renders canonical attention as a complete priority-first action region', () => {
    const rendered = renderUiElement('signal-list', {
      pageId: 'home',
      title: 'Need attention',
      description: 'Unresolved conditions that require an authorized person to act or investigate.',
      sourceNames: ['attention-signals'],
      sources: {
        'attention-signals': {
          source: 'attention-signals',
          rows: [
            {
              'attention-signal-id': 'verification:dependabot:74',
              'signal-type': 'verification-review',
              objective: 'Update the Dependabot release train',
              scope: 'github/gh-aw',
              reason: 'Security verification requires human review.',
              action: 'Review dependency evidence',
              'expected-actor': 'security-reviewers',
              'age-seconds': 4800,
              'consequence-tier': 'high',
              priority: 2,
              'evidence-link': {
                relation: 'evidence',
                href: 'https://example.com/evidence/release-train',
                label: 'Review dependency evidence'
              }
            },
            {
              'attention-signal-id': 'authority:mona-tools:upgrade',
              'signal-type': 'authority-gate',
              objective: 'Upgrade agentic workflow dependencies',
              scope: 'github/mona-tools',
              reason: 'Live target authority is unavailable.',
              action: 'Confirm authority or retain review mode',
              'expected-actor': 'repository-owner',
              'age-seconds': 9000,
              'consequence-tier': 'medium',
              priority: 1
            }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.getAttribute('aria-labelledby')).toBe('home-need-attention-heading');
    expect(rendered?.querySelector('.view-metadata-summary')).toBeNull();
    expect(rendered?.querySelector('.canonical-attention-item.signal-action')).not.toBeNull();
    expect(rendered?.querySelectorAll('.canonical-attention-item')).toHaveLength(1);
    expect(rendered?.querySelector('.signal-priority-rank strong')?.textContent).toBe('1');
    expect(rendered?.textContent).toContain('medium · authority gate');
    expect(rendered?.textContent).toContain('Upgrade agentic workflow dependencies');
    expect(rendered?.textContent).toContain('github/mona-tools · Live target authority is unavailable.');
    expect(rendered?.textContent).toContain('repository-owner · 2h 30m old');
  });

  it('renders a blocked readiness verdict with the next unblock action', () => {
    const rendered = renderUiElement('readiness-verdict', {
      pageId: 'readiness',
      title: 'Readiness verdict',
      sourceNames: ['readiness-summary'],
      sources: {
        'readiness-summary': {
          source: 'readiness-summary',
          rows: [
            { label: 'Control plane', value: 'Not ready' },
            { label: 'Unblock first', value: '4 worker runs failed' },
            { label: 'Engine activity', value: '20 runs observed · 4 failed' },
            { label: 'Readiness checks', value: '3 / 5 passing' }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.classList.contains('readiness-verdict-blocked')).toBe(true);
    expect(rendered?.querySelector('.octicon-x-circle')).not.toBeNull();
    expect(rendered?.textContent).toContain('Unblock first4 worker runs failed');
  });

  it('renders JSON summary rows and allows only same-document item navigation', () => {
    const rendered = renderUiElement('context-summary', {
      pageId: 'repositories',
      title: 'Repository scope',
      sourceNames: ['repositories', 'repository-summary'],
      sources: {
        repositories: {
          source: 'repositories',
          rows: [{ repository: 'octo/one' }],
          metadata
        },
        'repository-summary': {
          source: 'repository-summary',
          rows: [
            {
              label: 'Repositories',
              items: [
                null,
                { label: 'octo/one', 'navigation-href': '#page-repository-detail?repository=octo%2Fone' },
                { label: 'unsafe', 'navigation-href': 'javascript:alert(1)' }
              ]
            },
            { label: 'Run window', value: 'Complete 24-hour window' }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.getAttribute('aria-label')).toBe('Repository scope');
    expect(rendered?.querySelector('dd')?.textContent).toBe('octo/one, unsafe');
    expect(rendered?.textContent).toContain('Run windowComplete 24-hour window');
    expect(rendered?.querySelectorAll('a')).toHaveLength(1);
    expect(rendered?.querySelector('a')?.getAttribute('href')).toBe('#page-repository-detail?repository=octo%2Fone');
  });

  it('flags managed packages that dispatch but produce no output', () => {
    const rendered = renderUiElement('package-status-grid', {
      pageId: 'overview',
      title: 'Packages',
      sourceNames: ['overview-managed-packages'],
      sources: {
        'overview-managed-packages': {
          source: 'overview-managed-packages',
          rows: [
            {
              package: 'daily-ops',
              title: 'Daily Ops',
              icon: 'workflow',
              'dispatch-count': 3,
              'dispatch-success-count': 0,
              'dispatch-failure-count': 2,
              'dispatch-approval-count': 0,
              'dispatch-pending-count': 1,
              'dispatches-with-safe-output': 0,
              'activity-window': 'Complete 24-hour window',
              inventory: 'Ready',
              'inventory-state': 'inventory-ready',
              href: '#page-package-insights?package=daily-ops'
            },
            {
              package: 'weekly-ops',
              title: 'Weekly Ops',
              icon: 'workflow',
              'dispatch-count': 2,
              'dispatch-success-count': 1,
              'dispatch-failure-count': 0,
              'dispatch-approval-count': 1,
              'dispatch-pending-count': 0,
              'dispatches-with-safe-output': 1,
              'activity-window': 'Complete 24-hour window',
              inventory: 'Ready',
              'inventory-state': 'inventory-ready',
              href: '#page-package-insights?package=weekly-ops'
            }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    const cards = [...(rendered?.querySelectorAll('.package-status-card') ?? [])];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.package-status-identity')?.getAttribute('href')).toBe('#page-package-insights?package=daily-ops');
    expect(cards[0]?.querySelector('.package-status-activity')?.getAttribute('href')).toBe('#page-package-dispatches?package=daily-ops');
    expect(cards[0]?.querySelector('.package-status-activity')?.classList.contains('package-status-activity-warning')).toBe(true);
    expect(cards[0]?.querySelector('.package-status-activity-state')?.textContent).toContain('2 failed');
    expect(cards[0]?.querySelector('.package-status-activity-state')?.classList.contains('package-status-activity-state-failed')).toBe(true);
    expect(cards[0]?.querySelector('.package-status-activity .octicon-alert')).not.toBeNull();
    expect(cards[0]?.querySelector('.package-status-activity')?.getAttribute('aria-label')).toContain('2 failed, 1 in progress');
    expect(cards[0]?.querySelector('.package-status-activity')?.getAttribute('aria-label')).toContain('warning: dispatches produced no output');
    expect(cards[1]?.querySelector('.package-status-activity')?.classList.contains('package-status-activity-warning')).toBe(false);
    expect(cards[1]?.querySelector('.package-status-activity-state')?.textContent).toContain('1 awaiting approval');
    expect(cards[1]?.querySelector('.package-status-activity-state')?.classList.contains('package-status-activity-state-attention')).toBe(true);
    expect(cards[1]?.querySelector('.package-status-activity .octicon-shield-check')).not.toBeNull();
    expect(cards[1]?.querySelector('.package-status-activity')?.getAttribute('aria-label')).not.toContain('warning');
  });

  it('renders package activity primitives as independently reusable elements', () => {
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [
          { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'package-inventory-warnings': 2 },
          { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'package-inventory-warnings': 2 }
        ],
        metadata
      },
      runs: {
        source: 'runs',
        rows: [
          { workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' }
        ],
        metadata
      },
      outcomes: {
        source: 'outcomes',
        rows: [
          { package: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' }
        ],
        metadata
      },
      usage: {
        source: 'usage',
        rows: [
          { workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 10, 'rollout-mode': 'review' }
        ],
        metadata: { ...metadata, completeness: /** @type {'partial'} */ ('partial') }
      },
      findings: {
        source: 'findings',
        rows: [
          { workflow: '.github/workflows/daily-worker.md', run: '1', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-28T10:05:00Z' }
        ],
        metadata
      }
    };

    const utilization = renderUiElement('package-utilization', {
      pageId: 'packages',
      title: 'Package AIC utilization',
      sourceNames: ['workflows', 'usage'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    const trend = renderUiElement('package-run-trend', {
      pageId: 'packages',
      title: 'All runs over time',
      sourceNames: ['workflows', 'runs', 'outcomes'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });
    const summary = renderUiElement('package-summary-table', {
      pageId: 'packages',
      title: 'All output by package',
      sourceNames: ['workflows', 'usage', 'findings', 'outcomes', 'runs'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(utilization?.querySelector('.package-utilization-card')).not.toBeNull();
    expect(utilization?.textContent).toContain('10 of 100 AIC across 1 reported run');
    expect(trend?.querySelector('.package-chart-point')).not.toBeNull();
    expect(trend?.querySelector('h3')?.textContent).toBe('All runs over time');
    expect(summary?.querySelector('.package-summary-table')).not.toBeNull();
    expect(summary?.textContent).toContain('Daily Ops');
  });

  it('renders package-detail through the reusable package-route variant without relying on page identity', () => {
    const rendered = renderUiElement('package-detail', {
      pageId: 'totally-custom-package-page',
      title: 'Package workflows',
      sourceNames: ['workflows'],
      routeParameter: 'package',
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            package: 'sample-package',
            'package-name': 'Sample Package',
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/sample.md',
            'workflow-name': 'Sample workflow',
            'workflow-role': 'standalone',
            'workflow-active': 'true',
            'rollout-mode': 'review'
          }]
        }
      }
    });

    rendered?.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'sample-package' }
    }));

    expect(rendered?.querySelector('.package-tabs [aria-current="page"]')?.textContent).toBe('Workflows');
    expect(rendered?.querySelector('.package-tabs')?.textContent).toContain('Reports');
  });

  it('renders the packages page shell through one declarative element composition', () => {
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [
          { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'package-inventory-warnings': 2 },
          { package: 'daily-ops', 'package-name': 'Daily Ops', 'package-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'package-inventory-warnings': 2 }
        ],
        metadata
      },
      runs: {
        source: 'runs',
        rows: [
          { workflow: '.github/workflows/daily.md', run: '1', 'started-at': '2026-08-28T10:00:00Z', 'run-conclusion': 'success', 'rollout-mode': 'review' }
        ],
        metadata
      },
      outcomes: {
        source: 'outcomes',
        rows: [
          { package: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' }
        ],
        metadata
      },
      usage: {
        source: 'usage',
        rows: [
          { workflow: '.github/workflows/daily.md', run: '1', invocation: 'a', aic: 10, 'rollout-mode': 'review' }
        ],
        metadata: { ...metadata, completeness: /** @type {'partial'} */ ('partial') }
      },
      findings: {
        source: 'findings',
        rows: [
          { workflow: '.github/workflows/daily-worker.md', run: '1', finding: 'warning-1', 'finding-kind': 'authored-warning', 'observed-at': '2026-08-28T10:05:00Z' }
        ],
        metadata
      }
    };

    const rendered = renderUiElement('package-activity-shell', {
      pageId: 'packages',
      title: 'Package activity',
      sourceNames: ['workflows', 'usage', 'runs', 'outcomes', 'findings'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('.package-utilization-card')).not.toBeNull();
    expect(rendered?.querySelector('.package-chart-point')).not.toBeNull();
    expect(rendered?.querySelector('.package-summary-table')).not.toBeNull();
    expect(rendered?.querySelector('.package-mode-tabs')).not.toBeNull();
  });

  it('renders workflow-route with declarative body selection', () => {
    const rendered = renderUiElement('workflow-route', {
      pageId: 'custom-workflow-page',
      title: 'Workflow',
      sourceNames: ['workflows', 'runs', 'usage', 'operational-values'],
      routeParameter: 'workflow',
      elementConfig: { body: 'insights' },
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/sample.md',
            'workflow-name': 'Sample workflow',
            'workflow-role': 'standalone',
            'workflow-active': 'true',
            'rollout-mode': 'review'
          }]
        },
        runs: { source: 'runs', metadata, rows: [] },
        usage: { source: 'usage', metadata, rows: [] },
        'operational-values': { source: 'operational-values', metadata, rows: [] }
      }
    });

    rendered?.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'githubnext/gh-aw-cao:.github/workflows/sample.md' }
    }));

    expect(rendered?.querySelector('.workflow-tabs [aria-current="page"]')?.textContent).toBe('Insights');
    expect(rendered?.querySelector('.workflow-runtime-metrics')).not.toBeNull();
  });

  it('renders workflow-route with declarative reports composition without page-specific logic', () => {
    const rendered = renderUiElement('workflow-route', {
      pageId: 'custom-workflow-reports-page',
      title: 'Workflow reports',
      sourceNames: ['workflows'],
      routeParameter: 'workflow',
      elementConfig: { body: 'reports' },
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/sample.md',
            'workflow-name': 'Sample workflow',
            'workflow-role': 'standalone',
            'workflow-active': 'true',
            'rollout-mode': 'review'
          }]
        }
      }
    });

    rendered?.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'workflow', value: 'githubnext/gh-aw-cao:.github/workflows/sample.md' }
    }));

    expect(rendered?.querySelector('.workflow-tabs [aria-current="page"]')?.textContent).toBe('Reports');
  });

  it('renders outcome-detail-section from declarative config and filtered outcome scope', () => {
    const rendered = renderUiElement('outcome-detail-section', {
      pageId: 'outcome-detail',
      title: 'Outcome metadata',
      sourceNames: ['outcomes'],
      elementConfig: { section: 'outcome-detail-section', body: 'metadata' },
      scope: { 'safe-output': 'outcome-1' },
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [{
            'safe-output': 'outcome-1',
            'outcome-state': 'lifecycle-close',
            'outcome-status': 'closed',
            'rollout-mode': 'live',
            'outcome-category': 'pull-request',
            'workflow-name': 'Daily review',
            'external-link': { relation: 'external', href: 'https://github.com/octo/repo/pull/1', label: 'View output' }
          }]
        }
      }
    });

    expect(rendered?.className).toBe('outcome-meta');
    expect(rendered?.textContent).toContain('Daily review');
    expect(rendered?.textContent).toContain('Pull Request');
    expect(rendered?.querySelector('.workflow-runtime-metrics')).toBeNull();
  });

  it('renders outcome-detail-section when elementConfig omits the section property', () => {
    const rendered = renderUiElement('outcome-detail-section', {
      pageId: 'outcome-detail',
      title: 'Discussion',
      sourceNames: ['outcomes'],
      elementConfig: { body: 'discussion' },
      scope: { 'safe-output': 'outcome-1' },
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [{
            'safe-output': 'outcome-1',
            'outcome-body-html': '<p>Discussion content</p>',
            'published-at': '2026-08-31T01:26:00Z',
            'observed-at': '2026-08-31T01:49:00Z'
          }]
        }
      }
    });

    expect(rendered?.className).toBe('discussion-post');
  });
});
