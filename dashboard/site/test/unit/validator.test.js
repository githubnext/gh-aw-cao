import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDashboardDocument, validateLogicalSources } from '../../src/validator.js';
import { DASHBOARD_QUERY_LIMITS, QUERY_MAX_JOINS } from '../../src/specification.js';
import { packageDashboardSources } from '../package-dashboard-documents.js';

const authoritativeDashboardSource = readFileSync(`${process.cwd()}/dashboard.json`, 'utf8');

const validDocument = `language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  defaults:
    scope: {}
    time: {}
    filters: {}
  pages:
    - id: usage
      kind: built-in
      page: usage
      title: Usage
    - id: custom-summary
      kind: custom
      title: Custom Summary
      views:
        - id: run-count
          data:
            source: runs
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`;

describe('dashboard document validation', () => {
  it('accepts the authoritative built-in overview view definition', () => {
    const accepted = validateDashboardDocument(authoritativeDashboardSource);
    expect(accepted.ok).toBe(true);
  });

  it('accepts only explicit gh aw CLI actions', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    document.dashboard['cli-actions'].push({
      id: 'compile-workflows',
      label: 'Compile workflows',
      description: 'Validate editable workflow sources.',
      icon: 'play',
      command: 'gh aw compile --strict --no-emit',
      placement: 'settings',
      arguments: [{
        id: 'pre-releases',
        label: 'Include pre-releases',
        type: 'boolean',
        flag: '--pre-releases',
        default: false
      }]
    });
    const addedAction = document.dashboard['cli-actions'][document.dashboard['cli-actions'].length - 1];
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    addedAction.command = 'gh api user';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'CLI action command must start with "gh aw".' })
    ]));

    addedAction.command = 'gh aw compile; echo unsafe';
    const shellControlOperator = validateDashboardDocument(JSON.stringify(document));
    expect(shellControlOperator.ok).toBe(false);
    expect(shellControlOperator.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'CLI action command must not contain shell control operators.' })
    ]));

    addedAction.command = 'gh aw compile !!';
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'CLI action command must not contain shell control operators.' })
      ])
    });

    addedAction.command = 'gh aw upgrade';
    addedAction.arguments[0].flag = '$(whoami)';
    const invalidFlag = validateDashboardDocument(JSON.stringify(document));
    expect(invalidFlag.ok).toBe(false);
    expect(invalidFlag.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'CLI action argument flag must be a canonical long option.' })
    ]));
  });

  it('validates row-scoped CLI action templates and list references', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const maintenancePage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'maintenance'
    );
    const action = document.dashboard['cli-actions'].find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'upgrade-target-repository'
    );
    const listAction = maintenancePage.views[1].encoding.actions[0];

    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    action.placement = 'settings';
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: 'cli-action must reference a row-placed dashboard CLI action.'
        })
      ])
    });
    action.placement = 'row';

    listAction.context = [];
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: 'action context must be a non-empty sequence of source fields.'
        })
      ])
    });
    listAction.context = ['repository'];

    action.command = 'gh aw upgrade --repo {{ repository }}';
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: 'CLI action command contains an invalid template token.'
        })
      ])
    });
  });

  it('keeps package updates exclusively in the Maintenance list', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const action = document.dashboard['cli-actions'].find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'update-package'
    );
    const packagesPage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'packages'
    );
    const maintenancePage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'maintenance'
    );
    const listAction = maintenancePage.views[0].encoding.actions[0];

    expect(action).toMatchObject({
      command: 'gh aw update {{package}}',
      placement: 'row'
    });
    expect(document.dashboard['cli-actions'].some(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'update-target-repository'
    )).toBe(false);
    expect(packagesPage.definition.views[0].encoding.actions).toBeUndefined();
    expect(listAction).toMatchObject({
      action: 'update-package',
      presentation: 'cli-action',
      context: ['package']
    });
  });

  it('validates declarative card lists and their view actions', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const maintenancePage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'maintenance'
    );
    const starterList = maintenancePage.views[0];
    const viewAction = document.dashboard['cli-actions'].find(
      (/** @type {{ id: string }} */ action) => action.id === starterList.list.action
    );

    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    starterList.list.style = 'rows';
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'list.style must be "cards".' })
      ])
    });
    starterList.list.style = 'cards';

    const columns = starterList.encoding.columns;
    starterList.encoding.columns = [];
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: 'list views must encode a non-empty columns sequence.'
        })
      ])
    });
    starterList.encoding.columns = columns;

    viewAction.placement = 'row';
    expect(validateDashboardDocument(JSON.stringify(document))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: 'list.action must reference a view-placed dashboard CLI action.'
        })
      ])
    });
  });

  it('applies human-friendly formatting to every declarative temporal encoding', () => {
    const documents = [authoritativeDashboardSource, ...packageDashboardSources].map((source) => JSON.parse(source));
    /** @type {Array<Record<string, unknown>>} */
    const temporalFields = [];
    const visit = (/** @type {unknown} */ value) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object') {
        if (/** @type {Record<string, unknown>} */ (value).type === 'temporal') {
          temporalFields.push(/** @type {Record<string, unknown>} */ (value));
        }
        Object.values(/** @type {Record<string, unknown>} */ (value)).forEach(visit);
      }
    };
    documents.forEach((document) => visit(document.dashboard.pages));

    expect(temporalFields.length).toBeGreaterThan(38);
    expect(temporalFields.every((field) => field.format === 'human-friendly-timestamp')).toBe(true);
  });

  it('defines Overview child pages with exact attention filters and GitHub evidence links', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const pages = Object.fromEntries(document.dashboard.pages.map(
      (/** @type {{ id: string }} */ page) => [page.id, page]
    ));

    for (const pageId of [
      'overview-failed-runs',
      'overview-blocked-work',
      'overview-awaiting-review',
      'overview-security-findings'
    ]) {
      expect(pages[pageId].route).toEqual({ 'navigation-page': 'overview' });
      expect(pages[pageId].views).toHaveLength(1);
      expect(pages[pageId].views[0].mark).toBe('table');
      expect(pages[pageId].views[0].layout).toBe('full-view');
      expect(pages[pageId].views[0]['column-summaries']).toBe(true);
    }

    expect(pages['overview-failed-runs'].views[0]).toMatchObject({
      data: { source: 'failed-runs', filters: { 'run-conclusion': ['failure', 'startup-failure', 'stale', 'timed-out'] } },
      encoding: {
        columns: [
          { field: 'started-at', type: 'temporal', title: 'Date' },
          { field: 'repository', type: 'nominal', title: 'Repository' },
          { field: 'failure-detail', type: 'nominal', title: 'Error', display: 'run-link' }
        ]
      }
    });
    expect(pages['overview-failed-runs'].views[0].encoding.href).toBeUndefined();
    expect(pages['overview-blocked-work'].views[0]).toMatchObject({
      data: { source: 'work-items', filters: { 'lifecycle-state': 'blocked' } },
      encoding: {
        columns: [
          { field: 'waiting-since', type: 'temporal', title: 'Date' },
          { field: 'repository', type: 'nominal', title: 'Repository' },
          { field: 'reason', type: 'nominal', title: 'Blocked by', display: 'run-link' }
        ]
      }
    });
    expect(pages['overview-blocked-work'].views[0].encoding.href).toBeUndefined();
    expect(pages['overview-awaiting-review'].views[0]).toMatchObject({
      data: { source: 'work-items', filters: { 'lifecycle-state': 'review' } },
      encoding: {
        columns: [
          { field: 'waiting-since', type: 'temporal', title: 'Date' },
          { field: 'repository', type: 'nominal', title: 'Repository' },
          { field: 'objective', type: 'nominal', title: 'Work', display: 'evidence-link' }
        ]
      }
    });
    expect(pages['overview-awaiting-review'].views[0].encoding.href).toBeUndefined();
    expect(pages['overview-security-findings'].views[0]).toMatchObject({
      data: { source: 'security-findings' },
      encoding: {
        columns: [
          { field: 'observed-at', type: 'temporal', title: 'Date' },
          { field: 'repository', type: 'nominal', title: 'Repository' },
          { field: 'smell-name', type: 'nominal', title: 'Finding', display: 'run-link' }
        ]
      }
    });
    expect(pages['overview-security-findings'].views[0].encoding.href).toBeUndefined();
  });

  it('accepts the GitHub API full-view lazy-list table', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const apiPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'github-api');

    expect(apiPage.views).toEqual([
      expect.objectContaining({
        id: 'github-api-observations',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view'
      })
    ]);
    expect(apiPage.views[0].data).toMatchObject({
      source: 'github-api-events'
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines every other editable experimental page as one full-view lazy table', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const experimentalIds = new Set(document.dashboard.navigation
      .filter((/** @type {{ experimental?: boolean }} */ section) => section.experimental)
      .flatMap((/** @type {{ pages: string[] }} */ section) => section.pages));

    for (const page of document.dashboard.pages.filter(
      (/** @type {{ id: string }} */ candidate) => experimentalIds.has(candidate.id)
    )) {
      if (page.id === 'safe-outputs' || page.id === 'maintenance') continue;
      const definition = page.definition ?? page;
      const editableViews = (definition.views ?? []).filter(
        (/** @type {{ locked?: boolean }} */ view) => view.locked !== true
      );
      if (editableViews.length === 0) continue;
      expect(definition.sections, page.id).toBeUndefined();
      const primaryViews = editableViews.filter(
        (/** @type {{ disclosure?: string }} */ view) => view.disclosure !== 'supplemental'
      );
      expect(primaryViews, page.id).toHaveLength(1);
      for (const view of editableViews) {
        expect(view, page.id).toMatchObject({
          mark: 'table',
          controls: 'interactive',
          'lazy-list': true,
          layout: 'full-view'
        });
      }
    }
    expect(document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'maintenance'
    )?.views).toEqual([
      expect.objectContaining({
        id: 'starter-updates',
        mark: 'list',
        list: {
          style: 'cards',
          icon: 'package',
          action: 'update-repository'
        },
        layout: 'full'
      }),
      expect.objectContaining({
        id: 'compiler-upgrades',
        mark: 'list',
        list: {
          style: 'cards',
          icon: 'repo',
          action: 'upgrade-repository'
        },
        layout: 'full'
      })
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('accepts canonical route body values and rejects non-canonical config.body values', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const workflowRouteView = document.dashboard.pages.find((/** @type {{ id: string, views: Array<any> }} */ page) => page.id === 'workflow-detail')
      .views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-reports-route');

    expect(workflowRouteView).toMatchObject({
      mark: 'element',
      element: 'workflow-route-page',
      config: { body: 'reports' }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    workflowRouteView.config.body = 'report';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'workflow-route-page config.body must use one canonical route body value.' })
    ]));
  });

  it('defines firewall as one full-view lazy domain table', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const firewall = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'firewall');
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Data'
    ).pages).toContain('firewall');
    expect(firewall.sections).toBeUndefined();
    expect(firewall.views).toHaveLength(1);
    expect(document.dashboard.queries).toContainEqual(expect.objectContaining({
      name: 'firewall-domain-totals',
      intent: 'Show each observed firewall domain with the number of runs and total accepted and blocked requests.',
      from: 'firewall-observations',
      filter: { predicates: [{ field: 'decision', in: ['allowed', 'denied'] }] },
      aggregate: {
        by: ['domain'],
        values: [
          { field: 'run', as: 'run', reducer: 'distinct-count' },
          { field: 'accepted', as: 'accepted', reducer: 'sum' },
          { field: 'blocked', as: 'blocked', reducer: 'sum' }
        ]
      }
    }));
    const [domains] = firewall.views;
    expect(domains).toMatchObject({
      id: 'security-firewall-domains',
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      'column-summaries': true,
      layout: 'full-view',
      data: {
        source: 'firewall-domain-totals',
        'order-by': [
          { field: 'blocked', direction: 'desc' },
          { field: 'accepted', direction: 'desc' },
          { field: 'domain', direction: 'asc' }
        ]
      }
    });
    expect(domains.encoding.columns).toEqual([
      { field: 'domain', type: 'nominal' },
      { field: 'run', type: 'quantitative', title: 'Run' },
      { field: 'accepted', type: 'quantitative', title: 'Accepted' },
      { field: 'blocked', type: 'quantitative', title: 'Blocked' }
    ]);
    const serialized = JSON.stringify(firewall).toLowerCase();
    expect(serialized).not.toContain('blocked = failure');
    expect(serialized).not.toContain('allowed = safe');
    expect(serialized).not.toContain('risk score');
    expect(serialized).not.toContain('allow domain');
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines MCP diagnostics in a dedicated Data page', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const mcps = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'mcps');
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Data'
    ).pages).toContain('mcps');
    expect(mcps).toMatchObject({
      kind: 'custom',
      'navigation-label': 'MCPs',
      views: [
        {
          id: 'mcp-tool-inventory',
          mark: 'table',
          controls: 'interactive',
          'lazy-list': true,
          layout: 'full-view',
          data: {
            source: 'mcp-tool-activity'
          }
        }
      ]
    });
    expect(mcps.views).toHaveLength(1);
    expect(mcps.views[0].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field)).toEqual([
      'mcp-tool',
      'mcp-status',
      'repository',
      'workflow',
      'run',
      'observed-at'
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines detection results as a full-view lazy table in Explore', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const detection = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'detection');
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('detection');
    expect(detection.views).toHaveLength(1);
    expect(detection).not.toHaveProperty('sections');
    expect(detection.views[0]).toMatchObject({
      id: 'detection-results',
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      'column-summaries': true,
      layout: 'full-view',
      data: {
        source: 'detection-observations',
        'order-by': [
          { field: 'observed-at', direction: 'desc' }
        ]
      }
    });
    expect(detection.views[0].encoding.columns.map(
      (/** @type {{ field: string }} */ column) => column.field
    )).toEqual([
      'detection-state',
      'detection-signal',
      'inspection-warning',
      'job-status',
      'job-conclusion',
      'job-duration-seconds',
      'runner',
      'repository',
      'workflow',
      'run',
      'observed-at'
    ]);
    expect(detection.views[0].encoding.href).toEqual({ field: 'run-link', type: 'nominal' });
    expect(detection.views[0].encoding).not.toHaveProperty('actions');
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines Safe Outputs as one declarative full-view usage table in Explore', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const safeOutputs = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'safe-outputs');
    const safeOutputsQuery = document.dashboard.queries.find(
      (/** @type {{ name: string }} */ query) => query.name === 'safe-output-usage'
    );

    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('safe-outputs');
    expect(safeOutputs.views).toHaveLength(1);
    expect(safeOutputs.views[0]).toMatchObject({
      id: 'safe-output-usage',
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      'column-summaries': true,
      layout: 'full-view',
      data: { source: 'safe-output-usage' }
    });
    expect(safeOutputs.views[0].encoding.columns.map(
      (/** @type {{ field: string }} */ column) => column.field
    )).toEqual([
      'outcome-title',
      'safe-output',
      'safe-output-kind',
      'outcome-status',
      'outcome-state',
      'workflow',
      'repository',
      'rollout-mode',
      'run',
      'published-at',
      'observed-at'
    ]);
    expect(safeOutputs.views[0].encoding.href).toEqual({ field: 'external-link', type: 'nominal' });
    expect(safeOutputsQuery).toMatchObject({
      from: 'outcomes',
      select: expect.arrayContaining([
        { field: 'safe-output' },
        { field: 'safe-output-kind' },
        { field: 'external-link' },
        { field: 'run-link' }
      ]),
      'order-by': [
        { field: 'observed-at', direction: 'desc' },
        { field: 'safe-output', direction: 'asc' }
      ]
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('validates declarative table intents without author-defined context templating', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const runsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runs');
    const runsView = runsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runs-table');
    const detailsView = runsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-run-details');
    const runsPageIndex = document.dashboard.pages.indexOf(runsPage);
    expect(runsView).toMatchObject({
      description: expect.any(String),
      controls: 'static',
      encoding: {
        columns: [
          { field: 'run' },
          { field: 'run-status' },
          { field: 'run-conclusion' },
          { field: 'rollout-mode' }
        ]
      }
    });

    expect(detailsView).toMatchObject({
      disclosure: 'supplemental',
      controls: 'static',
      description: expect.any(String)
    });
    expect(detailsView.description).toContain('after the run-status table answers the current state');
    expect(detailsView.encoding.columns.map((/** @type {{ field: string }} */ column) => column.field)).toEqual([
      'run',
      'run-title',
      'event',
      'engine',
      'gh-aw-version',
      'requested-model',
      'resolved-model',
      'started-at',
      'ended-at'
    ]);
    expect(detailsView.encoding.actions).toEqual([{
      intent: 'Investigate this failed workflow run.',
      presentation: 'copy-prompt',
      icon: 'search',
      label: 'Investigate',
      context: [
        'run',
        'run-title',
        'repository',
        'workflow',
        'run-conclusion',
        'failure-job',
        'failure-message',
        'failure-step',
        'run-link'
      ],
      when: { field: 'run-conclusion', equals: 'failure' }
    }]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    detailsView.encoding.actions[0].presentation = 'copy-command';
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(false);
    detailsView.encoding.actions[0].presentation = 'copy-prompt';

    detailsView.encoding.actions[0].context.push('not-a-run-field');
    const invalidContext = validateDashboardDocument(JSON.stringify(document));
    expect(invalidContext.ok).toBe(false);
    if (!invalidContext.ok) {
      expect(invalidContext.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: `$.dashboard.pages[${runsPageIndex}].views[3].encoding.actions[0].context[9]`
      }));
    }
    detailsView.encoding.actions[0].context.pop();

    detailsView.encoding.actions[0].context.push('run');
    const duplicateContext = validateDashboardDocument(JSON.stringify(document));
    expect(duplicateContext.ok).toBe(false);
    if (!duplicateContext.ok) {
      expect(duplicateContext.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: `$.dashboard.pages[${runsPageIndex}].views[3].encoding.actions[0].context[9]`
      }));
    }
    detailsView.encoding.actions[0].context.pop();

    detailsView.encoding.actions[0].when.field = 'not-a-run-field';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: `$.dashboard.pages[${runsPageIndex}].views[3].encoding.actions[0].when.field`
      }));
    }
  });

  it('defines workflow route composition through a reusable workflow-route-page element', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const reportsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-detail');
    const runsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runs');
    const runtimePage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runtime');

    expect(reportsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-reports-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route-page',
      config: { body: 'reports' }
    });

    expect(runsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runs-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route-page',
      config: { body: 'runs' }
    });
    expect(runtimePage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runtime-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route-page',
      config: { body: 'insights' }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines the Runs table as a declarative query projection', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const query = document.dashboard.queries.find((/** @type {{ name: string }} */ candidate) =>
      candidate.name === 'runs-table'
    );
    const page = document.dashboard.pages.find((/** @type {{ id: string }} */ candidate) =>
      candidate.id === 'runs'
    );

    expect(query).toMatchObject({
      from: 'runs',
      select: expect.arrayContaining([
        { field: 'run' },
        { field: 'run-conclusion' },
        { field: 'started-at' },
        { field: 'run-link' }
      ]),
      'order-by': [{ field: 'started-at', direction: 'desc' }]
    });

    expect(page.definition.views.find((/** @type {{ id: string }} */ view) =>
      view.id === 'runs-runs-source'
    )).toMatchObject({
      data: { source: 'runs-table' },
      mark: 'table'
    });
    expect(page.definition.views.find((/** @type {{ id: string }} */ view) =>
      view.id === 'runs-last-week'
    )).toMatchObject({
      data: { source: 'runs-table', time: { range: '7d' } },
      mark: 'chart',
      chart: 'swimlane',
      encoding: {
        x: { field: 'started-at', type: 'temporal' },
        y: { field: 'run-conclusion', type: 'ordinal' }
      }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines Overview as one evidence-backed outcomes element', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const page = document.dashboard.pages.find((/** @type {{ id: string }} */ candidate) =>
      candidate.id === 'overview'
    );

    expect(page.views).toEqual([expect.objectContaining({
      id: 'overview-outcomes',
      data: { sources: expect.arrayContaining([
        'outcomes',
        'runs',
        'dispatches',
        'factory-rhythm-baseline',
        'grader-observations',
        'repositories',
        'workflows'
      ]) },
      mark: 'element',
      element: 'outcomes-overview',
      layout: 'full'
    })]);
    expect(validateDashboardDocument(authoritativeDashboardSource).ok).toBe(true);
  });

  it('accepts workflow-route-page on multiple pages without page-specific JavaScript routing', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: workflow-route-pages
  title: Workflow route pages
  pages:
    - id: workflow-runtime
      kind: custom
      title: Workflow runtime
      route:
        hash-query-parameter: workflow
      views:
        - id: workflow-runtime-route
          data:
            sources: [workflows]
          mark: element
          element: workflow-route-page
          config:
            body: insights
    - id: workflow-runs
      kind: custom
      title: Workflow runs
      route:
        hash-query-parameter: workflow
      views:
        - id: workflow-runs-route
          data:
            sources: [workflows]
          mark: element
          element: workflow-route-page
          config:
            body: runs
`);
    expect(accepted.ok).toBe(true);
  });

  it('defines core data pages as declarative full-view lazy tables', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const packagesPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'packages');
    const workflowsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflows');
    const packageDetailPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'package-detail');
    const runsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'runs');
    const transactionsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'transactions');

    const packagesView = packagesPage.definition.views[0];
    const workflowsView = workflowsPage.definition.views[0];
    const packageWorkflowsView = packageDetailPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'package-workflow-table');
    const runsView = runsPage.definition.views.find((/** @type {{ id: string }} */ view) => view.id === 'runs-runs-source');
    const transactionsView = transactionsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'transaction-entries');
    for (const view of [packagesView, workflowsView, runsView]) {
      expect(view).toMatchObject({
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        'column-summaries': true,
        layout: 'full-view'
      });
    }
    expect(packagesView.data.source).toBe('package-inventory');
    expect(packagesView.encoding.href).toEqual({ field: 'package-link', type: 'nominal' });
    expect(packagesView.encoding.columns.map((/** @type {{ title: string }} */ column) => column.title)).toEqual([
      'Package',
      'Workflows',
      'Roles',
      'Modes',
      'Runs',
      'AIC',
      'Registration'
    ]);
    expect(packagesView.encoding.columns.find((/** @type {{ field: string }} */ column) => column.field === 'modes')?.display).toBe('mode');
    expect(packagesView.encoding.columns.find((/** @type {{ field: string }} */ column) => column.field === 'registration')?.display).toBe('active-state');
    for (const view of [packagesView, packageWorkflowsView, workflowsView]) {
      expect(view.encoding.columns.at(-1)?.title).toBe('Registration');
    }
    expect(workflowsView.data.source).toBe('workflow-inventory');
    expect(runsView.data.source).toBe('runs-table');
    expect(transactionsView).toMatchObject({
      data: { source: 'transactions-table' },
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view'
    });
    expect(packagesPage.definition.views).toHaveLength(1);
    expect(workflowsPage.definition.views).toHaveLength(1);
    expect(runsPage.definition.views).toHaveLength(2);
    expect(document.dashboard.navigation.find((/** @type {{ label?: string }} */ section) => !section.label).pages).toEqual([
      'overview',
      'repositories',
      'packages',
      'configuration'
    ]);
    expect(document.dashboard.navigation.find((/** @type {{ label?: string }} */ section) => section.label === 'Data').pages).toEqual([
      'workflows',
      'runs',
      'events',
      'firewall',
      'mcps'
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('accepts workflow-route-page config.body and rejects unsupported values', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: workflow-route-config
  title: Workflow route config
  pages:
    - id: workflow-page
      kind: custom
      title: Workflow page
      route:
        hash-query-parameter: workflow
      views:
        - id: workflow-shell
          data:
            sources: [workflows]
          mark: element
          element: workflow-route-page
          config:
            body: reports
`);
    expect(accepted.ok).toBe(true);

    const invalidBody = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: workflow-route-config
  title: Workflow route config
  pages:
    - id: workflow-page
      kind: custom
      title: Workflow page
      route:
        hash-query-parameter: workflow
      views:
        - id: workflow-shell
          data:
            sources: [workflows]
          mark: element
          element: workflow-route-page
          config:
            body: summary
`);
    expect(invalidBody.ok).toBe(false);
    if (!invalidBody.ok) {
      expect(invalidBody.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.body'
      }));
    }
  });

  it('accepts package-route config.body and rejects unsupported values', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: package-route-config
  title: Package route config
  pages:
    - id: package-page
      kind: custom
      title: Package page
      route:
        hash-query-parameter: package
      views:
        - id: package-shell
          data:
            sources: [workflows]
          mark: element
          element: package-route
          config:
            body: dispatches
`);
    expect(accepted.ok).toBe(true);

    const invalidBody = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: package-route-config
  title: Package route config
  pages:
    - id: package-page
      kind: custom
      title: Package page
      route:
        hash-query-parameter: package
      views:
        - id: package-shell
          data:
            sources: [workflows]
          mark: element
          element: package-route
          config:
            body: runs
`);
    expect(invalidBody.ok).toBe(false);
    if (!invalidBody.ok) {
      expect(invalidBody.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.body'
      }));
    }
  });

  it('accepts outcome-detail-section config.body and rejects unsupported values', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: outcome-detail-section-config
  title: Outcome detail section config
  pages:
    - id: outcome-page
      kind: custom
      title: Outcome page
      route:
        hash-query-parameter: outcome
      views:
        - id: outcome-metadata
          data:
            sources: [outcomes]
          mark: element
          element: outcome-detail-section
          config:
            body: metadata
`);
    expect(accepted.ok).toBe(true);

    const invalidBody = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: outcome-detail-section-config
  title: Outcome detail section config
  pages:
    - id: outcome-page
      kind: custom
      title: Outcome page
      route:
        hash-query-parameter: outcome
      views:
        - id: outcome-metadata
          data:
            sources: [outcomes]
          mark: element
          element: outcome-detail-section
          config:
            body: summary
`);
    expect(invalidBody.ok).toBe(false);
    if (!invalidBody.ok) {
      expect(invalidBody.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.body'
      }));
    }
  });

  it('accepts work-project-view config and rejects unsupported values', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: work-view-config
  title: Work view config
  pages:
    - id: work-page
      kind: custom
      title: Work page
      views:
        - id: work-layouts
          data:
            sources: [work-items]
          mark: element
          element: work-project-view
          config:
            sections: [board, tasks]
`);
    expect(accepted.ok).toBe(true);

    const invalidBody = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: work-view-config
  title: Work view config
  pages:
    - id: work-page
      kind: custom
      title: Work page
      views:
        - id: work-layouts
          data:
            sources: [work-items]
          mark: element
          element: work-project-view
          config:
            body: backlog
`);
    expect(invalidBody.ok).toBe(false);
    if (!invalidBody.ok) {
      expect(invalidBody.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.body'
      }));
    }

    const invalidSection = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: work-view-config
  title: Work view config
  pages:
    - id: work-page
      kind: custom
      title: Work page
      views:
        - id: work-layouts
          data:
            sources: [work-items]
          mark: element
          element: work-project-view
          config:
            sections: [backlog]
`);
    expect(invalidSection.ok).toBe(false);
    if (!invalidSection.ok) {
      expect(invalidSection.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.sections[0]'
      }));
    }
  });

  it('accepts plural text variables for overview labels and rejects malformed ones', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: overview-labels
  title: Overview labels
  pages:
    - id: overview-page
      kind: custom
      title: Overview page
      views:
        - id: overview-boxes
          data:
            sources: [runs]
          mark: element
          element: outcomes-overview
          config:
            labels:
              repositories:
                singular: Repository
                plural: Repositories
`);
    expect(accepted.ok).toBe(true);

    const wrongElement = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: overview-labels
  title: Overview labels
  pages:
    - id: work-page
      kind: custom
      title: Work page
      views:
        - id: work-layouts
          data:
            sources: [work-items]
          mark: element
          element: work-project-view
          config:
            labels:
              repositories:
                singular: Repository
                plural: Repositories
`);
    expect(wrongElement.ok).toBe(false);
    if (!wrongElement.ok) {
      expect(wrongElement.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[0].views[0].config.labels'
      }));
    }

    const incompleteText = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: overview-labels
  title: Overview labels
  pages:
    - id: overview-page
      kind: custom
      title: Overview page
      views:
        - id: overview-boxes
          data:
            sources: [runs]
          mark: element
          element: outcomes-overview
          config:
            labels:
              Repositories:
                singular: Repository
`);
    expect(incompleteText.ok).toBe(false);
    if (!incompleteText.ok) {
      expect(incompleteText.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[0].views[0].config.labels.Repositories.plural'
      }));
      expect(incompleteText.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.labels.Repositories'
      }));
    }
  });

  it('defines work-project-view composition through canonical body values', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const pages = new Map(document.dashboard.pages.map((/** @type {{ id: string }} */ page) => [page.id, page]));

    expect(pages.get('work')?.views[0]).toMatchObject({
      mark: 'element',
      element: 'work-project-view',
      config: { body: 'board' }
    });
    expect(pages.get('work-tasks')?.views[0]).toMatchObject({
      mark: 'element',
      element: 'work-project-view',
      config: { body: 'tasks' }
    });
    expect(pages.get('work-roadmap')?.views[0]).toMatchObject({
      mark: 'element',
      element: 'work-project-view',
      config: { body: 'roadmap' }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines experiments as a full-view interactive lazy-list table', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const experimentsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'experiments');

    expect(experimentsPage.definition.views).toHaveLength(2);
    expect(experimentsPage.definition.views[0]).toMatchObject({
      id: 'experiments-list',
      data: { source: 'experiments-table' },
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view'
    });
    expect(experimentsPage.definition.views[1]).toMatchObject({
      id: 'audit',
      disclosure: 'supplemental',
      data: { source: 'audit-events' },
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view'
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('accepts every package dashboard document', () => {
    for (const source of packageDashboardSources) {
      expect(validateDashboardDocument(source).ok).toBe(true);
    }
  });

  it('DLS-VIEW-005 accepts automatically binned histograms and rejects ambiguous histogram channels', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const costPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'cost');
    const histogram = /** @type {any} */ ({
      id: 'cost-per-run-distribution',
      data: { source: 'usage' },
      mark: 'chart',
      chart: 'histogram',
      encoding: {
        x: { field: 'run', type: 'nominal' },
        y: { field: 'aic', type: 'quantitative', aggregate: 'sum' }
      }
    });
    costPage.views.push(histogram);

    expect(histogram).toMatchObject({
      chart: 'histogram',
      encoding: {
        x: { field: 'run', type: 'nominal' },
        y: { field: 'aic', type: 'quantitative', aggregate: 'sum' }
      }
    });

    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    histogram.encoding.color = { field: 'repository', type: 'nominal' };
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: expect.stringContaining('.encoding.color')
      }));
    }
  });

  it('DLS-VIEW-005 accepts bounded heatmaps and rejects invalid axes, values, and limits', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const performance = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'performance');
    const heatmap = {
      id: 'job-duration-by-job-runner',
      data: { source: 'job-performance', limit: 100 },
      mark: 'chart',
      chart: 'heatmap',
      encoding: {
        x: { field: 'job', type: 'nominal' },
        y: { field: 'runner', type: 'nominal' },
        color: { field: 'job-duration-seconds', type: 'quantitative', aggregate: 'mean' }
      }
    };
    performance.views.push(heatmap);

    expect(heatmap).toMatchObject({
      chart: 'heatmap',
      data: { source: 'job-performance', limit: 100 },
      encoding: {
        x: { field: 'job', type: 'nominal' },
        y: { field: 'runner', type: 'nominal' },
        color: { field: 'job-duration-seconds', type: 'quantitative', aggregate: 'mean' }
      }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    heatmap.data.limit = 101;
    heatmap.encoding.y.type = 'quantitative';
    heatmap.encoding.color.aggregate = 'none';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('.data.limit') }),
        expect.objectContaining({ path: expect.stringContaining('.encoding.y.type') }),
        expect.objectContaining({ path: expect.stringContaining('.encoding.color.aggregate') })
      ]));
    }
  });

  it('keeps one focused custom dashboard for every operation package', () => {
    const documents = packageDashboardSources.map((source) => JSON.parse(source));
    const packagePageIds = [
      'cao-evolution-dashboard',
      'dependabot-dashboard',
      'uk-ai-advisory-dashboard',
      'eu-cra-compliance-dashboard',
      'optimization-dashboard'
    ];
    expect(documents).toHaveLength(packagePageIds.length);
    for (const pageId of packagePageIds) {
      const document = documents.find((candidate) => candidate.dashboard.pages[0].id === pageId);
      if (!document) throw new Error(`Missing package dashboard page ${pageId}`);
      const page = document.dashboard.pages[0];
      expect(document.dashboard.navigation).toEqual([{ label: 'Package operations', experimental: true, pages: [pageId] }]);
      expect(page).toMatchObject({ kind: 'custom' });
      expect(page.views).toHaveLength(pageId === 'cao-evolution-dashboard' ? 5 : 4);
      const tables = page.views.filter(
        (/** @type {{ mark?: string }} */ view) => view.mark === 'table'
      );
      expect(tables.filter(
        (/** @type {{ disclosure?: string }} */ view) => view.disclosure === 'essential'
      )).toHaveLength(1);
      expect(tables.filter(
        (/** @type {{ disclosure?: string }} */ view) => view.disclosure === 'supplemental'
      )).toHaveLength(tables.length - 1);
      const queryByName = new Map(document.dashboard.queries.map(
        (/** @type {{ name: string, from: string }} */ query) => [query.name, query]
      ));
      /** @param {string} source @returns {string} */
      const canonicalSource = (source) => {
        const query = queryByName.get(source);
        return query ? canonicalSource(query.from) : source;
      };
      const sources = page.views.map(
        (/** @type {{ data: { source: string } }} */ view) => canonicalSource(view.data.source)
      );
      const expectedSources = pageId === 'cao-evolution-dashboard'
        ? ['operational-values', 'operational-values', 'outcomes', 'outcomes', 'runs']
        : ['operational-values', 'operational-values', 'outcomes', 'runs'];
      expect(sources.sort()).toEqual(expectedSources.sort());
    }
  });

  it('keeps the CAO Evolution run inventory aligned with the built-in run table', () => {
    const builtInDocument = JSON.parse(authoritativeDashboardSource);
    const builtInRunView = builtInDocument.dashboard.pages
      .find((/** @type {{ id: string }} */ page) => page.id === 'runs')
      .definition.views.find((/** @type {{ id: string }} */ view) => view.id === 'runs-runs-source');
    const evolutionDocument = packageDashboardSources
      .map((source) => JSON.parse(source))
      .find((document) => document.dashboard.id === 'cao-evolution-dashboard');
    const runView = evolutionDocument.dashboard.pages[0].views
      .find((/** @type {{ id: string }} */ view) => view.id === 'cao-evolution-runs');

    expect(runView).toMatchObject({
      mark: 'table',
      controls: 'interactive',
      encoding: { href: builtInRunView.encoding.href }
    });
    expect(runView.encoding.columns.map(
      (/** @type {{ field: string }} */ column) => column.field
    )).toEqual([
      'run',
      'run-status',
      'run-conclusion',
      'repository',
      'workflow',
      'rollout-mode',
      'started-at'
    ]);
    expect(runView.description).toContain('maintenance checks');
    expect(runView.encoding.columns.some(
      (/** @type {{ field: string }} */ column) => column.field === 'engine-version'
    )).toBe(false);
  });

  it('validates source-free JSON callouts with canonical icons', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const costPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'cost');
    const callout = /** @type {any} */ ({
      id: 'cost-evaluation-boundary',
      title: 'Budget and anomaly verdicts unavailable',
      description: 'Budget and anomaly verdicts require complete, comparable evidence; partial AI Credit telemetry is insufficient.',
      mark: 'callout',
      callout: { label: 'Evaluation boundary', icon: 'meter' }
    });
    costPage.views.push(callout);
    expect(callout).toMatchObject({
      mark: 'callout',
      callout: { label: 'Evaluation boundary', icon: 'meter' }
    });
    expect(callout.description).toContain('partial AI Credit telemetry');
    const valuePage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'operational-value'
    );
    expect(valuePage).toBeDefined();
    const valueCallout = {
      id: 'experiment-evidence-boundary',
      title: 'Experiment comparisons unavailable',
      description: 'Experiment evidence cannot be established from partial AI Credit telemetry.',
      mark: 'callout',
      callout: { label: 'Experiment evidence boundary', icon: 'beaker' }
    };
    valuePage.views.push(valueCallout);
    expect(valueCallout).toBeDefined();
    expect(valueCallout.description).toContain('partial AI Credit telemetry');
    expect(callout.data).toBeUndefined();
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    callout.callout.icon = 'not-an-octicon';
    callout.data = { source: 'usage' };
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: expect.stringContaining('.callout.icon')
      }));
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: expect.stringContaining('.data'),
        message: 'callout views must not declare data.'
      }));
    }
  });

  it('DLS-PAGE-017 rejects obsolete page filter-bar configuration', () => {
    const accepted = validateDashboardDocument(authoritativeDashboardSource);
    expect(accepted.ok).toBe(true);

    const obsoleteConfiguration = JSON.parse(authoritativeDashboardSource);
    const costPage = obsoleteConfiguration.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'cost');
    costPage['filter-bar'] = { filters: [] };

    const rejected = validateDashboardDocument(JSON.stringify(obsoleteConfiguration));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: '$.dashboard.pages[3].filter-bar'
      }));
    }
  });

  it('DLS-VIEW-024 validates custom page section layout and complete ordered view placement', () => {
    const document = {
      'language-version': '0.1.0',
      dashboard: {
        id: 'sectioned-dashboard',
        title: 'Sectioned Dashboard',
        pages: [{
          id: 'summary',
          kind: 'custom',
          views: [
            {
              id: 'run-count',
              data: { source: 'runs' },
              mark: 'metric',
              encoding: { value: { field: 'run', aggregate: 'count' } }
            },
            {
              id: 'usage-total',
              data: { source: 'usage' },
              mark: 'metric',
              encoding: { value: { field: 'aic', aggregate: 'sum' } }
            }
          ],
          sections: [
            { id: 'headline', layout: 'wide', views: ['run-count'] },
            { id: 'details', title: 'Usage details', layout: 'narrow', views: ['usage-total'] }
          ]
        }]
      }
    };

    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    document.dashboard.pages[0].sections[1].views = ['run-count'];
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.pages[0].sections[1].views[0]',
        message: 'each page view may appear in only one layout section.'
      }));
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.pages[0].sections',
        message: 'layout sections must reference every page view exactly once and preserve view order.'
      }));
    }
  });

  it('DLS-VIEW-026 accepts custom page route and navigation allocation and rejects malformed declarations', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const repositoryPageIndex = document.dashboard.pages.findIndex((/** @type {{ id: string }} */ page) => page.id === 'repository-detail');
    const repositoryPage = document.dashboard.pages[repositoryPageIndex];
    expect(repositoryPage.route).toEqual({ 'hash-query-parameter': 'repository', 'navigation-page': 'repositories' });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
    repositoryPage.route = { 'navigation-page': 'repositories' };
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
    repositoryPage.route = { 'navigation-page': 'missing-page' };
    const missingNavigationPage = validateDashboardDocument(JSON.stringify(document));
    expect(missingNavigationPage.ok).toBe(false);
    if (!missingNavigationPage.ok) {
      expect(missingNavigationPage.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: `$.dashboard.pages[${repositoryPageIndex}].route.navigation-page`
      }));
    }
    repositoryPage.route = { 'navigation-page': 'repository-detail' };
    const selfNavigationPage = validateDashboardDocument(JSON.stringify(document));
    expect(selfNavigationPage.ok).toBe(false);
    if (!selfNavigationPage.ok) {
      expect(selfNavigationPage.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        message: 'route navigation-page must reference a different dashboard page.'
      }));
    }

    repositoryPage.route = { 'hash-query-parameter': 'Repository Name' };
    const malformed = validateDashboardDocument(JSON.stringify(document));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: `$.dashboard.pages[${repositoryPageIndex}].route.hash-query-parameter`
      }));
    }

    repositoryPage.route = { parameter: 'repository' };
    const unknownKey = validateDashboardDocument(JSON.stringify(document));
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) {
      expect(unknownKey.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: `$.dashboard.pages[${repositoryPageIndex}].route.parameter`
      }));
    }

    repositoryPage.route = {};
    const missingParameter = validateDashboardDocument(JSON.stringify(document));
    expect(missingParameter.ok).toBe(false);
    if (!missingParameter.ok) {
      expect(missingParameter.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: `$.dashboard.pages[${repositoryPageIndex}].route`,
        message: 'route must declare hash-query-parameter or navigation-page.'
      }));
    }

    repositoryPage.route = 'repository';
    const invalidShape = validateDashboardDocument(JSON.stringify(document));
    expect(invalidShape.ok).toBe(false);
    if (!invalidShape.ok) {
      expect(invalidShape.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: `$.dashboard.pages[${repositoryPageIndex}].route`,
        message: 'route must be a mapping.'
      }));
    }

    repositoryPage.route = { 'hash-query-parameter': 'repository' };
    const builtInPage = document.dashboard.pages.find((/** @type {{ kind: string }} */ page) => page.kind === 'built-in');
    builtInPage.route = { 'hash-query-parameter': 'repository' };
    const builtInRoute = validateDashboardDocument(JSON.stringify(document));
    expect(builtInRoute.ok).toBe(false);
    if (!builtInRoute.ok) {
      expect(builtInRoute.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: '$.dashboard.pages[0].route'
      }));
    }
  });

  it('DLS-VIEW-030 validates route fields against the selected logical source', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const repositoryPageIndex = document.dashboard.pages.findIndex((/** @type {{ id: string }} */ page) => page.id === 'repository-detail');
    const repositoryPage = document.dashboard.pages[repositoryPageIndex];
    expect(repositoryPage.views.every((/** @type {{ data: { 'route-field'?: string } }} */ view) => view.data['route-field'] === 'repository')).toBe(true);

    repositoryPage.views[0].data['route-field'] = 'missing-field';
    const invalid = validateDashboardDocument(JSON.stringify(document));

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: `$.dashboard.pages[${repositoryPageIndex}].views[0].data.route-field`
      }));
    }
  });

  it('DLS-VIEW-031 validates JSON-configured title links against one selected source', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const outcomePage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'outcome-detail');
    const outcomeView = outcomePage.views.find((/** @type {{ id: string }} */ view) => view.id === 'outcome-record');
    expect(outcomeView['title-link']).toEqual({
      'href-field': 'external-link',
      'identifier-field': 'outcome-number'
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    outcomeView['title-link'] = {
      'href-field': 'run-link',
      'identifier-field': 'run'
    };
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    outcomeView['title-link'] = {
      'href-field': 'outcome-title',
      'identifier-field': 'external-link'
    };
    const invalid = validateDashboardDocument(JSON.stringify(document));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E009',
        path: expect.stringMatching(/\.title-link\.href-field$/)
      }));
      expect(invalid.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: expect.stringMatching(/\.title-link\.identifier-field$/)
      }));
    }
  });

  it('validates dashboard.navigation references declared pages at most once', () => {
    const withUnknownPage = JSON.parse(authoritativeDashboardSource);
    withUnknownPage.dashboard.navigation[2].pages.push('does-not-exist');
    const unknownPageResult = validateDashboardDocument(JSON.stringify(withUnknownPage));
    expect(unknownPageResult.ok).toBe(false);
    if (!unknownPageResult.ok) {
      expect(unknownPageResult.errors).toContainEqual(expect.objectContaining({
        message: 'navigation section page must reference a declared dashboard page id.'
      }));
    }

    const withDuplicatePage = JSON.parse(authoritativeDashboardSource);
    withDuplicatePage.dashboard.navigation[1].pages.push('overview');
    const duplicatePageResult = validateDashboardDocument(JSON.stringify(withDuplicatePage));
    expect(duplicatePageResult.ok).toBe(false);
    if (!duplicatePageResult.ok) {
      expect(duplicatePageResult.errors).toContainEqual(expect.objectContaining({
        message: 'each dashboard page may appear in only one navigation section.'
      }));
    }

    const withMissingCoverage = JSON.parse(authoritativeDashboardSource);
    withMissingCoverage.dashboard.navigation[2].pages.pop();
    const missingCoverageResult = validateDashboardDocument(JSON.stringify(withMissingCoverage));
    expect(missingCoverageResult.ok).toBe(true);

    const withInvalidNavigationLabel = JSON.parse(authoritativeDashboardSource);
    withInvalidNavigationLabel.dashboard.pages[0]['navigation-label'] = 42;
    const invalidNavigationLabelResult = validateDashboardDocument(JSON.stringify(withInvalidNavigationLabel));
    expect(invalidNavigationLabelResult.ok).toBe(false);
    if (!invalidNavigationLabelResult.ok) {
      expect(invalidNavigationLabelResult.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.pages[0].navigation-label'
      }));
    }

    const withUnknownKey = JSON.parse(authoritativeDashboardSource);
    withUnknownKey.dashboard.navigation[0].icon = 'server';
    const unknownKeyResult = validateDashboardDocument(JSON.stringify(withUnknownKey));
    expect(unknownKeyResult.ok).toBe(false);
    if (!unknownKeyResult.ok) {
      expect(unknownKeyResult.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.navigation[0].icon'
      }));
    }

    const withInvalidExperimental = JSON.parse(authoritativeDashboardSource);
    withInvalidExperimental.dashboard.navigation[0].experimental = 'true';
    const invalidExperimentalResult = validateDashboardDocument(JSON.stringify(withInvalidExperimental));
    expect(invalidExperimentalResult.ok).toBe(false);
    if (!invalidExperimentalResult.ok) {
      expect(invalidExperimentalResult.errors).toContainEqual(expect.objectContaining({
        message: 'navigation section experimental must be a boolean.',
        path: '$.dashboard.navigation[0].experimental'
      }));
    }

    const withoutLabel = JSON.parse(authoritativeDashboardSource);
    delete withoutLabel.dashboard.navigation[0].label;
    const withoutLabelResult = validateDashboardDocument(JSON.stringify(withoutLabel));
    expect(withoutLabelResult.ok).toBe(true);

    const withEmptyLabel = JSON.parse(authoritativeDashboardSource);
    withEmptyLabel.dashboard.navigation[0].label = '';
    const withEmptyLabelResult = validateDashboardDocument(JSON.stringify(withEmptyLabel));
    expect(withEmptyLabelResult.ok).toBe(false);
    if (!withEmptyLabelResult.ok) {
      expect(withEmptyLabelResult.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.navigation[0].label'
      }));
    }
  });

  it('DLS-VIEW-016 DLS-VIEW-017 DLS-VAL-005 enforces canonical disclosure and at most four essential views', () => {
    const overloaded = `language-version: "0.1.0"
dashboard:
  id: progressive-disclosure
  title: Progressive Disclosure
  pages:
    - id: summary
      kind: custom
      views:
        - id: metric-one
          disclosure: essential
          data: { source: runs }
          mark: metric
          encoding: { value: { field: run, aggregate: count } }
        - id: metric-two
          data: { source: runs }
          mark: metric
          encoding: { value: { field: run, aggregate: count } }
        - id: metric-three
          data: { source: runs }
          mark: metric
          encoding: { value: { field: run, aggregate: count } }
        - id: metric-four
          data: { source: runs }
          mark: metric
          encoding: { value: { field: run, aggregate: count } }
        - id: metric-five
          data: { source: runs }
          mark: metric
          encoding: { value: { field: run, aggregate: count } }
`;

    const rejected = validateDashboardDocument(overloaded);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E013',
        path: '$.dashboard.pages[0].views'
      }));
    }

    const disclosed = overloaded.replace(
      '        - id: metric-five\n',
      '        - id: metric-five\n          disclosure: supplemental\n'
    );
    expect(validateDashboardDocument(disclosed).ok).toBe(true);

    const nonCanonical = validateDashboardDocument(disclosed.replace('disclosure: supplemental', 'disclosure: hidden'));
    expect(nonCanonical.ok).toBe(false);
    if (!nonCanonical.ok) {
      expect(nonCanonical.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[4].disclosure'
      }));
      expect(nonCanonical.errors).not.toContainEqual(expect.objectContaining({
        code: 'DLS-E013'
      }));
    }
  });

  it('DLS-VIEW-039 allows only one table to be open by default on a page', () => {
    const source = `language-version: "0.1.0"
dashboard:
  id: table-disclosure
  title: Table disclosure
  pages:
    - id: summary
      kind: custom
      views:
        - id: primary-table
          data: { source: runs }
          mark: table
          encoding:
            columns: [{ field: run, type: nominal }]
        - id: supporting-table
          data: { source: runs }
          mark: table
          encoding:
            columns: [{ field: run, type: nominal }]
`;

    const rejected = validateDashboardDocument(source);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E013',
        path: '$.dashboard.pages[0].views[1].disclosure'
      }));
    }

    const accepted = source.replace(
      '        - id: supporting-table\n',
      '        - id: supporting-table\n          disclosure: supplemental\n          disclosure-label: Supporting table\n'
    );
    expect(validateDashboardDocument(accepted).ok).toBe(true);

    const supplementalElement = accepted.replace(
      '        - id: supporting-table\n          disclosure: supplemental\n          disclosure-label: Supporting table\n          data: { source: runs }\n          mark: table\n          encoding:\n            columns: [{ field: run, type: nominal }]\n',
      '        - id: supporting-table\n          disclosure: supplemental\n          disclosure-label: Supporting table\n          data: { sources: [runs] }\n          mark: element\n          element: summary-grid\n'
    );
    expect(validateDashboardDocument(supplementalElement).ok).toBe(true);

    const primaryElementWithLabel = supplementalElement.replace(
      '          disclosure: supplemental\n',
      ''
    );
    const primaryElementResult = validateDashboardDocument(primaryElementWithLabel);
    expect(primaryElementResult.ok).toBe(false);
    if (!primaryElementResult.ok) {
      expect(primaryElementResult.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E013',
        path: '$.dashboard.pages[0].views[1].disclosure-label'
      }));
    }

    const emptyLabel = validateDashboardDocument(accepted.replace(
      'disclosure-label: Supporting table',
      'disclosure-label: ""'
    ));
    expect(emptyLabel.ok).toBe(false);
    if (!emptyLabel.ok) {
      expect(emptyLabel.errors).toContainEqual(expect.objectContaining({
        path: '$.dashboard.pages[0].views[1].disclosure-label'
      }));
    }

    const titledSupplemental = accepted.replace(
      '          disclosure-label: Supporting table\n',
      '          disclosure-label: Supporting table\n          title: Supporting table\n'
    );
    const titledResult = validateDashboardDocument(titledSupplemental);
    expect(titledResult.ok).toBe(false);
    if (!titledResult.ok) {
      expect(titledResult.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E013',
        path: '$.dashboard.pages[0].views[1].title'
      }));
    }

    const locked = source.replace(
      '        - id: supporting-table\n',
      '        - id: supporting-table\n          locked: true\n'
    );
    expect(validateDashboardDocument(locked).ok).toBe(true);
  });

  it('ignores graphical layout rules for designated dashboard pages', () => {
    const source = `language-version: "0.1.0"
dashboard:
  id: graphical-layout-ignored
  title: Graphical layout ignored
  pages:
    - id: home
      kind: custom
      views:
        - id: primary-table
          data: { source: runs }
          mark: table
          encoding:
            columns: [{ field: run, type: nominal }]
          views: []
        - id: supporting-table
          data: { source: runs }
          mark: table
          encoding:
            columns: [{ field: run, type: nominal }]
`;

    for (const pageId of ['overview', 'agent', 'agents', 'work', 'evidence', 'insights']) {
      expect(validateDashboardDocument(source.replace('id: home', `id: ${pageId}`)).ok).toBe(true);
    }
    expect(validateDashboardDocument(source.replace('id: home', 'id: summary')).ok).toBe(false);
  });

  it('DLS-VIEW-038 rejects nested view boxes while ignoring SVG chart internals', () => {
    const source = `language-version: "0.1.0"
dashboard:
  id: graphical-layout
  title: Graphical layout
  pages:
    - id: summary
      kind: custom
      views:
        - id: primary-table
          data: { source: runs }
          mark: table
          encoding:
            columns: [{ field: run, type: nominal }]
          views: []
`;

    const rejected = validateDashboardDocument(source);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E014',
        path: '$.dashboard.pages[0].views[0].views'
      }));
      expect(rejected.errors).not.toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: '$.dashboard.pages[0].views[0].views'
      }));
    }

    const chart = source
      .replace('mark: table', 'mark: chart\n          chart: pie')
      .replace('columns: [{ field: run, type: nominal }]', 'color: { field: run-conclusion, type: nominal }\n            value: { field: run, type: quantitative, aggregate: count }');
    const chartResult = validateDashboardDocument(chart);
    expect(chartResult.ok).toBe(false);
    if (!chartResult.ok) {
      expect(chartResult.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: '$.dashboard.pages[0].views[0].views'
      }));
      expect(chartResult.errors).not.toContainEqual(expect.objectContaining({
        code: 'DLS-E014',
        path: '$.dashboard.pages[0].views[0].views'
      }));
    }

    const malformedNestedViews = source.replace('          views: []', '          views: {}');
    const malformedResult = validateDashboardDocument(malformedNestedViews);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) {
      expect(malformedResult.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E014',
        path: '$.dashboard.pages[0].views[0].views'
      }));
      expect(malformedResult.errors).not.toContainEqual(expect.objectContaining({
        code: 'DLS-E004',
        path: '$.dashboard.pages[0].views[0].views'
      }));
    }

    const locked = source.replace(
      '        - id: primary-table\n',
      '        - id: primary-table\n          locked: true\n'
    );
    expect(validateDashboardDocument(locked).ok).toBe(true);
  });

  it('DLS-DOC-002 DLS-DOC-003 DLS-DOC-004 accepts the minimal structural document shape', () => {
    const result = validateDashboardDocument(validDocument.replace(`
    - id: usage
      kind: built-in
      page: usage
      title: Usage`, ''));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.languageVersion).toBe('0.1.0');
      expect(result.value.dashboard.id).toBe('agentic-operations');
      expect(result.value.dashboard.pages).toHaveLength(1);
    }
  });

  it('DLS-DOC-011 accepts a safe github-url-base and rejects unsafe or malformed values with DLS-E003', () => {
    const baseDocument = validDocument.replace(`
    - id: usage
      kind: built-in
      page: usage
      title: Usage`, '');

    const withGithubUrlBase = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  github-url-base: https://github.example.com\n'
    );
    const accepted = validateDashboardDocument(withGithubUrlBase);
    expect(accepted.ok).toBe(true);

    const withCredentials = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  github-url-base: "https://user:pass@github.example.com"\n'
    );
    const rejectedCredentials = validateDashboardDocument(withCredentials);
    expect(rejectedCredentials.ok).toBe(false);
    if (!rejectedCredentials.ok) {
      expect(rejectedCredentials.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.github-url-base' })
      );
    }

    const withQuery = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  github-url-base: https://github.example.com?foo=bar\n'
    );
    const rejectedQuery = validateDashboardDocument(withQuery);
    expect(rejectedQuery.ok).toBe(false);
    if (!rejectedQuery.ok) {
      expect(rejectedQuery.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.github-url-base' })
      );
    }

    const withHttp = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  github-url-base: http://github.example.com\n'
    );
    const rejectedHttp = validateDashboardDocument(withHttp);
    expect(rejectedHttp.ok).toBe(false);
    if (!rejectedHttp.ok) {
      expect(rejectedHttp.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.github-url-base' })
      );
    }
  });

  it('DLS-DOC-014 accepts horizon help text and rejects incomplete or unknown horizon fields', () => {
    const baseDocument = validDocument.replace(`
    - id: usage
      kind: built-in
      page: usage
      title: Usage`, '');
    const withHorizon = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  horizon:\n    label: Horizon\n    tooltip:\n      label: Horizon details\n      description: Explains the resolved data window.\n      icon: question\n'
    );

    expect(validateDashboardDocument(withHorizon).ok).toBe(true);

    const missingDescription = validateDashboardDocument(
      withHorizon.replace('      description: Explains the resolved data window.\n', '')
    );
    expect(missingDescription.ok).toBe(false);
    if (!missingDescription.ok) {
      expect(missingDescription.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.horizon.tooltip.description' })
      );
    }

    const unknownField = validateDashboardDocument(
      withHorizon.replace('      description:', '      placement: top\n      description:')
    );
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) {
      expect(unknownField.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.horizon.tooltip.placement' })
      );
    }
  });

  it('DLS-DOC-015 validates site-wide callouts and source-row visibility conditions', () => {
    const baseDocument = validDocument.replace(`
    - id: usage
      kind: built-in
      page: usage
      title: Usage`, '');
    const withCallout = baseDocument.replace(
      '  title: Agentic Operations\n',
      [
        '  title: Agentic Operations',
        '  callouts:',
        '    - id: partial-data',
        '      title: Dashboard data is partial',
        '      description: Some data could not be downloaded.',
        '      icon: alert',
        '      navigation-page: custom-summary',
        '      visible-when:',
        '        source: coverage-diagnostics',
        '        field: kind',
        '        equals: github-api-rate-limit-403',
        ''
      ].join('\n')
    );
    expect(validateDashboardDocument(withCallout).ok).toBe(true);

    const invalidNavigation = validateDashboardDocument(withCallout.replace('      navigation-page: custom-summary', '      navigation-page: missing-page'));
    expect(invalidNavigation.ok).toBe(false);
    if (!invalidNavigation.ok) {
      expect(invalidNavigation.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.callouts[0].navigation-page'
      }));
    }

    const invalidField = validateDashboardDocument(withCallout.replace('        field: kind', '        field: missing'));
    expect(invalidField.ok).toBe(false);
    if (!invalidField.ok) {
      expect(invalidField.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E010',
        path: '$.dashboard.callouts[0].visible-when.field'
      }));
    }

    const invalidIcon = validateDashboardDocument(withCallout.replace('      icon: alert', '      icon: not-an-octicon'));
    expect(invalidIcon.ok).toBe(false);
    if (!invalidIcon.ok) {
      expect(invalidIcon.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.callouts[0].icon'
      }));
    }

    const duplicateId = validateDashboardDocument(withCallout.replace(
      '  callouts:\n',
      '  callouts:\n    - id: partial-data\n      title: Another notice\n      description: Another description.\n'
    ));
    expect(duplicateId.ok).toBe(false);
    if (!duplicateId.ok) {
      expect(duplicateId.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.callouts[1].id'
      }));
    }
  });

  it('DLS-DOC-012 accepts a safe owner/repo repository slug and rejects malformed or blank-scoped values with DLS-E003', () => {
    const baseDocument = validDocument.replace(`
    - id: usage
      kind: built-in
      page: usage
      title: Usage`, '');

    const withRepository = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  repository: octo-org/agentic-operations\n'
    );
    const accepted = validateDashboardDocument(withRepository);
    expect(accepted.ok).toBe(true);

    const withoutOwner = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  repository: agentic-operations\n'
    );
    const rejectedMissingOwner = validateDashboardDocument(withoutOwner);
    expect(rejectedMissingOwner.ok).toBe(false);
    if (!rejectedMissingOwner.ok) {
      expect(rejectedMissingOwner.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.repository' })
      );
    }

    const withBlank = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  repository: ""\n'
    );
    const rejectedBlank = validateDashboardDocument(withBlank);
    expect(rejectedBlank.ok).toBe(false);
    if (!rejectedBlank.ok) {
      expect(rejectedBlank.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.repository' })
      );
    }

    const withCredentials = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  repository: "octo-org/agentic-operations?token=abc"\n'
    );
    const rejectedCredentials = validateDashboardDocument(withCredentials);
    expect(rejectedCredentials.ok).toBe(false);
    if (!rejectedCredentials.ok) {
      expect(rejectedCredentials.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.repository' })
      );
    }

    const withConsecutiveDots = baseDocument.replace(
      '  title: Agentic Operations\n',
      '  title: Agentic Operations\n  repository: "octo-org/agentic..operations"\n'
    );
    const rejectedConsecutiveDots = validateDashboardDocument(withConsecutiveDots);
    expect(rejectedConsecutiveDots.ok).toBe(false);
    if (!rejectedConsecutiveDots.ok) {
      expect(rejectedConsecutiveDots.errors).toContainEqual(
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.repository' })
      );
    }
  });

  it('DLS-DOC-001 rejects multiple YAML documents with DLS-E002', () => {
    const result = validateDashboardDocument(`${validDocument}\n---\n${validDocument}`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E002', path: '$' })
      ]);
    }
  });

  it('DLS-DOC-001 DLS-SAFE-001 rejects invalid YAML syntax with DLS-E001', () => {
    const result = validateDashboardDocument('language-version: "0.1.0"\ndashboard: [unterminated');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E001', path: '$' })
      ]);
    }
  });

  it('DLS-DOC-002 DLS-DOC-007 rejects unknown and duplicate root keys with DLS-E004', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
extra-root: true
dashboard:
  id: agentic-operations
  title: Agentic Operations
  pages:
    - id: usage
      kind: built-in
      page: usage
dashboard:
  id: duplicate-dashboard
  title: Duplicate
  pages:
    - id: repositories
      kind: built-in
      page: repositories
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E004', path: '$.extra-root' }),
          expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard' })
        ])
      );
    }
  });

  it('DLS-DOC-003 DLS-DOC-006 rejects non-canonical language-version with DLS-E005', () => {
    const result = validateDashboardDocument(validDocument.replace('"0.1.0"', '"0.1"'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.language-version' })
        ])
      );
    }
  });

  it('DLS-DOC-004 DLS-DOC-010 rejects missing title and empty pages with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: agentic-operations
  pages: []
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.title' }),
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages' })
        ])
      );
    }
  });

  it('DLS-DOC-005 rejects non-canonical dashboard page and view identifiers with DLS-E005', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: Agentic_Operations
  title: Agentic Operations
  pages:
    - id: Runs_Page
      kind: custom
      views:
        - id: RunCount
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.id' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].id' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].id' })
        ])
      );
    }
  });

  it('DLS-DOC-005 rejects duplicate page ids and duplicate view ids with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  pages:
    - id: duplicate
      kind: built-in
      page: overview
    - id: duplicate
      kind: custom
      views:
        - id: duplicate-view
        - id: duplicate-view
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[1].id' }),
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[1].views[1].id' })
        ])
      );
    }
  });

  it('DLS-DOC-008 rejects unknown defaults keys with DLS-E004', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  defaults:
    scope: {}
    timezone: UTC
  pages:
    - id: usage
      kind: built-in
      page: usage
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.defaults.timezone' })
        ])
      );
    }
  });

  it('DLS-DOC-009 rejects invalid page kinds and built-in page names with DLS-E005', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  pages:
    - id: overview
      kind: builtin
      page: overview
    - id: runs
      kind: built-in
      page: invalid-page
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].kind' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[1].page' })
        ])
      );
    }
  });

  it('DLS-PAGE-001 DLS-PAGE-010 DLS-PAGE-014 accepts an omitted built-in page title when the page name is canonical', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: built-in-title-default
  title: Built-in Title Default
  pages:
    - id: usage
      kind: built-in
      page: usage
      definition:
        data-state:
          availability: true
        views:
          - id: usage-summary
            data:
              source: usage
            mark: table
            encoding:
              columns:
                - field: input-tokens
                - field: output-tokens
                - field: cache-read-tokens
                - field: cache-write-tokens
                - field: reasoning-tokens
                - field: aic
                - field: estimated-usd
                - field: engine
                - field: engine-version
                - field: requested-model
                - field: resolved-model
                - field: organization
                - field: repository
                - field: workflow
                - field: rollout-mode
                - field: observed-at
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-PAGE-001 rejects an omitted built-in page title when the page name is non-canonical', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-built-in-title-default
  title: Invalid Built-in Title Default
  pages:
    - id: usage
      kind: built-in
      page: Usage
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].page' })
        ])
      );
    }
  });

  it('DLS-PAGE-003 DLS-PAGE-004 DLS-PAGE-005 DLS-PAGE-007 DLS-PAGE-008 DLS-PAGE-009 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 reject built-in page definitions that omit required sources', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: organizations-built-in
  title: Organizations Built In
  pages:
    - id: organizations
      kind: built-in
      page: organizations
      title: Organizations
      definition:
        data-state:
          availability: true
        views:
          - id: organizations-view
            data:
              source: organizations
            mark: metric
            encoding:
              value:
                field: organization
                aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "organizations" definition must include at least one view for source "repositories".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "organizations" definition must include at least one view for source "workflows".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "organizations" definition must include at least one view for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "organizations" definition must include at least one view for source "usage".'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-001 DLS-PAGE-011 DLS-PAGE-014 accepts an explicit built-in page title when it matches the canonical title default', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: explicit-built-in-title-default
  title: Explicit Built-in Title Default
  pages:
    - id: engines-models
      kind: built-in
      page: engines-models
      title: Engines Models
      definition:
        data-state:
          availability: true
        views:
          - id: run-aggregates-view
            data:
              source: run-aggregate-summary
            mark: table
            encoding:
              columns:
                - field: engine
                - field: engine-version
                - field: requested-model
                - field: resolved-model
                - field: run-conclusion
                - field: runs
              href:
                field: run-link
          - id: models-view
            disclosure: supplemental
            data:
              source: model-usage-summary
            mark: table
            encoding:
              columns:
                - field: model
                - field: engine
                - field: requested-model
                - field: runs
                - field: invocations
                - field: total-aic
                - field: estimated-usd
                - field: pricing
          - id: engines-view
            disclosure: supplemental
            data:
              source: engine-usage-summary
            mark: table
            encoding:
              columns:
                - field: engine
                - field: runs
                - field: invocations
                - field: total-aic
                - field: estimated-usd
                - field: min-engine-version
                - field: max-engine-version
                - field: models
`);
    expect(result.ok).toBe(true);
  });

  it('DLS-PAGE-001 accepts a non-empty built-in page title that differs from the canonical default', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const operations = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'operations');
    operations.title = 'Fleet Operations';
    const result = validateDashboardDocument(JSON.stringify(document));

    expect(result.ok).toBe(true);
  });

  it('DLS-PAGE-002 rejects an overview built-in page without declarative built-in source definitions with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: overview-page
  title: Overview Page
  pages:
    - id: overview
      kind: built-in
      page: overview
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].definition' })
        ])
      );
      expect(result.errors.map((error) => error.message)).toEqual(
        expect.arrayContaining([
          'built-in page "overview" requires declarative definitions for source "repositories".',
          'built-in page "overview" requires declarative definitions for source "workflows".',
          'built-in page "overview" requires declarative definitions for source "runs".',
          'built-in page "overview" requires declarative definitions for source "usage".',
          'built-in page "overview" requires declarative definitions for source "findings".',
          'built-in page "overview" requires declarative definitions for source "operational-values".'
        ])
      );
    }
  });

  it('DLS-PAGE-006 rejects a runs built-in page without declarative built-in source definitions with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: runs-page
  title: Runs Page
  pages:
    - id: runs
      kind: built-in
      page: runs
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition',
            message: 'built-in page "runs" requires declarative definitions for source "runs".'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-015 rejects a packages built-in page without declarative built-in source definitions with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: packages-page
  title: Packages Page
  pages:
    - id: packages
      kind: built-in
      page: packages
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            message: 'built-in page "packages" requires declarative definitions for source "package-inventory".'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-006 DLS-PAGE-014 rejects a runs built-in page definition that omits required run fields and run links with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: incomplete-runs-page
  title: Incomplete Runs Page
  pages:
    - id: runs
      kind: built-in
      page: runs
      title: Runs
      definition:
        data-state:
          availability: true
        views:
          - id: run-table
            data:
              source: runs
            mark: table
            encoding:
              columns:
                - field: run
                - field: run-status
                - field: run-conclusion
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "organization" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "repository" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "workflow" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "rollout-mode" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "engine" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "requested-model" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "resolved-model" for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "runs" definition must expose field "started-at" for source "runs".'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-002 DLS-PAGE-014 rejects an overview built-in page definition that omits linked findings and operational-value timeline coverage with DLS-E003', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: incomplete-overview-page
  title: Incomplete Overview Page
  pages:
    - id: overview
      kind: built-in
      page: overview
      title: Overview
      definition:
        data-state:
          availability: true
        views:
          - id: workflows-view
            data:
              source: workflows
            mark: table
            encoding:
              columns:
                - field: workflow-active
                - field: rollout-mode
          - id: runs-view
            data:
              source: runs
            mark: table
            encoding:
              columns:
                - field: run-status
                - field: run-conclusion
                - field: repository
                - field: workflow
          - id: usage-view
            data:
              source: usage
            mark: metric
            encoding:
              value:
                field: aic
                aggregate: sum
          - id: findings-view
            data:
              source: findings
            mark: table
            encoding:
              columns:
                - field: observed-at
          - id: operational-values-view
            data:
              source: operational-values
            mark: table
            encoding:
              columns:
                - field: operational-value
                - field: observed-at
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "overview" definition must expose field "issue-link" for source "findings".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "overview" definition must expose field "pull-request-link" for source "findings".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "overview" definition must expose field "run-link" for source "findings".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.views',
            message: 'built-in page "overview" definition must expose field "operational-value-definition" for source "operational-values".'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-014 rejects a built-in page definition that does not expose availability', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: missing-built-in-data-state
  title: Missing Built In Data State
  pages:
    - id: usage
      kind: built-in
      page: usage
      title: Usage
      definition:
        views:
          - id: usage-table
            data:
              source: usage
            mark: table
            encoding:
              columns:
                - field: input-tokens
                - field: output-tokens
                - field: cache-read-tokens
                - field: cache-write-tokens
                - field: reasoning-tokens
                - field: aic
                - field: engine
                - field: requested-model
                - field: resolved-model
                - field: organization
                - field: repository
                - field: workflow
                - field: rollout-mode
                - field: observed-at
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.data-state',
            message: 'built-in page definition must expose availability state.'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-014 rejects a built-in page definition with a non-canonical availability marker', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-built-in-data-state
  title: Invalid Built In Data State
  pages:
    - id: usage
      kind: built-in
      page: usage
      title: Usage
      definition:
        data-state:
          availability: available
          extra-axis: true
        views:
          - id: usage-table
            data:
              source: usage
            mark: table
            encoding:
              columns:
                - field: input-tokens
                - field: output-tokens
                - field: cache-read-tokens
                - field: cache-write-tokens
                - field: reasoning-tokens
                - field: aic
                - field: engine
                - field: requested-model
                - field: resolved-model
                - field: organization
                - field: repository
                - field: workflow
                - field: rollout-mode
                - field: observed-at
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.pages[0].definition.data-state.extra-axis' }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.data-state.availability',
            message: 'built-in page definition must expose availability state with canonical boolean true.'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-002 DLS-PAGE-006 DLS-PAGE-010 DLS-PAGE-011 DLS-PAGE-012 DLS-PAGE-013 DLS-PAGE-014 accepts built-in definitions that conservatively cover required fields', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: built-in-field-coverage
  title: Built In Field Coverage
  pages:
    - id: overview
      kind: built-in
      page: overview
      title: Overview
      definition:
        data-state:
          availability: true
        views:
          - id: repository-inventory
            data:
              source: repositories
            mark: metric
            encoding:
              value:
                field: repository
                aggregate: distinct-count
          - id: workflow-inventory
            data:
              source: workflows
            mark: table
            encoding:
              columns:
                - field: workflow-active
                - field: rollout-mode
          - id: run-trends
            data:
              source: runs
            mark: chart
            encoding:
              x:
                field: started-at
                type: temporal
                time-unit: day
              y:
                field: run
                aggregate: count
              color:
                field: run-conclusion
          - id: run-rankings
            disclosure: supplemental
            data:
              source: runs
            mark: table
            encoding:
              columns:
                - field: repository
                - field: workflow
                - field: run-status
                - field: run-conclusion
          - id: usage-metric
            disclosure: supplemental
            data:
              source: usage
            mark: metric
            encoding:
              value:
                field: aic
                aggregate: sum
          - id: recent-findings
            disclosure: supplemental
            data:
              source: findings
            mark: table
            encoding:
              columns:
                - field: observed-at
                - field: issue-link
                - field: pull-request-link
                - field: run-link
          - id: operational-value-timeline
            data:
              source: operational-values
            mark: chart
            encoding:
              x:
                field: observed-at
                type: temporal
                time-unit: day
              y:
                field: operational-value
                aggregate: max
              color:
                field: operational-value-definition
    - id: runs
      kind: built-in
      page: runs
      title: Runs
      definition:
        data-state:
          availability: true
        views:
          - id: run-table
            data:
              source: runs
            mark: table
            encoding:
              columns:
                - field: run
                - field: run-status
                - field: run-conclusion
                - field: organization
                - field: repository
                - field: workflow
                - field: rollout-mode
                - field: engine
                - field: engine-version
                - field: requested-model
                - field: resolved-model
                - field: started-at
          - id: run-links
            disclosure: supplemental
            data:
              source: outcomes
            mark: table
            encoding:
              columns:
                - field: run-link
    - id: usage
      kind: built-in
      page: usage
      title: Usage
      definition:
        data-state:
          availability: true
        views:
          - id: usage-table
            data:
              source: usage
            mark: table
            encoding:
              columns:
                - field: input-tokens
                - field: output-tokens
                - field: cache-read-tokens
                - field: cache-write-tokens
                - field: reasoning-tokens
                - field: aic
                - field: estimated-usd
                - field: engine
                - field: engine-version
                - field: requested-model
                - field: resolved-model
                - field: organization
                - field: repository
                - field: workflow
                - field: rollout-mode
                - field: observed-at
    - id: operational-value
      kind: built-in
      page: operational-value
      title: Operational Value
      definition:
        data-state:
          availability: true
        views:
          - id: operational-value-table
            data:
              source: operational-values
            mark: table
            encoding:
              columns:
                - field: observed-at
                - field: operational-value
                - field: operational-value-definition
                - field: operational-case
                - field: evaluator-digest
                - field: requested-evidence-at
                - field: evidence-cutoff
                - field: maturity-at
                - field: maturity-status
                - field: evidence-link
                - field: experiment
                - field: delta-from-baseline
    - id: findings
      kind: built-in
      page: findings
      title: Findings
      definition:
        data-state:
          availability: true
        views:
          - id: findings-table
            data:
              source: findings
            mark: table
            encoding:
              columns:
                - field: finding-summary
                - field: finding-severity
                - field: finding-status
                - field: organization
                - field: repository
                - field: workflow
                - field: observed-at
                - field: issue-link
                - field: pull-request-link
                - field: run-link
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-PAGE-002 DLS-PAGE-014 accepts built-in overview page definitions that conservatively expose provenance and freshness coverage through source metadata-bearing views', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: overview-provenance-freshness
  title: Overview Provenance
  pages:
    - id: overview
      kind: built-in
      page: overview
      title: Overview
      definition:
        data-state:
          availability: true
        views:
          - id: repository-inventory
            data:
              source: repositories
              source-metadata:
                source-id: repositories-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: complete
                freshness: fresh
                availability: available
            mark: metric
            encoding:
              value:
                field: repository
                aggregate: distinct-count
          - id: workflow-inventory
            data:
              source: workflows
              source-metadata:
                source-id: workflows-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: complete
                freshness: fresh
                availability: available
            mark: table
            encoding:
              columns:
                - field: workflow-active
                - field: rollout-mode
          - id: run-trends
            data:
              source: runs
              source-metadata:
                source-id: runs-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: partial
                freshness: stale
                availability: empty
            mark: chart
            encoding:
              x:
                field: started-at
                type: temporal
                time-unit: day
              y:
                field: run
                aggregate: count
              color:
                field: run-conclusion
          - id: run-rankings
            disclosure: supplemental
            data:
              source: runs
              source-metadata:
                source-id: runs-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: partial
                freshness: stale
                availability: empty
            mark: table
            encoding:
              columns:
                - field: repository
                - field: workflow
                - field: run-status
                - field: run-conclusion
          - id: usage-metric
            disclosure: supplemental
            data:
              source: usage
              source-metadata:
                source-id: usage-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: complete
                freshness: fresh
                availability: available
            mark: metric
            encoding:
              value:
                field: aic
                aggregate: sum
          - id: recent-findings
            disclosure: supplemental
            data:
              source: findings
              source-metadata:
                source-id: findings-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: complete
                freshness: fresh
                availability: available
            mark: table
            encoding:
              columns:
                - field: observed-at
                - field: issue-link
                - field: pull-request-link
                - field: run-link
          - id: operational-value-timeline
            data:
              source: operational-values
              source-metadata:
                source-id: operational-values-fixture
                source-kind: fixture
                as-of: '2026-08-29T12:00:00Z'
                retrieved-at: '2026-08-29T12:05:00Z'
                completeness: unknown
                freshness: fresh
                availability: unavailable
            mark: chart
            encoding:
              x:
                field: observed-at
                type: temporal
                time-unit: day
              y:
                field: operational-value
                aggregate: max
              color:
                field: operational-value-definition
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-SEM-017 accepts every canonical Section 5.1 source name', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: source-catalog
  title: Source Catalog
  pages:
    - id: all-sources
      kind: custom
      views:
        - id: organizations-view
          data:
            source: organizations
          mark: metric
          encoding:
            value:
              field: organization
              aggregate: count
        - id: repositories-view
          data:
            source: repositories
          mark: metric
          encoding:
            value:
              field: repository
              aggregate: count
        - id: workflows-view
          data:
            source: workflows
          mark: metric
          encoding:
            value:
              field: workflow
              aggregate: count
        - id: runs-view
          data:
            source: runs
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
        - id: experiments-view
          data:
            source: experiments
          mark: metric
          encoding:
            value:
              field: experiment
              aggregate: count
        - id: experiment-assignments-view
          data:
            source: experiment-assignments
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
        - id: graders-view
          data:
            source: graders
          mark: metric
          encoding:
            value:
              field: grader
              aggregate: count
        - id: grader-observations-view
          data:
            source: grader-observations
          mark: metric
          encoding:
            value:
              field: grader
              aggregate: count
        - id: evals-view
          data:
            source: evals
          mark: metric
          encoding:
            value:
              field: eval
              aggregate: count
        - id: eval-observations-view
          data:
            source: eval-observations
          mark: metric
          encoding:
            value:
              field: eval
              aggregate: count
        - id: usage-view
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
        - id: outcomes-view
          data:
            source: outcomes
          mark: metric
          encoding:
            value:
              field: safe-output
              aggregate: count
        - id: findings-view
          data:
            source: findings
          mark: metric
          encoding:
            value:
              field: finding
              aggregate: count
        - id: operational-values-view
          data:
            source: operational-values
          mark: metric
          encoding:
            value:
              field: operational-value
              aggregate: max
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-SEM-017 rejects unknown source names with DLS-E005', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-source
  title: Invalid Source
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: invalid-view
          data:
            source: deployments
          mark: metric
          encoding:
            value:
              field: repository
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.source' })
      ]);
    }
  });

  it('DLS-SEM-021 accepts rollout-mode canonical values and rejects non-canonical spellings', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: rollout-mode-filter
  title: Rollout Mode Filter
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: usage-view
          data:
            source: usage
            filters:
              rollout-mode:
                - review
                - live
                - unknown
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(accepted.ok).toBe(true);

    const rejected = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-rollout-mode
  title: Invalid Rollout Mode
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: usage-view
          data:
            source: usage
            filters:
              rollout-mode:
                - review
                - in_review
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.rollout-mode[1]' })
      ]);
    }
  });

  it('DLS-SEM-022 accepts workflow-role canonical values and rejects unknown roles', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: workflow-role-filter
  title: Workflow Role Filter
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: workflows-view
          data:
            source: workflows
            filters:
              workflow-role:
                - orchestrator
                - worker
                - standalone
          mark: metric
          encoding:
            value:
              field: workflow
              aggregate: count
`);

    expect(accepted.ok).toBe(true);

    const rejected = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-workflow-role
  title: Invalid Workflow Role
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: workflows-view
          data:
            source: workflows
            filters:
              workflow-role:
                - orchestrator
                - controller
          mark: metric
          encoding:
            value:
              field: workflow
              aggregate: count
`);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.workflow-role[1]' })
      ]);
    }
  });

  it('DLS-SEM-022 DLS-SEM-023 validates package membership and configured allowances in logical workflow sources', () => {
    const accepted = validateLogicalSources({
      workflows: {
        rows: [
          {
            organization: 'octo-org',
            repository: 'platform',
            package: 'daily-ops',
            'package-icon': 'workflow',
            workflow: 'orchestrator.yml',
            'workflow-role': 'orchestrator',
            'max-ai-credits': 100,
            'package-aic-allowance': 250
          },
          {
            organization: 'octo-org',
            repository: 'platform',
            package: 'daily-ops',
            workflow: 'worker.yml',
            'workflow-role': 'worker',
            'max-ai-credits': 150,
            'package-aic-allowance': 250
          },
          {
            organization: 'octo-org',
            repository: 'target-service',
            workflow: 'ci.yml',
            'workflow-role': 'standalone'
          }
        ]
      }
    });

    expect(accepted.ok).toBe(true);

    const rejected = validateLogicalSources({
      workflows: {
        rows: [
          { workflow: 'worker.yml', 'workflow-role': 'worker' },
          { package: 'invalid', workflow: 'standalone.yml', 'workflow-role': 'standalone' },
          {
            package: 'negative',
            workflow: 'negative.yml',
            'workflow-role': 'orchestrator',
            'max-ai-credits': -1
          },
          {
            package: 'mismatch',
            'package-icon': 'not-an-octicon',
            workflow: 'mismatch.yml',
            'workflow-role': 'orchestrator',
            'max-ai-credits': 100,
            'package-aic-allowance': 99
          }
        ]
      }
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.sources.workflows.rows[0].package' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.sources.workflows.rows[1].package' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.sources.workflows.rows[2].max-ai-credits' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.sources.workflows.rows[3].package-icon' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.sources.workflows.rows[3].package-aic-allowance' })
      ]));
    }
  });

  it('DLS-CTX-009 DLS-CTX-002 accepts valid scope and time context shapes', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: context-shapes
  title: Context Shapes
  defaults:
    scope:
      organizations:
        - octo-org
      repositories:
        - octo-org/central-agentic-ops
    time:
      start: "2026-08-01T00:00:00Z"
      end: "2026-08-31T00:00:00Z"
    filters:
      rollout-mode:
        - review
        - live
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: usage-view
          data:
            source: usage
            scope:
              workflows:
                - .github/workflows/cao-dashboard.yml
            time:
              range: 7d
            filters:
              repository: octo-org/central-agentic-ops
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-CTX-009 rejects invalid time.range forms and mixing range with start/end using DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-range
  title: Invalid Range
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: bad-range
          data:
            source: runs
            time:
              range: 0d
              start: "2026-08-01T00:00:00Z"
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.time.range' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.time' })
        ])
      );
    }
  });

  it('DLS-CTX-002 rejects non-RFC-3339 timestamps with DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-time-format
  title: Invalid Time Format
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: bad-time
          data:
            source: runs
            time:
              start: 2026-08-01
              end: "2026-08-02T00:00:00Z"
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.time.start' })
      ]);
    }
  });

  it('DLS-CTX-002 rejects non-increasing start/end bounds with DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-time-order
  title: Invalid Time Order
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: bad-time-order
          data:
            source: runs
            time:
              start: "2026-08-02T00:00:00Z"
              end: "2026-08-01T00:00:00Z"
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.time' })
      ]);
    }
  });

  it('DLS-CTX-004 rejects invalid scope, filter, limit, and order-by shapes using DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-context
  title: Invalid Context
  defaults:
    scope:
      organizations: []
    filters:
      rollout-mode: []
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: bad-context
          data:
            source: usage
            scope:
              invalid-scope:
                - octo-org
            filters:
              repository:
                - octo-org/central-agentic-ops
                - ""
            limit: 0
            order-by:
              - field: repository
                direction: descending
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.defaults.scope.organizations' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.defaults.filters.rollout-mode' }),
          expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.pages[0].views[0].data.scope.invalid-scope' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.filters.repository[1]' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.limit' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.order-by[0].direction' })
        ])
      );
    }
  });

  it('DLS-CTX-004 DLS-CTX-006 accepts canonical filter dimensions for scalar and sequence values', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: valid-filters
  title: Valid Filters
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: findings-view
          data:
            source: findings
            filters:
              finding-status:
                - open
                - unknown
              finding-severity: critical
              rollout-mode: review
          mark: metric
          encoding:
            value:
              field: finding
              aggregate: count
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-028 validates the table column-summaries option', () => {
    const valid = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: valid-column-summaries
  title: Valid Column Summaries
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: table-view
          data:
            source: runs
          mark: table
          column-summaries: false
          encoding:
            columns:
              - field: run
`);
    const invalid = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-column-summaries
  title: Invalid Column Summaries
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: metric-view
          data:
            source: runs
          mark: metric
          column-summaries: disabled
          encoding:
            value:
              field: run
              aggregate: count
`);

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[0].column-summaries' })
        ])
      );
    }
  });

  it('DLS-VIEW-032 rejects chart data tables', () => {
    const invalid = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-chart-table
  title: Invalid Chart Table
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: chart-view
          data:
            source: usage
          mark: chart
          chart: pie
          table: true
          encoding:
            x:
              field: repository
            y:
              field: aic
              aggregate: sum
`);

    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.pages[0].views[0].table' })
        ])
      );
    }
  });

  it('DLS-SEM-004 DLS-SEM-005 DLS-SEM-006 DLS-SEM-008 DLS-SEM-009 DLS-SEM-015 reject non-canonical intrinsic enumerations in filters', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-intrinsic-enums
  title: Invalid Intrinsic Enums
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: invalid-filters
          data:
            source: runs
            filters:
              workflow-active: maybe
              run-status: in_progress
              run-conclusion: action_required
              status: passed
              eval-result: yes
              outcome-state: lifecycle_close
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.workflow-active' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.run-status' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.run-conclusion' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.status' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.eval-result' }),
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].data.filters.outcome-state' })
        ])
      );
    }
  });

  it('DLS-VIEW-001 accepts custom pages without explicit titles when ids are canonical defaults', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: custom-page-defaults
  title: Custom Page Defaults
  pages:
    - id: usage-summary
      kind: custom
      views:
        - id: total-aic
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-AGG-002 DLS-AGG-005 DLS-VIEW-006 DLS-VIEW-008 DLS-VIEW-009 accept canonical aggregates aliases and temporal bucketing for line and bar chart defaults', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: aggregation-valid
  title: Aggregation Valid
  pages:
    - id: summary
      kind: custom
      views:
        - id: aic-metric
          data:
            source: usage
            order-by:
              - field: total-aic
                direction: desc
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
              as: total-aic
        - id: value-chart
          data:
            source: operational-values
            order-by:
              - field: mean-operational-value
                direction: desc
          mark: chart
          encoding:
            x:
              field: observed-at
              type: temporal
              time-unit: day
            y:
              field: operational-value
              aggregate: mean
              type: quantitative
            color:
              field: operational-value-definition
        - id: repository-chart
          data:
            source: usage
          mark: chart
          encoding:
            x:
              field: repository
              type: nominal
            y:
              field: aic
              aggregate: sum
              type: quantitative
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-002 DLS-VIEW-008 DLS-VIEW-022 DLS-VIEW-023 accepts declarative UI elements, page icons, and field displays', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: declarative-ui
  title: Declarative UI
  pages:
    - id: operations
      kind: custom
      icon: rocket
      views:
        - id: summary
          data:
            sources: [workflows]
          mark: element
          element: summary-grid
        - id: runs
          data:
            source: runs
          mark: table
          encoding:
            columns:
              - field: run-conclusion
                display: status
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-034 accepts inert element intent and rejects empty or non-element intent', () => {
    const elementDocument = `language-version: "0.1.0"
dashboard:
  id: element-intent
  title: Element Intent
  pages:
    - id: operations
      kind: custom
      views:
        - id: summary
          intent: Help operators identify workflow states that require attention.
          data:
            sources: [workflows]
          mark: element
          element: summary-grid
`;
    expect(validateDashboardDocument(elementDocument).ok).toBe(true);

    const emptyIntent = validateDashboardDocument(
      elementDocument.replace(
        'intent: Help operators identify workflow states that require attention.',
        'intent: ""'
      )
    );
    expect(emptyIntent.ok).toBe(false);
    if (!emptyIntent.ok) {
      expect(emptyIntent.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[0].views[0].intent'
      }));
    }

    const nonElementIntent = validateDashboardDocument(
      elementDocument.replace(
        `          data:
            sources: [workflows]
          mark: element
          element: summary-grid`,
        `          data:
            source: runs
          mark: table
          encoding:
            columns:
              - field: run-conclusion`
      )
    );
    expect(nonElementIntent.ok).toBe(false);
    if (!nonElementIntent.ok) {
      expect(nonElementIntent.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E007',
        path: '$.dashboard.pages[0].views[0].intent'
      }));
    }
  });

  it('DLS-VIEW-035 accepts Boolean view-lock hints and rejects non-Boolean values', () => {
    const lockedDocument = `language-version: "0.1.0"
dashboard:
  id: locked-view
  title: Locked View
  pages:
    - id: operations
      kind: custom
      views:
        - id: summary
          locked: true
          data:
            sources: [workflows]
          mark: element
          element: summary-grid
`;
    expect(validateDashboardDocument(lockedDocument).ok).toBe(true);
    expect(validateDashboardDocument(lockedDocument.replace('locked: true', 'locked: false')).ok).toBe(true);

    const invalid = validateDashboardDocument(lockedDocument.replace('locked: true', 'locked: fixed'));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[0].views[0].locked'
      }));
    }
  });

  it('DLS-VIEW-002 DLS-VIEW-008 DLS-VIEW-022 DLS-VIEW-023 rejects inferred or unknown UI declarations', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-declarative-ui
  title: Invalid Declarative UI
  pages:
    - id: operations
      kind: custom
      icon: not-an-octicon
      views:
        - id: topology
          data:
            source: workflows
            limit: 1
          mark: element
          element: unknown-topology
          encoding: {}
        - id: runs
          data:
            sources: [runs]
          mark: table
          encoding:
            columns:
              - field: run-conclusion
                display: badge
        - id: run-count
          data:
            source: runs
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
              display: status
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].icon' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].element' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[0].data.source' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[0].data.limit' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[0].encoding' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[1].data.sources' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[1].encoding.columns[0].display' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[2].encoding.value.display' })
      ]));
    }
  });

  it('DLS-VIEW-002 DLS-VIEW-003 DLS-VIEW-004 DLS-VIEW-005 reject unknown marks and invalid mark-channel combinations', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-marks
  title: Invalid Marks
  pages:
    - id: summary
      kind: custom
      views:
        - id: unknown-mark
          data:
            source: runs
          mark: sparkline
          encoding:
            value:
              field: run
              aggregate: count
        - id: bad-metric
          data:
            source: runs
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
            x:
              field: started-at
        - id: bad-table
          data:
            source: findings
          mark: table
          encoding:
            columns:
              - field: finding-summary
            value:
              field: finding
              aggregate: count
        - id: bad-chart
          data:
            source: usage
          mark: chart
          encoding:
            x:
              field: observed-at
              type: temporal
            y:
              field: aic
              aggregate: sum
              type: nominal
            columns:
              - field: repository
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].mark' }),
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[1].encoding.x' }),
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[2].encoding.value' }),
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[3].encoding.columns' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[3].encoding.y.type' })
        ])
      );
    }
  });

  it('DLS-VIEW-005 DLS-VIEW-006 reject invalid chart default shapes with DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-chart-defaults
  title: Invalid Chart Defaults
  pages:
    - id: summary
      kind: custom
      views:
        - id: missing-temporal-bucket
          data:
            source: runs
          mark: chart
          encoding:
            x:
              field: started-at
              type: temporal
            y:
              field: run
              aggregate: count
              type: quantitative
        - id: quantitative-x-chart
          data:
            source: usage
          mark: chart
          encoding:
            x:
              field: aic
              type: quantitative
            y:
              field: aic
              aggregate: sum
              type: quantitative
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.x' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[1].encoding.x.type' })
        ])
      );
    }
  });

  it('DLS-AGG-002 DLS-AGG-005 DLS-VIEW-007 DLS-VIEW-008 DLS-VIEW-009 reject invalid field definitions and aggregate compatibility with DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-aggregation
  title: Invalid Aggregation
  pages:
    - id: summary
      kind: custom
      views:
        - id: bad-fields
          data:
            source: usage
          mark: chart
          encoding:
            x:
              field: repository
              time-unit: quarter
            y:
              field: repository
              aggregate: sum
              as: grouped-repository
            color:
              field: missing-field
            href:
              field: run-link
              as: not-allowed
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].encoding.x.time-unit' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.x.time-unit' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.y.aggregate' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.color.field' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.href.as' })
        ])
      );
    }
  });

  it('DLS-VIEW-003 rejects metric value encodings with non-quantitative type or time-unit using DLS-E010', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-metric-value
  title: Invalid Metric Value
  pages:
    - id: summary
      kind: custom
      views:
        - id: bad-metric
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: observed-at
              type: temporal
              time-unit: day
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.value.type' }),
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.value.time-unit' })
        ])
      );
    }
  });

  it('DLS-UNIT-001 DLS-UNIT-002 DLS-UNIT-004 accepts declared units referenced by field definitions', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: unit-dashboard
  title: Unit Dashboard
  units:
    aic:
      name: AI Credits
      symbol: AIC
      significant: 1
      format: number
    human-duration:
      name: Human-friendly duration
      symbol: s
      significant: 1
      format: duration
  pages:
    - id: summary
      kind: custom
      views:
        - id: total-aic
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              type: quantitative
              aggregate: sum
              unit: aic
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-008 accepts canonical formatting on compatible fields', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: formatted-workflow-path
  title: Formatted workflow path
  pages:
    - id: summary
      kind: custom
      views:
        - id: workflows
          data:
            source: workflows
          mark: table
          encoding:
            columns:
              - field: workflow
                type: nominal
                format: workflow-relative-path
              - field: repository
                type: nominal
                format: workflow-run-url
              - field: observed-at
                type: temporal
                format: human-friendly-timestamp
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-UNIT-005 accepts the canonical USD unit formatter', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: usd-dashboard
  title: USD Dashboard
  units:
    usd:
      name: US dollars
      symbol: USD
      significant: 0.001
      format: usd
  pages:
    - id: cost
      kind: custom
      views:
        - id: estimated-cost
          data:
            source: usage
          mark: table
          encoding:
            columns:
              - field: estimated-usd
                type: quantitative
                unit: usd
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-UNIT-005 rejects USD format definitions with noncanonical symbols or significance', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-usd-dashboard
  title: Invalid USD Dashboard
  units:
    wrong-symbol:
      name: US dollars
      symbol: $
      significant: 0.001
      format: usd
    wrong-significance:
      name: US dollars
      symbol: USD
      significant: 0.01
      format: usd
  pages:
    - id: cost
      kind: custom
      views:
        - id: estimated-cost
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: estimated-usd
              type: quantitative
              aggregate: sum
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.wrong-symbol' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.wrong-significance' })
      ]));
    }
  });

  it('DLS-VIEW-008 rejects unknown field formats and formats on incompatible fields', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-formatted-workflow-path
  title: Invalid formatted workflow path
  pages:
    - id: summary
      kind: custom
      views:
        - id: workflows
          data:
            source: workflows
          mark: table
          encoding:
            columns:
              - field: workflow
                type: nominal
                format: short-path
              - field: workflow
                type: quantitative
                format: workflow-relative-path
              - field: observed-at
                type: nominal
                format: human-friendly-timestamp
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].encoding.columns[0].format' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[1].format' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[2].format' })
      ]));
    }
  });

  it('DLS-VIEW-008 rejects workflow path formatting without a type on non-nominal fields', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-inferred-format
  title: Invalid inferred format
  pages:
    - id: summary
      kind: custom
      views:
        - id: workflows
          data:
            source: workflows
          mark: table
          encoding:
            columns:
              - field: workflow-link
                format: workflow-relative-path
              - field: observed-at
                format: workflow-relative-path
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[0].format' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[1].format' })
      ]));
    }
  });

  it('DLS-UNIT-004 rejects unknown formats and invalid duration unit definitions', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-duration-unit-dashboard
  title: Invalid Duration Unit Dashboard
  units:
    invalid-duration:
      name: Invalid duration
      symbol: ms
      significant: 0.1
      format: compact-duration
    malformed-duration:
      name: Malformed duration
      symbol: ms
      significant: 0.1
      format: duration
  pages:
    - id: summary
      kind: built-in
      page: overview
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.units.invalid-duration.format' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.malformed-duration' })
      ]));
    }
  });

  it('DLS-UNIT-001 DLS-UNIT-002 rejects malformed unit definitions and unknown references', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-unit-dashboard
  title: Invalid Unit Dashboard
  units:
    bad_unit:
      name: ""
      symbol: 7
      significant: 0
      extra: true
  pages:
    - id: summary
      kind: custom
      views:
        - id: total-aic
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              type: quantitative
              aggregate: sum
              unit: missing
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.units.bad_unit' }),
        expect.objectContaining({ code: 'DLS-E004', path: '$.dashboard.units.bad_unit.extra' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.bad_unit.name' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.bad_unit.symbol' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.units.bad_unit.significant' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.value.unit' })
      ]));
    }
  });

  it('DLS-LINK-001 DLS-LINK-005 DLS-VIEW-007 DLS-VIEW-014 accept relation-specific href fields and reject non-link href fields with DLS-E009', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: findings-links
  title: Findings Links
  pages:
    - id: findings-table
      kind: custom
      views:
        - id: open-findings
          data:
            source: findings
            filters:
              finding-status: open
          mark: table
          encoding:
            columns:
              - field: finding-summary
              - field: finding-severity
            href:
              field: pull-request-link
`);

    expect(accepted.ok).toBe(true);

    const rejected = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-finding-links
  title: Invalid Finding Links
  pages:
    - id: findings-table
      kind: custom
      views:
        - id: invalid-href
          data:
            source: findings
          mark: table
          encoding:
            columns:
              - field: finding-summary
            href:
              field: finding-summary
`);

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E009', path: '$.dashboard.pages[0].views[0].encoding.href.field' })
      ]);
    }
  });

  it('DLS-DATA-001 accepts inline source-metadata with the required Section 8 fields and canonical data-state values', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: valid-source-metadata
  title: Valid Source Metadata
  pages:
    - id: usage-page
      kind: custom
      views:
        - id: usage-metric
          data:
            source: usage
            source-metadata:
              source-id: usage-snapshot
              source-kind: warehouse-export
              as-of: "2026-08-28T12:00:00Z"
              retrieved-at: "2026-08-28T12:05:00Z"
              coverage-start: "2026-08-01T00:00:00Z"
              coverage-end: "2026-08-29T00:00:00Z"
              availability: empty
              completeness: partial
              freshness: stale
              provenance-link:
                relation: external
                href: "https://example.com/provenance"
                label: Provenance
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-LINK-001 DLS-SAFE-004 DLS-DATA-001 rejects invalid source-metadata provenance and data-state values with DLS-E012', () => {
    const invalidMetadataLink = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-source-metadata
  title: Invalid Source Metadata
  pages:
    - id: usage-page
      kind: custom
      views:
        - id: usage-metric
          data:
            source: usage
            source-metadata:
              source-id: usage-snapshot
              source-kind: warehouse-export
              as-of: "2026-08-28T12:00:00Z"
              retrieved-at: "2026-08-28T12:05:00Z"
              coverage-start: "2026-08-29T00:00:00Z"
              coverage-end: "2026-08-01T00:00:00Z"
              availability: missing
              completeness: partialish
              freshness: aging
              provenance-link:
                relation: external
                href: "http://example.com/provenance"
                label: Provenance
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(invalidMetadataLink.ok).toBe(false);
    if (!invalidMetadataLink.ok) {
      expect(invalidMetadataLink.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata' }),
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata.availability' }),
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata.completeness' }),
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata.freshness' }),
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata.provenance-link.href' })
        ])
      );
    }
  });

  it('DLS-AGG-009 DLS-AGG-010 rejects ambiguous aggregate outputs and order fields absent from the output grain', () => {
    const ambiguousOutput = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: ambiguous-output-id
  title: Ambiguous Output Id
  pages:
    - id: summary
      kind: custom
      views:
        - id: ambiguous-aggregate
          data:
            source: runs
          mark: table
          encoding:
            columns:
              - field: run
                aggregate: count
                as: total
              - field: repository
                aggregate: distinct-count
                as: total
`);

    expect(ambiguousOutput.ok).toBe(false);
    if (!ambiguousOutput.ok) {
      expect(ambiguousOutput.errors).toEqual([
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[1]' })
      ]);
    }

    const invalidOrderBy = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-order-by
  title: Invalid Order By
  pages:
    - id: summary
      kind: custom
      views:
        - id: ordered-aggregate
          data:
            source: runs
            order-by:
              - field: repository
                direction: asc
              - field: missing-output
                direction: desc
          mark: table
          encoding:
            columns:
              - field: run
                aggregate: count
              - field: repository
              - field: workflow
`);

    expect(invalidOrderBy.ok).toBe(false);
    if (!invalidOrderBy.ok) {
      expect(invalidOrderBy.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].data.order-by[1].field' })
        ])
      );
    }
  });

  it('DLS-SAFE-005 DLS-VAL-004 rejects secret-bearing provenance metadata without echoing the secret value', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: secret-metadata
  title: Secret Metadata
  pages:
    - id: usage-page
      kind: custom
      views:
        - id: usage-metric
          data:
            source: usage
            source-metadata:
              source-id: ghp_secretToken123456789
              source-kind: fixture
              as-of: "2026-08-29T12:00:00Z"
              retrieved-at: "2026-08-29T12:05:00Z"
              completeness: complete
              freshness: fresh
          mark: metric
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E012', path: '$.dashboard.pages[0].views[0].data.source-metadata.source-id' })
        ])
      );
      expect(result.errors.map((error) => error.message).join('\n')).not.toContain('ghp_secretToken123456789');
    }
  });

  it('DLS-VAL-001 reports code message and YAML path for each detected error', () => {
    const result = validateDashboardDocument(`language-version: "0.1"
dashboard:
  id: invalid_dashboard
  title: 42
  defaults: []
  pages: []
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const error of result.errors) {
        expect(error.code).toMatch(/^DLS-E\d{3}$/);
        expect(error.message.length).toBeGreaterThan(0);
        expect(error.path.startsWith('$')).toBe(true);
      }
    }
  });

  it('DLS-VIEW-005 DLS-VIEW-006 accepts explicit line and pie chart widgets with structural layout hints', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: chart-widgets
  title: Chart Widgets
  pages:
    - id: charts
      kind: custom
      views:
        - id: run-trend
          data:
            source: runs
          mark: chart
          chart: line
          layout: half
          encoding:
            x:
              field: started-at
              type: temporal
              time-unit: day
            y:
              field: run
              type: quantitative
              aggregate: count
        - id: conclusions
          data:
            source: runs
          mark: chart
          chart: pie
          layout: half
          encoding:
            x:
              field: run-conclusion
              type: nominal
            y:
              field: run
              type: quantitative
              aggregate: count
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-006 accepts a full-view interactive table with lazy-list rendering', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: full-view-table
  title: Full View Table
  pages:
    - id: repositories
      kind: custom
      views:
        - id: repository-table
          data:
            source: repositories
          mark: table
          controls: interactive
          lazy-list: true
          layout: full-view
          encoding:
            columns:
              - field: repository
                type: nominal
`);

    expect(result.ok).toBe(true);
  });

  it('rejects lazy-list rendering on a static table', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-lazy-table
  title: Invalid Lazy Table
  pages:
    - id: repositories
      kind: custom
      views:
        - id: repository-table
          data:
            source: repository-activity
          mark: table
          controls: static
          lazy-list: true
          encoding:
            columns:
              - field: repository
                type: nominal
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[0].views[0].lazy-list'
      }));
    }
  });

  it('DLS-VIEW-005 accepts temporal dot charts with quantitative references', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: rate-limit-chart
  title: Rate-limit chart
  pages:
    - id: github-api
      kind: custom
      views:
        - id: remaining
          data:
            source: github-api-rate-limits
          mark: chart
          chart: dot
          encoding:
            x:
              field: observed-at
              type: temporal
            y:
              field: remaining
              type: quantitative
            color:
              field: resource
              type: nominal
            reference:
              field: limit
              type: quantitative
`);

    expect(result.ok).toBe(true);
  });

  it('DLS-VIEW-005 accepts temporal scatter charts with unbucketed observations', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: rate-limit-scatter
  title: Rate-limit scatter
  pages:
    - id: github-api
      kind: custom
      views:
        - id: remaining
          data:
            source: github-api-rate-limits
          mark: chart
          chart: scatter
          encoding:
            x:
              field: observed-at
              type: temporal
            y:
              field: remaining-percent
              type: quantitative
            color:
              field: maximum-lane
              type: nominal
`);

    expect(result.ok).toBe(true);
  });

  it('accepts unbucketed categorical swimlanes and rejects quantitative or aggregated lanes', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const overview = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'operations');
    const overviewSwimlane = overview.definition.views.find((/** @type {{ id: string }} */ view) => view.id === 'overview-run-health');
    const workflowRuntime = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runtime');
    const swimlane = workflowRuntime.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runtime-health');
    const routeChrome = workflowRuntime.views.find((/** @type {{ id: string, element?: string }} */ view) => view.id === 'workflow-runtime-route');

    expect(overviewSwimlane).toMatchObject({
      chart: 'swimlane',
      encoding: {
        x: { field: 'started-at', type: 'temporal' },
        y: { field: 'run-conclusion', type: 'ordinal' },
        href: { field: 'run-link' }
      }
    });
    expect(swimlane).toMatchObject({
      chart: 'swimlane',
      encoding: {
        x: { field: 'started-at', type: 'temporal' },
        y: { field: 'run-conclusion', type: 'ordinal' },
        href: { field: 'run-link' }
      }
    });
    expect(routeChrome).toMatchObject({
      mark: 'element',
      element: 'workflow-route-page'
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    swimlane.encoding.y = { field: 'run', type: 'quantitative', aggregate: 'count' };
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'DLS-E010',
          path: expect.stringContaining('.encoding.y')
        })
      ]));
    }
  });

  it('DLS-VIEW-005 DLS-VIEW-006 rejects incompatible chart widgets and unknown layout hints', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-chart-widgets
  title: Invalid Chart Widgets
  pages:
    - id: charts
      kind: custom
      views:
        - id: invalid-pie
          data:
            source: runs
          mark: chart
          chart: pie
          layout: wide
          encoding:
            x:
              field: started-at
              type: temporal
            y:
              field: run
              type: quantitative
              aggregate: count
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].views[0].layout' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.x.type' })
      ]));
    }
  });
});

describe('declarative query validation', () => {
  const queryDocument = (/** @type {unknown} */ queries, /** @type {string} */ source = 'workflow-costs') => JSON.stringify({
    'language-version': '0.1.0',
    dashboard: {
      id: 'query-dashboard',
      title: 'Query Dashboard',
      queries: Array.isArray(queries)
        ? queries.map(query => query && typeof query === 'object'
          ? { intent: 'Preserve the original query request for future modifications.', ...query }
          : query)
        : queries,
      pages: [{
        id: 'derived',
        kind: 'custom',
        title: 'Derived',
        views: [{
          id: 'derived-table',
          title: 'Derived',
          data: { source },
          mark: 'table',
          encoding: { columns: [{ field: 'workflow', type: 'nominal', title: 'Workflow' }] }
        }]
      }]
    }
  });

  const validQuery = {
    name: 'workflow-costs',
    description: 'Declared workflows joined with observed AI Credit totals.',
    from: 'workflows',
    joins: [{
      source: 'workflow-aic',
      type: 'left',
      on: [{ left: 'workflow', right: 'workflow' }],
      fields: [{ field: 'aic', as: 'observed-aic' }]
    }],
    filter: { predicates: [{ field: 'workflow-active', equals: 'true' }] },
    compute: [{ as: 'total-aic', function: 'coalesce', args: [{ field: 'observed-aic' }, { value: 0 }] }],
    select: [{ field: 'workflow' }, { field: 'total-aic', as: 'aic' }],
    'order-by': [{ field: 'workflow', direction: 'asc' }],
    limit: 500
  };

  const aicQuery = {
    name: 'workflow-aic',
    from: 'usage',
    aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] }
  };

  it('accepts a derived query used as a logical source', () => {
    expect(validateDashboardDocument(queryDocument([aicQuery, validQuery])).ok).toBe(true);
  });

  it('requires a non-empty original intent for every query', () => {
    for (const intent of [undefined, '', 42]) {
      const result = validateDashboardDocument(queryDocument([{ ...aicQuery, intent }]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(expect.objectContaining({
          code: 'DLS-E003',
          path: '$.dashboard.queries[0].intent'
        }));
      }
    }
  });

  it('rejects unknown query sources, duplicate names, and canonical name shadowing', () => {
    const result = validateDashboardDocument(queryDocument([
      { name: 'runs', from: 'workflows' },
      { name: 'workflow-costs', from: 'mystery' },
      { name: 'workflow-costs', from: 'workflows' }
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].name' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].from' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[2].name' })
      ]));
    }
  });

  it('rejects unknown fields, invalid join types, and forward query references', () => {
    const result = validateDashboardDocument(queryDocument([{
      name: 'workflow-costs',
      from: 'workflows',
      joins: [{
        source: 'workflow-aic',
        type: 'cross',
        on: [{ left: 'missing-left', right: 'workflow' }],
        fields: [{ field: 'aic', as: 'observed-aic' }]
      }]
    }, aicQuery]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].joins[0].source' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].joins[0].type' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.queries[0].joins[0].on[0].left' })
      ]));
    }
  });

  it('rejects self references and dependency cycles between queries', () => {
    const result = validateDashboardDocument(queryDocument([
      { name: 'workflow-costs', from: 'workflow-costs' },
      {
        name: 'cyclic-costs',
        from: 'workflows',
        joins: [{
          source: 'cyclic-costs',
          on: [{ left: 'workflow', right: 'workflow' }],
          fields: [{ field: 'workflow', as: 'joined-workflow' }]
        }]
      }
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].from' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].joins[0].source' })
      ]));
    }
  });

  it('rejects keyless joins, excessive join chains, and out-of-range limits', () => {
    const join = {
      source: 'workflow-aic',
      on: [{ left: 'workflow', right: 'workflow' }],
      fields: [{ field: 'aic', as: 'observed-aic' }]
    };
    const result = validateDashboardDocument(queryDocument([aicQuery, {
      name: 'workflow-costs',
      from: 'workflows',
      joins: [{ ...join, on: [] }],
      limit: DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1
    }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].joins[0].on' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.queries[1].limit' })
      ]));
    }

    const chained = validateDashboardDocument(queryDocument([aicQuery, {
      name: 'workflow-costs',
      from: 'workflows',
      joins: Array.from({ length: QUERY_MAX_JOINS + 1 }, (_, index) => ({
        ...join,
        fields: [{ field: 'aic', as: `observed-aic-${index}` }]
      }))
    }]));
    expect(chained.ok).toBe(false);
    if (!chained.ok) {
      expect(chained.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.queries[1].joins' })
      ]));
    }
  });

  it('rejects output name collisions between joined and computed fields', () => {
    const result = validateDashboardDocument(queryDocument([aicQuery, {
      ...validQuery,
      joins: [{
        source: 'workflow-aic',
        type: 'left',
        on: [{ left: 'workflow', right: 'workflow' }],
        fields: [{ field: 'aic', as: 'workflow' }]
      }],
      compute: [{ as: 'workflow', function: 'trim', args: [{ field: 'workflow' }] }],
      select: [{ field: 'workflow' }, { field: 'workflow', as: 'workflow' }]
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].joins[0].fields[0].as' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].compute[0].as' }),
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[1].select[1].as' })
      ]));
    }
  });

  it('rejects computed functions outside the closed vocabulary and wrong argument counts', () => {
    const result = validateDashboardDocument(queryDocument([{
      name: 'workflow-costs',
      from: 'workflows',
      compute: [
        { as: 'evaluated', function: 'eval', args: [{ field: 'workflow' }] },
        { as: 'divided', function: 'quotient', args: [{ field: 'workflow' }] },
        { as: 'invalid-argument', function: 'trim', args: [{ field: 'workflow', value: 'both' }] }
      ]
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.queries[0].compute[0].function' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.queries[0].compute[1].args' }),
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.queries[0].compute[2].args[0]' })
      ]));
    }
  });

  it('rejects references to fields the query no longer produces', () => {
    const result = validateDashboardDocument(queryDocument([{
      name: 'workflow-costs',
      from: 'workflows',
      select: [{ field: 'workflow' }],
      'order-by': [{ field: 'repository', direction: 'asc' }]
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.queries[0].order-by[0].field' })
      ]));
    }
  });

  it('rejects view fields that the derived output schema does not declare and limits beyond the documented maximum', () => {
    const document = JSON.parse(queryDocument([aicQuery, validQuery]));
    document.dashboard.queries[1].limit = 1000000;
    document.dashboard.pages[0].views[0].encoding.columns.push({ field: 'observed-aic', type: 'quantitative', title: 'Observed' });
    const result = validateDashboardDocument(JSON.stringify(document));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.queries[1].limit' }),
        expect.objectContaining({ code: 'DLS-E010', path: '$.dashboard.pages[0].views[0].encoding.columns[1].field' })
      ]));
    }
  });

  it('rejects structured link fields used where the schema requires a scalar', () => {
    const result = validateDashboardDocument(queryDocument([aicQuery, {
      name: 'workflow-costs',
      from: 'workflows',
      joins: [
        {
          source: 'workflow-aic',
          type: 'left',
          on: [{ left: 'workflow-link', right: 'workflow' }],
          fields: [{ field: 'aic', as: 'observed-aic' }]
        },
        {
          source: 'runs',
          type: 'left',
          on: [{ left: 'workflow', right: 'run-link' }],
          fields: [{ field: 'run-status', as: 'observed-status' }]
        }
      ],
      filter: { predicates: [{ field: 'repository-link', equals: 'octo/demo' }] },
      compute: [{ as: 'link-label', function: 'lower', args: [{ field: 'organization-link' }] }],
      select: [{ field: 'workflow' }, { field: 'workflow-link' }],
      'order-by': [{ field: 'workflow-link', direction: 'asc' }]
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].joins[0].on[0].left' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].joins[1].on[0].right' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].filter.predicates[0].field' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].compute[0].args[0].field' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].order-by[0].field' })
      ]));
      expect(result.errors).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[1].select[1].field' })
      ]));
    }
  });

  it('rejects numeric operators applied to temporal schema fields', () => {
    const result = validateDashboardDocument(queryDocument([{
      name: 'workflow-costs',
      from: 'runs',
      compute: [{ as: 'start-number', function: 'number', args: [{ field: 'started-at' }] }],
      aggregate: {
        by: ['workflow'],
        values: [
          { field: 'started-at', as: 'first-start', reducer: 'min' },
          { field: 'run', as: 'observed-runs', reducer: 'distinct-count' }
        ]
      }
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[0].compute[0].args[0].field' }),
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[0].aggregate.values[0].field' })
      ]));
      expect(result.errors).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[0].aggregate.values[1].field' })
      ]));
    }
  });

  it('rejects fields that only exist after post-query link inference', () => {
    const result = validateDashboardDocument(queryDocument([{
      name: 'workflow-costs',
      from: 'packaged-workflows',
      select: [{ field: 'workflow' }, { field: 'package-link' }]
    }]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'DLS-E011', path: '$.dashboard.queries[0].select[1].field' })
      ]));
    }
  });
});
