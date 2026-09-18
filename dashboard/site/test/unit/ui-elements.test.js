// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { enableLazyViews } from '../../src/components/lazy-view.js';
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

/** @param {Record<string, unknown>} row */
function declarativeWorkRow(row) {
  const state = row['lifecycle-state'] === 'review'
    ? 'needs-review'
    : row['lifecycle-state'] === 'active' ? 'in-progress' : 'todo';
  return {
    ...row,
    'work-id': row['work-item-id'],
    'work-name': row['workflow-name'] ?? row.name,
    'work-icon': row['workflow-icon'],
    'work-campaign': row.campaign,
    'work-repository': row.repository ?? row.scope,
    'work-owner': row.owner,
    'work-state': state,
    'work-started': row['started-at'] ?? row['observed-at'],
    'work-stopped': row['ended-at'],
    'work-type-normalized': row['work-type'],
    'work-group-id': row.campaign,
    'work-group-label': row.campaign,
    'work-grouped': Boolean(row.campaign),
    'work-state-options': ['In Progress', 'Needs Review'],
    'work-campaign-options': ['dependabot', 'security-review']
  };
}

describe('UI elements', () => {
  it('composes operational value, outcomes, cost, runtime, security, and experiments in Insights', () => {
    /** @param {Array<Record<string, unknown>>} rows */
    const source = (rows) => ({ source: 'fixture', rows, metadata });
    const rendered = renderUiElement('insights-overview', {
      pageId: 'insights', title: 'Insights', description: 'Operational impact.',
      sourceNames: ['operational-values', 'outcomes', 'usage', 'runs', 'detection-observations', 'experiments'],
      sources: {
        'operational-values': source([
          { 'operational-value': 60, 'operational-value-definition': 'Accepted change', 'observed-at': '2026-08-29T10:00:00Z' },
          { 'operational-value': 80, 'operational-value-definition': 'Accepted change', 'observed-at': '2026-08-30T10:00:00Z' },
          { 'operational-value': 50, 'operational-value-definition': 'Issue resolved', 'observed-at': '2026-08-29T10:00:00Z' },
          { 'operational-value': 90, 'operational-value-definition': 'Issue resolved', 'observed-at': '2026-08-30T10:00:00Z' },
          { 'operational-value': null, 'operational-value-definition': 'Issue resolved', 'observed-at': '2026-08-30T11:00:00Z' }
        ]),
        outcomes: source([
          { 'outcome-state': 'accepted' }, { 'outcome-state': 'accepted' }, { 'outcome-state': 'rejected' }
        ]),
        usage: source([
          { aic: 4, 'observed-at': '2026-08-29T10:00:00Z' }, { aic: 6, 'observed-at': '2026-08-30T10:00:00Z' }
        ]),
        runs: source([
          { run: '1', 'started-at': '2026-08-29T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' },
          { run: '2', 'started-at': '2026-08-30T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure' }
        ]),
        'detection-observations': source([
          { 'detection-state': 'clean', 'detection-state-label': 'Clean', 'usable-verdict-percent': 100 },
          { 'detection-state': 'threat', 'detection-state-label': 'Threat', 'usable-verdict-percent': 100 }
        ]),
        experiments: source([
          { decision: 'PROMOTE' }, { decision: 'INCONCLUSIVE' }
        ])
      },
      contextDetails: [],
      headingTag: 'h3'
    });
    if (rendered) enableLazyViews(rendered);

    expect(rendered?.querySelector('#insights-value-title')?.textContent).toBe('Operational value metrics');
    expect(rendered?.querySelectorAll('.insights-lead-metrics dd')[0]?.textContent).toBe('70');
    expect(rendered?.querySelectorAll('.insights-lead-metrics dd')[1]?.textContent).toBe('2');
    expect(rendered?.querySelectorAll('.insights-lead-metrics dd')[2]?.textContent).toBe('4');
    expect(rendered?.querySelectorAll('[data-chart-widget]')).toHaveLength(6);
    expect(rendered?.querySelectorAll('[data-chart-widget="pie"]')).toHaveLength(2);
    expect(rendered?.querySelector('[data-chart-widget="swimlane"]')).not.toBeNull();
    expect(rendered?.querySelector('[data-chart-widget="bar"]')).not.toBeNull();
    expect(rendered?.textContent).toContain('10AIC observed');
    expect(rendered?.textContent).toContain('1 decision-ready');
    const seriesSelector = rendered?.querySelector('.insights-series-selector');
    expect(seriesSelector?.hasAttribute('open')).toBe(false);
    expect(seriesSelector?.querySelector('summary')?.textContent).toBe('Series2 of 2');
    expect(rendered?.querySelector('.insights-value-lead > .chart-legend')).toBeNull();
    const seriesInputs = seriesSelector?.querySelectorAll('input[type="checkbox"]');
    expect(seriesInputs).toHaveLength(2);
    if (seriesInputs?.[0] instanceof HTMLInputElement) {
      seriesInputs[0].checked = false;
      seriesInputs[0].dispatchEvent(new Event('change'));
      expect(seriesSelector?.querySelector('summary')?.textContent).toBe('Series1 of 2');
      expect(rendered?.querySelector('.insights-value-chart')?.textContent).not.toContain('No data is available');
    }
  });

  it('renders every campaign operational-value extract in separate primary and diagnostic histories', () => {
    const rendered = renderUiElement('campaign-route', {
      pageId: 'campaign-insights', title: 'Operational value history',
      routeParameter: 'campaign',
      elementConfig: { body: 'insights' },
      sourceNames: ['workflows', 'campaign-operational-value-series'],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{ campaign: 'alpha-campaign', 'campaign-name': 'Alpha campaign', workflow: '.github/workflows/worker.md' }]
        },
        'campaign-operational-value-series': {
          source: 'campaign-operational-value-series',
          metadata,
          rows: [
            { campaign: 'alpha-campaign', metric: 'repository-readiness', 'metric-key': 'primary:repository-readiness', 'metric-name': 'repository-readiness', 'metric-kind': 'primary', points: [{ x: '2026-08-29T10:00:00Z', y: 40, color: '.github/workflows/worker.md', key: 'primary:0' }, { x: '2026-08-30T10:00:00Z', y: 80, color: '.github/workflows/worker.md', key: 'primary:1' }] },
            { campaign: 'alpha-campaign', metric: 'quality', 'metric-key': 'diagnostic:repository-readiness:quality', 'metric-name': 'Quality', 'metric-kind': 'diagnostic', points: [{ x: '2026-08-29T10:00:00Z', y: 50, color: '.github/workflows/worker.md', key: 'quality:0' }, { x: '2026-08-30T10:00:00Z', y: 90, color: '.github/workflows/worker.md', key: 'quality:1' }] },
            { campaign: 'alpha-campaign', metric: 'efficiency', 'metric-key': 'diagnostic:repository-readiness:efficiency', 'metric-name': 'Efficiency', 'metric-kind': 'diagnostic', points: [{ x: '2026-08-29T10:00:00Z', y: 70, color: '.github/workflows/worker.md', key: 'efficiency:0' }, { x: '2026-08-30T10:00:00Z', y: 60, color: '.github/workflows/worker.md', key: 'efficiency:1' }] }
          ]
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });
    rendered?.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'alpha-campaign' }
    }));

    expect(rendered?.querySelectorAll('[data-chart-widget="line"]')).toHaveLength(3);
    expect([...rendered?.querySelectorAll('.insights-measure-row h3') ?? []].map((heading) => heading.textContent)).toEqual([
      'Repository readiness',
      'Quality',
      'Efficiency'
    ]);
    expect(rendered?.querySelectorAll('.chart-point')).toHaveLength(6);
    expect(rendered?.querySelectorAll('.insights-measure-rows > .insights-measure-row')).toHaveLength(3);
    expect([...rendered?.querySelectorAll('.insights-measure-row .insights-axis-y') ?? []].map((label) => label.textContent)).toEqual([
      'Repository readiness (measured value)',
      'Quality (measured value)',
      'Efficiency (measured value)'
    ]);
    expect([...rendered?.querySelectorAll('.insights-measure-row .insights-axis-x') ?? []].map((label) => label.textContent))
      .toEqual(['Observation time (UTC)', 'Observation time (UTC)', 'Observation time (UTC)']);
    expect(rendered?.textContent).toContain('Primary operational-value measure “Repository readiness”');
    expect(rendered?.textContent).toContain('Diagnostic measure “Quality”');
    expect(rendered?.textContent).toContain('2 extracts across 1 workflow series');

    const readout = rendered?.querySelector('.insights-measure-row .insights-point-readout');
    expect(readout?.textContent).toBe('Select a point to inspect that observation.');
    const point = rendered?.querySelector('.insights-measure-row .chart-point[data-chart-point-key]');
    expect(point?.getAttribute('aria-pressed')).toBe('false');
    point?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(point?.getAttribute('aria-pressed')).toBe('true');
    expect(point?.getAttribute('data-selected')).toBe('true');
    expect(readout?.textContent).toContain('40');
    expect(readout?.textContent).toContain('.github/workflows/worker.md');
    point?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(point?.getAttribute('aria-pressed')).toBe('false');
    expect(readout?.textContent).toBe('Select a point to inspect that observation.');
  });

  it('renders the routed Work roadmap as a Projects-style timeline', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'work-roadmap',
      title: 'Roadmap',
      description: 'GitHub Projects-style work planning view.',
      sourceNames: ['work-roadmap-items'],
      sources: {
        'work-roadmap-items': {
          source: 'work-roadmap-items',
          rows: [
            {
              'work-item-id': 'github/gh-aw:.github/workflows/dependabot.md',
              name: 'Dependabot release train',
              'workflow-name': 'Dependabot release train',
              'workflow-icon': 'dependabot',
              campaign: 'dependabot',
              scope: 'github/gh-aw',
              repository: 'gh-aw',
              owner: 'dependency-automation',
              'lifecycle-state': 'active',
              'started-at': '2026-08-30T09:00:00Z',
              'ended-at': '2026-08-30T09:30:00Z',
              'evidence-link': {
                relation: 'evidence',
                href: 'https://example.com/evidence/dependabot',
                label: 'Dependabot evidence'
              }
            },
            {
              'work-item-id': 'github/mona-tools:.github/workflows/review.md',
              'workflow-name': 'Review security posture',
              'workflow-icon': 'shield-check',
              campaign: 'security-review',
              scope: 'github/mona-tools',
              owner: 'security',
              'lifecycle-state': 'review',
              'started-at': '2026-08-30T10:00:00Z'
            }
          ].map(declarativeWorkRow),
          metadata
        }
      },
      elementConfig: {
        body: 'roadmap'
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('.work-project-tabs')?.textContent).toBe('BoardTasksRoadmap');
    expect(rendered?.querySelector('[href="#page-work-roadmap"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered?.querySelector('.work-board')).toBeNull();
    expect(rendered?.querySelector('.work-tasks')).toBeNull();
    expect(rendered?.querySelector('.work-avatar')).not.toBeNull();
    expect(rendered?.querySelector('.work-roadmap-scroll')).not.toBeNull();
    expect(rendered?.querySelector('.work-roadmap-calendar')).not.toBeNull();
    expect(rendered?.querySelectorAll('.work-roadmap-ticks time').length).toBeGreaterThan(1);
    expect(rendered?.querySelectorAll('.work-roadmap-lane')).toHaveLength(2);
    expect(rendered?.querySelector('.work-roadmap-avatar')).not.toBeNull();
    expect(rendered?.querySelector('.work-roadmap-label')?.textContent).toContain('dependency-automation');
    expect(rendered?.querySelector('.work-roadmap-end')).not.toBeNull();
    const zoomButtons = rendered ? [...rendered.querySelectorAll('[data-roadmap-zoom]')] : [];
    expect(zoomButtons.map((button) => button.textContent)).toEqual([
      'Day', 'Week', 'Month', 'Quarter', 'Year'
    ]);
    expect(rendered?.querySelector('[data-roadmap-zoom="year"]')?.getAttribute('aria-checked')).toBe('true');
    const dayZoom = rendered?.querySelector('[data-roadmap-zoom="day"]');
    if (!(dayZoom instanceof HTMLButtonElement)) throw new Error('day zoom control did not render');
    dayZoom.click();
    expect(rendered?.querySelector('.work-roadmap-zoom-label')?.textContent).toBe('Day');
    expect(rendered?.querySelectorAll('.work-roadmap-ticks time')).toHaveLength(12);
    expect(rendered?.querySelector('[data-roadmap-zoom="day"]')?.getAttribute('aria-checked')).toBe('true');

    const filterBar = rendered?.querySelector('.work-filter-bar');
    expect(filterBar?.querySelector('[aria-label="Filter by state"]')).not.toBeNull();
    expect(filterBar?.querySelector('[aria-label="Filter by campaign"]')?.textContent).toContain('dependabot');
    expect(filterBar?.querySelector('.work-filter-count')?.textContent).toBe('2 of 2');
  });

  it('renders a single declarative work slice when config.body selects one', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'insights',
      title: 'Tasks',
      sourceNames: ['work-project-items'],
      sources: {
        'work-project-items': {
          source: 'work-project-items',
          rows: [{
            'work-item-id': 'github/gh-aw:.github/workflows/dependabot.md',
            'workflow-name': 'Dependabot release train',
            scope: 'github/gh-aw',
            owner: 'dependency-automation',
            'lifecycle-state': 'active',
            'started-at': '2026-08-30T09:00:00Z'
          }].map(declarativeWorkRow),
          metadata
        }
      },
      elementConfig: {
        body: 'tasks'
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('[href="#page-work-tasks"]')?.getAttribute('aria-current')).toBe('page');
    expect(rendered?.querySelector('.work-tasks')).not.toBeNull();
    expect(rendered?.querySelector('.work-board')).toBeNull();
    expect(rendered?.querySelector('.work-roadmap')).toBeNull();
  });

  it('groups campaigns in Board while keeping every Tasks and Roadmap item visible', () => {
    const rows = [
      {
        'work-item-id': 'daily-ops:orchestrator',
        'workflow-name': 'Daily Ops',
        campaign: 'daily-ops',
        'work-type': 'orchestrator',
        scope: 'githubnext/gh-aw-cao',
        'lifecycle-state': 'active',
        'started-at': '2026-09-06T08:00:00Z'
      },
      {
        'work-item-id': 'daily-ops:worker',
        'workflow-name': 'Daily Ops worker',
        campaign: 'daily-ops',
        'work-type': 'worker',
        scope: 'githubnext/gh-aw-cao',
        'lifecycle-state': 'active',
        'started-at': '2026-09-06T08:05:00Z'
      }
    ];
    /** @param {'board'|'tasks'|'roadmap'} body */
    const render = (body) => {
      const sourceName = body === 'board'
        ? 'work-board-in-progress'
        : body === 'roadmap' ? 'work-roadmap-items' : 'work-project-items';
      return renderUiElement('work-project-view', {
      pageId: `work-${body}`,
      title: body,
      sourceNames: [sourceName],
      sources: {
        [sourceName]: {
          source: sourceName,
          rows: rows.map(declarativeWorkRow),
          metadata
        }
      },
      elementConfig: { body },
      contextDetails: [],
      headingTag: 'h3'
      });
    };

    const board = render('board');
    expect(board?.querySelectorAll('.work-card-stack')).toHaveLength(1);
    expect(board?.querySelectorAll('.work-card-stack .work-card')).toHaveLength(2);
    const boardWorkers = board?.querySelector('.work-card-workers');
    expect(boardWorkers?.hasAttribute('open')).toBe(false);
    expect(boardWorkers?.querySelector('summary')?.textContent).toContain('1 worker');
    expect(boardWorkers?.querySelector('summary')?.textContent).toContain('Show cards');

    const tasks = render('tasks');
    expect(tasks?.querySelector('.work-task-group')).toBeNull();
    expect(tasks?.querySelectorAll('.work-task-row')).toHaveLength(2);
    expect([...(tasks?.querySelectorAll('.work-task-type') ?? [])].map((cell) => cell.textContent)).toEqual(['orchestrator', 'worker']);

    const roadmap = render('roadmap');
    expect(roadmap?.querySelector('.work-roadmap-group')).toBeNull();
    expect(roadmap?.querySelectorAll('.work-roadmap-lane')).toHaveLength(2);
  });

  it('renders inferred Work timestamps as point observations instead of running intervals', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'work-roadmap',
      title: 'Roadmap',
      sourceNames: ['work-roadmap-items'],
      sources: {
        'work-roadmap-items': {
          source: 'work-roadmap-items',
          rows: [{
            'work-item-id': 'aw-doctor:inventory',
            'workflow-name': 'AW Doctor',
            scope: 'githubnext/gh-aw-cao',
            'lifecycle-state': 'unknown',
            'reason-evidence-class': 'inferred',
            'observed-at': '2026-09-07T05:23:02Z'
          }].map(declarativeWorkRow),
          metadata
        }
      },
      elementConfig: { body: 'roadmap' },
      contextDetails: [],
      headingTag: 'h3'
    });

    const point = rendered?.querySelector('.work-roadmap-point');
    expect(point).not.toBeNull();
    expect(point?.getAttribute('title')).toContain('observed');
    expect(rendered?.querySelector('.work-roadmap-end')).toBeNull();
  });

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
            path: 'control-plane.campaigns.self-care.mode',
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
    expect(rendered?.textContent).toContain('control-plane.campaigns.self-care.mode');
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

  it('flags managed campaigns that dispatch but produce no output', () => {
    const rendered = renderUiElement('campaign-status-grid', {
      pageId: 'overview',
      title: 'Campaigns',
      sourceNames: ['overview-managed-campaigns'],
      sources: {
        'overview-managed-campaigns': {
          source: 'overview-managed-campaigns',
          rows: [
            {
              campaign: 'daily-ops',
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
              href: '#page-campaign-insights?campaign=daily-ops'
            },
            {
              campaign: 'weekly-ops',
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
              href: '#page-campaign-insights?campaign=weekly-ops'
            }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    const cards = [...(rendered?.querySelectorAll('.campaign-status-card') ?? [])];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('.campaign-status-identity')?.getAttribute('href')).toBe('#page-campaign-insights?campaign=daily-ops');
    expect(cards[0]?.querySelector('.campaign-status-activity')?.getAttribute('href')).toBe('#page-campaign-runs?campaign=daily-ops');
    expect(cards[0]?.querySelector('.campaign-status-activity')?.classList.contains('campaign-status-activity-warning')).toBe(true);
    expect(cards[0]?.querySelector('.campaign-status-activity-state')?.textContent).toContain('2 failed');
    expect(cards[0]?.querySelector('.campaign-status-activity-state')?.classList.contains('campaign-status-activity-state-failed')).toBe(true);
    expect(cards[0]?.querySelector('.campaign-status-activity .octicon-alert')).not.toBeNull();
    expect(cards[0]?.querySelector('.campaign-status-activity')?.getAttribute('aria-label')).toContain('2 failed, 1 in progress');
    expect(cards[0]?.querySelector('.campaign-status-activity')?.getAttribute('aria-label')).toContain('warning: dispatches produced no output');
    expect(cards[1]?.querySelector('.campaign-status-activity')?.classList.contains('campaign-status-activity-warning')).toBe(false);
    expect(cards[1]?.querySelector('.campaign-status-activity-state')?.textContent).toContain('1 awaiting approval');
    expect(cards[1]?.querySelector('.campaign-status-activity-state')?.classList.contains('campaign-status-activity-state-attention')).toBe(true);
    expect(cards[1]?.querySelector('.campaign-status-activity .octicon-shield-check')).not.toBeNull();
    expect(cards[1]?.querySelector('.campaign-status-activity')?.getAttribute('aria-label')).not.toContain('warning');
  });

  it('renders campaign activity primitives as independently reusable elements', () => {
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [
          { campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'campaign-inventory-warnings': 2 },
          { campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'campaign-inventory-warnings': 2 }
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
          { campaign: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' }
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

    const utilization = renderUiElement('campaign-utilization', {
      pageId: 'campaigns',
      title: 'Campaign AIC utilization',
      sourceNames: ['workflows', 'usage'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    const trend = renderUiElement('campaign-run-trend', {
      pageId: 'campaigns',
      title: 'All runs over time',
      sourceNames: ['workflows', 'runs', 'outcomes'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });
    const summary = renderUiElement('campaign-summary-table', {
      pageId: 'campaigns',
      title: 'All output by campaign',
      sourceNames: ['workflows', 'usage', 'findings', 'outcomes', 'runs'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(utilization?.querySelector('.campaign-utilization-card')).not.toBeNull();
    expect(utilization?.textContent).toContain('10 of 100 AIC across 1 reported run');
    expect(trend?.querySelector('.campaign-chart-point')).not.toBeNull();
    expect(trend?.querySelector('h3')?.textContent).toBe('All runs over time');
    expect(summary?.querySelector('.campaign-summary-table')).not.toBeNull();
    expect(summary?.textContent).toContain('Daily Ops');
  });

  it('renders campaign-detail through the reusable campaign-route variant without relying on page identity', () => {
    const rendered = renderUiElement('campaign-detail', {
      pageId: 'totally-custom-campaign-page',
      title: 'Campaign workflows',
      sourceNames: ['workflows'],
      routeParameter: 'campaign',
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [{
            campaign: 'sample-campaign',
            'campaign-name': 'Sample Campaign',
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
      detail: { parameter: 'campaign', value: 'sample-campaign' }
    }));

    expect(rendered?.querySelector('.campaign-tabs [aria-current="page"]')?.textContent).toBe('Overview');
    expect(rendered?.querySelector('.campaign-tabs')?.textContent).toBe('OverviewInsightsWorkflowsRunsIssues');
  });

  it('renders the campaigns page shell through one declarative element composition', () => {
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [
          { campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily.md', 'workflow-role': 'orchestrator', 'rollout-mode': 'review', 'max-ai-credits': 100, 'campaign-inventory-warnings': 2 },
          { campaign: 'daily-ops', 'campaign-name': 'Daily Ops', 'campaign-icon': 'workflow', workflow: '.github/workflows/daily-worker.md', 'workflow-role': 'worker', 'rollout-mode': 'review', 'max-ai-credits': 150, 'campaign-inventory-warnings': 2 }
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
          { campaign: 'daily-ops', run: '1', 'run-conclusion': 'success', 'rollout-mode': 'review', 'published-at': '2026-08-28T10:00:00Z', 'observed-at': '2026-08-28T10:00:00Z' }
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

    const rendered = renderUiElement('campaign-activity-shell', {
      pageId: 'campaigns',
      title: 'Campaign activity',
      sourceNames: ['workflows', 'usage', 'runs', 'outcomes', 'findings'],
      sources,
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('.campaign-utilization-card')).not.toBeNull();
    expect(rendered?.querySelector('.campaign-chart-point')).not.toBeNull();
    expect(rendered?.querySelector('.campaign-summary-table')).not.toBeNull();
    expect(rendered?.querySelector('.campaign-mode-tabs')).not.toBeNull();
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

  it('renders workflow-route-page with declarative body selection', () => {
    const rendered = renderUiElement('workflow-route-page', {
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
