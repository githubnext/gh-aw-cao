// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { enableLazyViews } from '../../src/components/lazy-view.js';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { agentSmellNotifications } from '../../src/components/agent-marketplace-view.js';
import { primerStylesheet } from '../../src/styles.js';

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
  it('uses auto-fill to keep agent marketplace card widths stable when results shrink', () => {
    const styles = primerStylesheet();
    expect(styles).toContain(
      '.agent-marketplace-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 14px; }'
    );
    expect(styles).not.toContain(
      '.agent-marketplace-grid { display: grid; grid-template-columns: repeat(auto-fit,'
    );
  });

  it('does not classify blocked assignment state as an agent smell', () => {
    const notifications = agentSmellNotifications([], [{
      'agent-id': 'review-agent', 'agent-name': 'Review agent', 'agent-state': 'blocked',
      'work-item-id': 'githubnext/gh-aw:.github/workflows/review.md:run:42',
      'last-observed-at': new Date().toISOString()
    }]);

    expect(notifications).toHaveLength(0);
  });

  it('uses derived repository links for agent smell evidence', () => {
    const notifications = agentSmellNotifications([{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent',
      'repository-link': {
        relation: 'repository',
        href: 'https://ghe.example/github/mona-tools',
        label: 'View github/mona-tools'
      }
    }], [], [{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.lock.yml',
      'security-feature': 'threat-detection',
      'security-signal': 'Prompt injection',
      'security-status': 'detected'
    }]);

    expect(notifications[0]?.['evidence-link']?.href).toBe('https://ghe.example/github/mona-tools');
  });

  it.each([
    ['low', 'low', 3],
    ['medium', 'medium', 2],
    ['high', 'high', 1]
  ])('preserves %s severity in agent smell notifications', (smellSeverity, consequenceTier, priority) => {
    const notifications = agentSmellNotifications([{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent'
    }], [], [], [{
      organization: 'github', repository: 'mona-tools',
      workflow: '.github/workflows/upgrade.lock.yml',
      'smell-id': 'partially-reducible', 'smell-name': 'Partially reducible',
      'smell-severity': smellSeverity
    }]);

    expect(notifications[0]?.['consequence-tier']).toBe(consequenceTier);
    expect(notifications[0]?.priority).toBe(priority);
  });

  it('renders structured smell observations on matching agents', () => {
    const rendered = renderUiElement('agent-marketplace-view', {
      pageId: 'agents',
      title: 'Agents',
      description: 'Marketplace-style agent catalog.',
      sourceNames: ['workflows', 'agent-smells'],
      sources: {
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'github', repository: 'mona-tools', package: 'standalone',
            workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent',
            'workflow-role': 'standalone', 'workflow-active': 'true'
          }],
          metadata
        },
        'agent-smells': {
          source: 'agent-smells',
          rows: [{
            organization: 'github', repository: 'mona-tools', workflow: '.github/workflows/upgrade.lock.yml',
            'smell-id': 'overkill-for-agentic', 'smell-name': 'Agent by default',
            'smell-category': 'design', 'smell-severity': 'medium',
            'smell-summary': 'Deterministic automation would be simpler.'
          }],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelector('.agent-badge-smell')?.getAttribute('title'))
      .toContain('Agent by default: Deterministic automation would be simpler.');
    expect(rendered?.querySelector('.agent-icon-smell')).toBeNull();
    expect(rendered?.querySelector('[aria-label="Filter operations by status"]')?.textContent).toContain('Smells (1)');
  });

  it('renders marketplace agent tiles with details, health badges, and sorting', () => {
    const rendered = renderUiElement('agent-marketplace-view', {
      pageId: 'agents',
      title: 'Agents',
      description: 'Marketplace-style agent catalog.',
      sourceNames: ['agent-assignments'],
      sources: {
        'agent-assignments': {
          source: 'agent-assignments',
          rows: [
            {
              'agent-id': 'slow',
              'agent-name': 'Zeta Agent',
              'agent-icon': 'robot',
              'agent-description': 'Runs release automation.',
              permissions: 'contents: read',
              'agent-state': 'active',
              'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/release.md:run:3',
              'run-count': 3,
              'total-runtime-seconds': 5400,
              'last-observed-at': '2026-08-30T09:00:00Z'
            },
            {
              'agent-id': 'fast',
              'agent-name': 'Alpha Agent',
              'agent-icon': 'copilot',
              'agent-description': 'Reviews pull requests.',
              permissions: 'pull-requests: write',
              'agent-state': 'completed',
              'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/review.md:run:1',
              'run-count': 1,
              'total-runtime-seconds': 60,
              'last-observed-at': '2026-08-30T09:00:00Z'
            }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(2);
    expect(rendered?.querySelector('.agent-marketplace-tile')?.textContent).toContain('Slow');
    expect(rendered?.querySelector('[data-facet="smells"]')).toBeNull();
    const statusFilter = rendered?.querySelector('[aria-label="Filter operations by status"]');
    expect(statusFilter?.textContent).toBe('All statusesSmells (0)Disabled (0)Slow (1)Stale (2)');
    if (statusFilter instanceof HTMLSelectElement) {
      statusFilter.value = 'slow';
      statusFilter.dispatchEvent(new Event('change'));
    }
    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(1);
    expect(rendered?.querySelector('.agent-marketplace-title')?.textContent).toBe('Zeta Agent');
    if (statusFilter instanceof HTMLSelectElement) {
      statusFilter.value = 'all';
      statusFilter.dispatchEvent(new Event('change'));
    }
    expect(rendered?.querySelector('[aria-label^="Agent smells:"]')).toBeNull();
    expect(rendered?.textContent).toContain('Runs release automation.');
    expect(rendered?.querySelector('[aria-label="View Zeta Agent"]')?.getAttribute('href')).toContain('#page-workflow-runtime?workflow=');
    const select = rendered?.querySelector('[aria-label="Sort operations"]');
    expect(select).not.toBeNull();
    if (select instanceof HTMLSelectElement) {
      select.value = 'name';
      select.dispatchEvent(new Event('change'));
    }
    expect(rendered?.querySelector('.agent-marketplace-title')?.textContent).toBe('Alpha Agent');
  });

  it('populates the agent marketplace from package and standalone workflow inventory', () => {
    const rendered = renderUiElement('agent-marketplace-view', {
      pageId: 'agents',
      title: 'Agents',
      sourceNames: ['agent-assignments', 'workflows'],
      sources: {
        'agent-assignments': { source: 'agent-assignments', rows: [], metadata },
        workflows: {
          source: 'workflows',
          rows: [
            {
              organization: 'githubnext', repository: 'gh-aw-cao', package: 'aw-doctor',
              'package-name': 'AW Doctor', 'package-icon': 'gear', 'workflow-role': 'orchestrator',
              workflow: '.github/workflows/aw-doctor.md', 'workflow-name': 'AW Doctor', 'workflow-active': 'true',
              'inventory-ready': true, 'package-rollout-percent': 100
            },
            {
              organization: 'githubnext', repository: 'gh-aw-cao', package: 'aw-doctor',
              'package-name': 'AW Doctor', 'package-icon': 'gear', 'workflow-role': 'worker',
              workflow: '.github/workflows/aw-doctor-failures.md', 'workflow-name': 'AW Doctor / Failures', 'workflow-active': 'true'
            },
            {
              organization: 'githubnext', repository: 'gh-aw-cao', 'workflow-role': 'standalone',
              workflow: '.github/workflows/activity.md', 'workflow-name': 'CAO Activity', 'workflow-active': 'true'
            }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(1);
    expect(rendered?.textContent).toContain('AW Doctor');
    expect(rendered?.textContent).toContain('Package');
    expect(rendered?.textContent).toContain('Standalone');
    expect(rendered?.querySelector('[aria-label="Featured"]')).toBeNull();
    expect(rendered?.textContent).not.toContain('available');
    expect(rendered?.querySelector('[aria-label="Agent status legend"]')).toBeNull();
    expect(rendered?.querySelector('[aria-label="Filter operations by owner"]')?.textContent).toContain('githubnext/gh-aw-cao');
    const agentFilters = rendered?.querySelector('[aria-label="Operation catalog filters"]');
    expect(agentFilters).not.toBeNull();
    expect(agentFilters?.textContent ?? '').toBe('Operation packages1Standalone workflows1All entries2');
    expect(rendered?.querySelector('.agent-marketplace-owner')?.textContent).toBe('githubnext/gh-aw-cao');
    expect(rendered?.querySelector('[aria-label="View AW Doctor"]')?.getAttribute('href')).toBe('#page-package-detail?package=aw-doctor');
    const packageFacet = rendered?.querySelector('[data-facet="package"]');
    expect(packageFacet).not.toBeNull();
    expect(packageFacet?.getAttribute('aria-current')).toBe('page');
    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(1);
    const allFacet = rendered?.querySelector('[data-facet="all"]');
    if (allFacet instanceof HTMLButtonElement) allFacet.click();
    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(2);
    expect(rendered?.textContent).toContain('CAO Activity');
  });

  it('shows descriptions on card faces and filters path-like agent names', () => {
    const rendered = renderUiElement('agent-marketplace-view', {
      pageId: 'agents', title: 'Agents', description: 'Agent inventory.',
      sourceNames: ['agent-assignments'],
      sources: {
        'agent-assignments': {
          source: 'agent-assignments', metadata,
          rows: [
            { 'agent-id': 'valid', 'agent-name': 'Review assistant', 'agent-description': 'Reviews changes before merge.' },
            { 'agent-id': 'absolute-path', 'agent-name': '/tmp/review-agent.md', 'agent-description': 'Invalid absolute path.' },
            { 'agent-id': 'workflow-path', 'agent-name': '.github/workflows/review.md', 'agent-description': 'Invalid workflow path.' },
            { 'agent-id': 'bracketed', 'agent-name': '[aw] Failure Investigator', 'agent-description': 'Invalid bracketed name.' },
            { 'agent-id': 'numbered', 'agent-name': '1. List all packages', 'agent-description': 'Invalid numbered instruction.' }
          ]
        }
      },
      contextDetails: [], headingTag: 'h3'
    });

    expect(rendered?.querySelectorAll('.agent-marketplace-tile')).toHaveLength(1);
    expect(rendered?.querySelector('.agent-marketplace-title')?.textContent).toBe('Review assistant');
    expect(rendered?.querySelector('.agent-marketplace-summary .agent-marketplace-description')?.textContent).toBe('Reviews changes before merge.');
    expect(rendered?.querySelector('.agent-marketplace-count')?.textContent).toBe('1 of 1 entries');
    expect(rendered?.textContent).not.toContain('/tmp/review-agent.md');
    expect(rendered?.textContent).not.toContain('.github/workflows/review.md');
    expect(rendered?.textContent).not.toContain('[aw] Failure Investigator');
    expect(rendered?.textContent).not.toContain('1. List all packages');
  });

  it('composes operational value, outcomes, cost, runtime, security, and experiments in Insights', () => {
    /** @param {Array<Record<string, unknown>>} rows */
    const source = (rows) => ({ source: 'fixture', rows, metadata });
    const rendered = renderUiElement('insights-overview', {
      pageId: 'insights', title: 'Insights', description: 'Operational impact.',
      sourceNames: ['operational-values', 'outcomes', 'usage', 'runs', 'detection-observations', 'experiments'],
      sources: {
        'operational-values': source([
          { 'operational-value': 0.6, 'operational-value-definition': 'Accepted change', 'maturity-status': 'matured', 'observed-at': '2026-08-29T10:00:00Z' },
          { 'operational-value': 0.8, 'operational-value-definition': 'Accepted change', 'maturity-status': 'matured', 'observed-at': '2026-08-30T10:00:00Z' },
          { 'operational-value': 0.5, 'operational-value-definition': 'Issue resolved', 'maturity-status': 'matured', 'observed-at': '2026-08-29T10:00:00Z' },
          { 'operational-value': 0.9, 'operational-value-definition': 'Issue resolved', 'maturity-status': 'matured', 'observed-at': '2026-08-30T10:00:00Z' }
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
      contextDetails: [], headingTag: 'h3'
    });
    if (rendered) enableLazyViews(rendered);

    expect(rendered?.querySelector('#insights-value-title')?.textContent).toBe('Operational value attainment');
    expect(rendered?.querySelectorAll('.insights-lead-metrics dd')[0]?.textContent).toBe('70%');
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

  it('renders the routed Work roadmap as a Projects-style timeline', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'work-roadmap',
      title: 'Roadmap',
      description: 'GitHub Projects-style work planning view.',
      sourceNames: ['work-items'],
      sources: {
        'work-items': {
          source: 'work-items',
          rows: [
            {
              'work-item-id': 'github/gh-aw:.github/workflows/dependabot.md',
              name: 'Dependabot release train',
              'workflow-name': 'Dependabot release train',
              'workflow-icon': 'dependabot',
              package: 'dependabot',
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
              package: 'security-review',
              scope: 'github/mona-tools',
              owner: 'security',
              'lifecycle-state': 'review',
              'started-at': '2026-08-30T10:00:00Z'
            }
          ],
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
    expect(rendered?.querySelector('.work-avatar .octicon-dependabot')).not.toBeNull();
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
    const stateFilter = filterBar?.querySelector('[aria-label="Filter by state"]');
    expect(filterBar?.querySelector('[aria-label="Filter by package"]')?.textContent).toContain('dependabot');
    if (!(stateFilter instanceof HTMLSelectElement)) throw new Error('state filter did not render');
    stateFilter.value = 'Needs Review';
    stateFilter.dispatchEvent(new Event('change'));
    expect(rendered?.querySelectorAll('.work-roadmap-lane')).toHaveLength(1);
    expect(rendered?.querySelector('.work-roadmap-lane')?.textContent).toContain('Review security posture');
    expect(filterBar?.querySelector('.work-filter-count')?.textContent).toBe('1 of 2');

    const search = filterBar?.querySelector('[aria-label="Filter work items"]');
    if (!(search instanceof HTMLInputElement)) throw new Error('work search did not render');
    search.value = 'missing workflow';
    search.dispatchEvent(new Event('input'));
    expect(rendered?.textContent).toContain('No work items match the current filters.');

    const clear = filterBar?.querySelector('[aria-label="Clear work filters"]');
    if (!(clear instanceof HTMLButtonElement)) throw new Error('clear filters button did not render');
    clear.click();
    expect(search.value).toBe('');
    expect(stateFilter.value).toBe('');
    expect(rendered?.querySelectorAll('.work-roadmap-lane')).toHaveLength(2);
    expect(filterBar?.querySelector('.work-filter-count')?.textContent).toBe('2 of 2');
  });

  it('renders a single declarative work slice when config.body selects one', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'insights',
      title: 'Tasks',
      sourceNames: ['work-items'],
      sources: {
        'work-items': {
          source: 'work-items',
          rows: [{
            'work-item-id': 'github/gh-aw:.github/workflows/dependabot.md',
            'workflow-name': 'Dependabot release train',
            scope: 'github/gh-aw',
            owner: 'dependency-automation',
            'lifecycle-state': 'active',
            'started-at': '2026-08-30T09:00:00Z'
          }],
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

  it('groups packages in Board while keeping every Tasks and Roadmap item visible', () => {
    const rows = [
      {
        'work-item-id': 'daily-ops:orchestrator',
        'workflow-name': 'Daily Ops',
        package: 'daily-ops',
        'work-type': 'orchestrator',
        scope: 'githubnext/gh-aw-cao',
        'lifecycle-state': 'active',
        'started-at': '2026-09-06T08:00:00Z'
      },
      {
        'work-item-id': 'daily-ops:worker',
        'workflow-name': 'Daily Ops worker',
        package: 'daily-ops',
        'work-type': 'worker',
        scope: 'githubnext/gh-aw-cao',
        'lifecycle-state': 'active',
        'started-at': '2026-09-06T08:05:00Z'
      }
    ];
    /** @param {'board'|'tasks'|'roadmap'} body */
    const render = (body) => renderUiElement('work-project-view', {
      pageId: `work-${body}`,
      title: body,
      sourceNames: ['work-items'],
      sources: { 'work-items': { source: 'work-items', rows, metadata } },
      elementConfig: { body },
      contextDetails: [],
      headingTag: 'h3'
    });

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
    expect([...(tasks?.querySelectorAll('.work-task-type') ?? [])].map((cell) => cell.textContent)).toEqual(['worker', 'orchestrator']);

    const roadmap = render('roadmap');
    expect(roadmap?.querySelector('.work-roadmap-group')).toBeNull();
    expect(roadmap?.querySelectorAll('.work-roadmap-lane')).toHaveLength(2);
  });

  it('renders inferred Work timestamps as point observations instead of running intervals', () => {
    const rendered = renderUiElement('work-project-view', {
      pageId: 'work-roadmap',
      title: 'Roadmap',
      sourceNames: ['work-items'],
      sources: {
        'work-items': {
          source: 'work-items',
          rows: [{
            'work-item-id': 'aw-doctor:inventory',
            'workflow-name': 'AW Doctor',
            scope: 'githubnext/gh-aw-cao',
            'lifecycle-state': 'unknown',
            'reason-evidence-class': 'inferred',
            'observed-at': '2026-09-07T05:23:02Z'
          }],
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
    localStorage.clear();
    const rendered = renderUiElement('signal-list', {
      pageId: 'overview',
      title: 'Need attention',
      description: 'Unresolved conditions that require an authorized person to act or investigate.',
      sourceNames: ['attention-signals', 'workflows', 'agent-assignments', 'agent-smells', 'workflow-smells', 'security-findings', 'control-plane-smells', 'security-observations', 'runs'],
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
        },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'github', repository: 'mona-tools', 'workflow-role': 'standalone',
            workflow: '.github/workflows/upgrade.md', 'workflow-name': 'Upgrade agent', 'workflow-active': 'true'
          }],
          metadata
        },
        'agent-assignments': {
          source: 'agent-assignments',
          rows: [{
            'agent-id': 'upgrade-agent', 'agent-name': 'Upgrade agent', 'agent-state': 'blocked',
            'work-item-id': 'github/mona-tools:.github/workflows/upgrade.md:run:42',
            'run-count': 1, 'total-runtime-seconds': 2400, stale: true,
            'last-observed-at': new Date(Date.now() - 90_000).toISOString()
          }],
          metadata
        },
        'security-observations': {
          source: 'security-observations',
          rows: [{
            organization: 'github', repository: 'mona-tools',
            workflow: '.github/workflows/upgrade.lock.yml',
            'security-feature': 'threat-detection', 'security-analysis': 'summary',
            'security-signal': 'Prompt injection', 'security-status': 'detected'
          }],
          metadata
        },
        'agent-smells': {
          source: 'agent-smells',
          rows: [{
            'smell-observation-id': 'agent:42:partially-reducible',
            'smell-id': 'partially-reducible', 'smell-name': 'Partially reducible',
            'smell-summary': 'Half of the turns could be deterministic.',
            organization: 'github', repository: 'mona-tools', workflow: '.github/workflows/upgrade.md',
            'observed-at': new Date(Date.now() - 60_000).toISOString()
          }],
          metadata
        },
        'workflow-smells': {
          source: 'workflow-smells',
          rows: [{
            'smell-observation-id': 'workflow:upgrade:strict-disabled',
            'smell-id': 'strict-disabled', 'smell-name': 'Strict mode disabled',
            'smell-summary': 'Workflow validation is not fail-closed.',
            organization: 'github', repository: 'mona-tools', workflow: '.github/workflows/upgrade.md',
            'workflow-link': {
              relation: 'workflow', href: 'https://github.com/github/mona-tools/actions/workflows/upgrade.yml', label: 'View workflow'
            },
            'observed-at': new Date(Date.now() - 120_000).toISOString()
          }],
          metadata
        },
        'security-findings': {
          source: 'security-findings',
          rows: [{
            'smell-observation-id': 'security:42:prompt-injection',
            'smell-id': 'threat-detection-prompt-injection', 'smell-name': 'Prompt injection detected',
            'smell-summary': 'Threat detection reported unsafe behavior.',
            organization: 'github', repository: 'mona-tools', workflow: '.github/workflows/upgrade.md',
            'observed-at': new Date(Date.now() - 180_000).toISOString()
          }],
          metadata
        },
        'control-plane-smells': {
          source: 'control-plane-smells',
          rows: [{
            'smell-observation-id': 'control:upgrade:inventory-incomplete',
            'smell-id': 'inventory-incomplete', 'smell-name': 'Package inventory incomplete',
            'smell-summary': 'Declared package workers are missing.',
            organization: 'github', repository: 'mona-tools', workflow: '.github/workflows/upgrade.md',
            'observed-at': new Date(Date.now() - 240_000).toISOString()
          }],
          metadata
        },
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'started-at': '2026-08-29T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' },
            { run: '2', 'started-at': '2026-08-30T10:00:00Z', 'run-status': 'in_progress', 'run-conclusion': null }
          ],
          metadata
        }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.classList.contains('notifications-inbox')).toBe(true);
    expect(rendered?.firstElementChild?.classList.contains('notifications-health')).toBe(true);
    expect(rendered?.querySelector('.home-catchup')?.getAttribute('aria-label')).toBe('Catch-up briefing');
    expect(rendered?.textContent).not.toContain('Your catch-up');
    expect(rendered?.textContent).not.toContain("Here's what changed while you were away");
    expect(rendered?.lastElementChild?.classList.contains('notifications-main')).toBe(true);
    expect(rendered?.querySelector('.view-metadata-summary')).toBeNull();
    expect(rendered?.querySelectorAll('.canonical-attention-item')).toHaveLength(6);
    expect(/** @type {HTMLInputElement | null} */ (rendered?.querySelector('.notifications-search input'))?.value).toBe('is:unread');
    expect(rendered?.querySelector('[aria-label="Sort notifications"]')).not.toBeNull();
    expect(rendered?.querySelector('[aria-label="Group notifications"]')).not.toBeNull();
    expect(/** @type {HTMLSelectElement | null} */ (rendered?.querySelector('[aria-label="Group notifications"]'))?.value).toBe('cause');
    const notificationFilterToggle = /** @type {HTMLButtonElement | null} */ (rendered?.querySelector('.notifications-filter-toggle'));
    expect(notificationFilterToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(rendered?.querySelector('.notifications-advanced-filters')?.classList.contains('is-expanded')).toBe(false);
    notificationFilterToggle?.click();
    expect(notificationFilterToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(rendered?.querySelector('.notifications-advanced-filters')?.classList.contains('is-expanded')).toBe(true);
    expect(rendered?.querySelector('.notifications-sidebar')).toBeNull();
    expect(rendered?.textContent).toContain('Upgrade agentic workflow dependencies');
    expect(rendered?.textContent).toContain('github/mona-tools');
    expect(rendered?.textContent).toContain('repository-owner2h 30m ago');
    expect(rendered?.textContent).toContain('Agent smell: Upgrade agent');
    expect(rendered?.textContent).toContain('Partially reducible');
    expect(rendered?.textContent).toContain('Strict mode disabled');
    const workflowSmell = [...(rendered?.querySelectorAll('.notification-item') ?? [])]
      .find((item) => item.textContent?.includes('Strict mode disabled'));
    expect(workflowSmell?.querySelector('[href^="#page-workflow-runtime"]')?.getAttribute('href'))
      .toBe('#page-workflow-runtime?workflow=github%2Fmona-tools%3A.github%2Fworkflows%2Fupgrade.md');
    expect(rendered?.textContent).toContain('Prompt injection detected');
    expect(rendered?.textContent).toContain('Package inventory incomplete');
    expect(rendered?.querySelector('.home-origin-agents .octicon-copilot')).not.toBeNull();
    expect(rendered?.querySelector('.home-catchup-stories .home-origin-agents')).not.toBeNull();
    expect(rendered?.textContent).toContain('Operations');
    expect(rendered?.textContent).toContain('Work');

    const dependabotNotification = [...(rendered?.querySelectorAll('.notification-item') ?? [])]
      .find((item) => item.textContent?.includes('Update the Dependabot release train'));
    const save = /** @type {HTMLButtonElement | null} */ (dependabotNotification?.querySelector('[aria-label="Save"]') ?? null);
    save?.click();
    const notificationSearch = /** @type {HTMLInputElement | null} */ (rendered?.querySelector('.notifications-search input'));
    if (notificationSearch) {
      notificationSearch.value = 'is:saved';
      notificationSearch.dispatchEvent(new Event('input'));
    }
    expect(rendered?.querySelectorAll('.canonical-attention-item')).toHaveLength(1);
    expect(rendered?.textContent).toContain('Update the Dependabot release train');
    localStorage.clear();
  });

  it('clusters repeated notification causes while leaving unique notifications visible', () => {
    localStorage.clear();
    /** @param {string} id @param {string} scope */
    const repeated = (id, scope) => ({
      'attention-signal-id': id, 'signal-type': 'workflow-output', objective: 'Daily scan', scope,
      reason: 'Workflow completed with no safe outputs', 'consequence-tier': 'medium', priority: 3,
      'age-seconds': 60
    });
    const rendered = renderUiElement('signal-list', {
      pageId: 'overview', title: 'Notifications', sourceNames: ['attention-signals'],
      sources: {
        'attention-signals': {
          source: 'attention-signals',
          rows: [
            repeated('repeat:1', 'github/one'), repeated('repeat:2', 'github/two'),
            { 'attention-signal-id': 'unique', 'signal-type': 'authority-gate', objective: 'Confirm authority', scope: 'github/three', reason: 'Authority missing', 'consequence-tier': 'medium', priority: 2, 'age-seconds': 30 }
          ],
          metadata
        }
      },
      contextDetails: [], headingTag: 'h3'
    });

    expect(rendered?.querySelectorAll('.notifications-cause-cluster')).toHaveLength(1);
    expect(rendered?.querySelector('.notifications-cause-summary')?.textContent).toContain('2 occurrences across 2 repositories');
    const cluster = /** @type {HTMLDetailsElement | null} */ (rendered?.querySelector('.notifications-cause-cluster') ?? null);
    expect(cluster?.open).toBe(false);
    expect(rendered?.querySelector('.notifications-priority-group')?.textContent).toContain('Confirm authority');
    expect(rendered?.querySelectorAll('.notification-item')).toHaveLength(1);
    if (cluster) {
      cluster.open = true;
      cluster.dispatchEvent(new Event('toggle'));
    }
    expect(rendered?.querySelectorAll('.notification-item')).toHaveLength(3);
  });

  it('leads a clear Home page with a catch-up briefing', () => {
    localStorage.clear();
    const rendered = renderUiElement('signal-list', {
      pageId: 'overview', title: 'Notifications', sourceNames: ['attention-signals', 'runs'],
      sources: {
        'attention-signals': { source: 'attention-signals', rows: [], metadata },
        runs: {
          source: 'runs',
          rows: [
            { run: '1', 'started-at': '2026-08-29T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' },
            { run: '2', 'started-at': '2026-08-30T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' }
          ],
          metadata
        }
      },
      contextDetails: [], headingTag: 'h3'
    });

    expect(rendered?.firstElementChild?.classList.contains('notifications-health')).toBe(true);
    expect(rendered?.querySelector('#notifications-health-title')).toBeNull();
    expect(rendered?.querySelector('[aria-label="Catch-up interval"]')).not.toBeNull();
    expect(rendered?.querySelector('.home-momentum-chart')?.getAttribute('aria-label')).toContain('0 delivered outcomes');
    expect(rendered?.querySelector('.home-origin-work')).not.toBeNull();
    expect(rendered?.lastElementChild?.classList.contains('notifications-main')).toBe(true);
  });

  it('keeps the clear inbox available when catch-up evidence is unavailable', () => {
    const rendered = renderUiElement('signal-list', {
      pageId: 'overview',
      title: 'Need attention',
      description: 'Unresolved conditions that require an authorized person to act or investigate.',
      sourceNames: ['attention-signals'],
      sources: {
        'attention-signals': { source: 'attention-signals', rows: [], metadata }
      },
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered?.classList.contains('notifications-inbox')).toBe(true);
    expect(rendered?.classList.contains('is-clear')).toBe(true);
    expect(rendered?.firstElementChild?.classList.contains('notifications-health')).toBe(true);
    expect(rendered?.querySelector('#notifications-health-title')).toBeNull();
    expect(rendered?.textContent).toContain('No meaningful state changes were observed');
    expect(rendered?.querySelector('.notifications-empty')?.textContent).toBe('All caught up');
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
