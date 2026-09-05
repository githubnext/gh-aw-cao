import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDashboardDocument, validateLogicalSources } from '../../src/validator.js';
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

  it('accepts static tree tables and rejects hierarchy-breaking controls', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const apiPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'github-api');
    const stackView = apiPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'github-api-call-stacks');

    expect(stackView).toMatchObject({
      mark: 'table',
      controls: 'static',
      tree: {
        'id-field': 'stack-frame-id',
        'parent-field': 'stack-parent-id'
      }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    stackView.controls = 'interactive';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'tree tables must use static controls to preserve hierarchy.' })
    ]));
  });

  it('defines the Preview issue attribution views', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const preview = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'preview');

    expect(preview).toMatchObject({
      kind: 'custom',
      title: 'Preview',
      views: [
        {
          id: 'preview-issues-by-package',
          mark: 'chart',
          chart: 'pie',
          data: {
            source: 'outcomes',
            filters: { 'outcome-category': ['issue'] }
          }
        },
        {
          id: 'preview-issue-ledger',
          mark: 'table',
          data: {
            source: 'outcomes',
            filters: {
              'outcome-category': ['issue'],
              'workflow-role': ['worker']
            }
          }
        }
      ]
    });

    expect(preview.views[1].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field)).toEqual([
      'package',
      'workflow-name',
      'outcome-title',
      'outcome-status',
      'repository',
      'observed-at'
    ]);
  });

  it('defines the control-plane Admission page from structured admission sources', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const admission = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'admission');

    expect(admission.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'admission-decision-distribution',
      'admission-decision-trend',
      'admission-failed-gates',
      'admission-decision-ledger'
    ]);
    expect(admission.views[0]).toMatchObject({
      mark: 'chart',
      chart: 'pie',
      data: { source: 'admissions' }
    });
    expect(admission.views[2]).toMatchObject({
      data: {
        source: 'admission-checks',
        filters: { 'check-status': ['failed'] }
      }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines workflow update inventory and version distribution views', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const updates = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'updates');
    expect(updates).toMatchObject({
      kind: 'custom',
      views: [
        {
          id: 'workflow-versions',
          mark: 'chart',
          chart: 'pie',
          data: { source: 'workflows' },
          encoding: {
            x: { field: 'gh-aw-version-label' },
            y: { field: 'workflow', aggregate: 'count' }
          }
        },
        {
          id: 'workflow-updates',
          mark: 'table',
          data: { source: 'workflows' }
        }
      ]
    });

    expect(updates.views[1].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field)).toEqual([
      'workflow',
      'repository',
      'gh-aw-version',
      'gh-aw-current-version',
      'gh-aw-update-state'
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('accepts canonical route body values and rejects non-canonical config.body values', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const workflowRouteView = document.dashboard.pages.find((/** @type {{ id: string, views: Array<any> }} */ page) => page.id === 'workflow-detail')
      .views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-reports-route');

    expect(workflowRouteView).toMatchObject({
      mark: 'element',
      element: 'workflow-route',
      config: { body: 'reports' }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);

    workflowRouteView.config.body = 'report';
    const rejected = validateDashboardDocument(JSON.stringify(document));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'workflow-route config.body must use one canonical route body value.' })
    ]));
  });

  it('defines an evidence-aware firewall operations page', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const firewall = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'firewall');
    const security = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'security');
    expect(security.sections.map((/** @type {{ views: string[] }} */ section) => section.views)).toEqual([
      ['security-summary', 'security-signals'],
      ['security-output-ledger']
    ]);
    expect(security.views).not.toContainEqual(expect.objectContaining({ id: 'security-firewall-decisions' }));
    expect(security.views).not.toContainEqual(expect.objectContaining({ id: 'security-findings-summary' }));
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('firewall');
    expect(firewall.description).toBe('Network enforcement, policy decisions, destination drift, and evidence for agent egress.');
    expect(firewall.sections.map((/** @type {{ title: string, views: string[] }} */ section) => ({
      title: section.title,
      views: section.views
    }))).toEqual([
      { title: 'Enforcement posture', views: ['security-firewall-decisions'] },
      { title: 'Requires review', views: ['firewall-requires-review'] },
      { title: 'Network drift', views: ['firewall-network-drift'] },
      { title: 'Policy effectiveness', views: ['firewall-policy-rules'] },
      { title: 'Domain activity', views: ['security-firewall-domains'] },
      { title: 'Traffic diagnostics', views: ['security-firewall-trend'] },
      { title: 'Evidence and coverage', views: ['firewall-evidence-coverage'] }
    ]);
    const [posture, review, drift, policy, domains, trend, evidence] = firewall.views;
    expect(posture).toMatchObject({
      id: 'security-firewall-decisions',
      mark: 'chart',
      chart: 'pie',
      disclosure: 'essential',
      data: { source: 'firewall-observations', time: { range: '30d' } }
    });
    expect(review).toMatchObject({
      id: 'firewall-requires-review',
      mark: 'table',
      controls: 'interactive',
      disclosure: 'essential',
      data: {
        source: 'firewall-observations',
        time: { range: '30d' },
        filters: {
          'review-state': expect.arrayContaining(['enforcement-disabled', 'evidence-missing', 'newly-allowed', 'decision-changed'])
        }
      }
    });
    expect(review.encoding.actions[0]).toMatchObject({
      presentation: 'copy-prompt',
      label: 'Investigate',
      context: expect.arrayContaining(['repository', 'workflow', 'run', 'domain', 'port', 'current-decision', 'policy-rule-id', 'request-count', 'drift-state', 'evidence-link'])
    });
    expect(drift).toMatchObject({
      id: 'firewall-network-drift',
      mark: 'chart',
      chart: 'pie',
      data: { source: 'firewall-observations' }
    });
    expect(policy).toMatchObject({
      id: 'firewall-policy-rules',
      mark: 'table',
      disclosure: 'supplemental',
      data: { source: 'firewall-policy-rules' }
    });
    expect(domains).toMatchObject({
      id: 'security-firewall-domains',
      mark: 'table',
      controls: 'interactive',
      disclosure: 'essential',
      data: { source: 'firewall-observations', time: { range: '30d' } }
    });
    expect(domains.encoding.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'domain' }),
      expect.objectContaining({ field: 'decision-label' }),
      expect.objectContaining({ field: 'request-count', title: 'Requests' }),
      expect.objectContaining({ field: 'policy-rule-id', title: 'Policy rule' }),
      expect.objectContaining({ field: 'drift-label', title: 'Change' }),
      expect.objectContaining({ field: 'run' })
    ]));
    expect(domains.encoding.href).toEqual({ field: 'evidence-link', type: 'nominal' });
    expect(trend).toMatchObject({
      id: 'security-firewall-trend',
      mark: 'chart',
      chart: 'line',
      disclosure: 'supplemental',
      data: { source: 'firewall-observations', time: { range: '30d' } }
    });
    expect(evidence).toMatchObject({
      id: 'firewall-evidence-coverage',
      mark: 'table',
      disclosure: 'supplemental',
      data: { source: 'firewall-observations', time: { range: '30d' } }
    });
    const serialized = JSON.stringify(firewall).toLowerCase();
    expect(serialized).not.toContain('blocked = failure');
    expect(serialized).not.toContain('allowed = safe');
    expect(serialized).not.toContain('risk score');
    expect(serialized).not.toContain('allow domain');
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines MCP diagnostics in a dedicated Explore page', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const mcps = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'mcps');
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('mcps');
    expect(mcps).toMatchObject({
      kind: 'custom',
      'navigation-label': 'MCPs',
      views: [
        {
          id: 'mcp-status-distribution',
          mark: 'chart',
          chart: 'pie',
          data: { source: 'mcp-servers' }
        },
        {
          id: 'mcp-response-size-distribution',
          mark: 'chart',
          chart: 'histogram',
          data: { source: 'mcp-calls' }
        },
        {
          id: 'mcp-server-inventory',
          mark: 'table',
          controls: 'interactive',
          data: { source: 'mcp-servers' }
        }
      ]
    });
    expect(mcps.views[2].encoding.columns.map((/** @type {{ field: string }} */ column) => column.field)).toEqual([
      'mcp-server',
      'mcp-server-version',
      'mcp-protocol-version',
      'gh-aw-version',
      'mcp-status',
      'tool-calls',
      'failed-calls',
      'total-response-bytes',
      'max-response-bytes',
      'repository',
      'workflow',
      'run',
      'observed-at'
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines detection diagnostics and performance in a dedicated Explore page', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const detection = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'detection');
    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('detection');
    expect(detection.description).toContain('Threat-detection verdicts');
    expect(detection.sections.map((/** @type {{ id: string }} */ section) => section.id)).toEqual([
      'detection-health',
      'security-findings',
      'requires-attention',
      'reliability-performance'
    ]);
    expect(detection.views.slice(0, 5)).toMatchObject([
      { id: 'detection-state-distribution', mark: 'chart', chart: 'pie', data: { source: 'detection-observations' }, disclosure: 'essential' },
      { id: 'detection-verdict-coverage', mark: 'metric', data: { source: 'detection-observations' }, disclosure: 'essential' },
      { id: 'detection-state-trend', mark: 'chart', chart: 'line', data: { source: 'detection-observations' }, disclosure: 'supplemental' },
      { id: 'detection-security-findings', mark: 'chart', chart: 'bar', data: { source: 'security-observations' }, disclosure: 'essential' },
      { id: 'detection-attention', mark: 'table', controls: 'interactive', data: { source: 'detection-observations' }, disclosure: 'essential' }
    ]);
    expect(detection.views.slice(5).map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'detection-job-conclusions',
      'detection-job-duration-trend',
      'detection-job-runner-performance',
      'detection-job-ledger'
    ]);
    expect(detection.views.slice(5).every(
      (/** @type {{ disclosure: string }} */ view) => view.disclosure === 'supplemental'
    )).toBe(true);
    expect(detection.views[4].encoding.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'detection-state', display: 'status' }),
      expect.objectContaining({ field: 'detection-signal' }),
      expect.objectContaining({ field: 'inspection-warning' }),
      expect.objectContaining({ field: 'run' })
    ]));
    expect(detection.views[4].encoding.href).toEqual({ field: 'run-link', type: 'nominal' });
    expect(detection.views[8].encoding.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'job-status', display: 'status' }),
      expect.objectContaining({ field: 'job-conclusion', display: 'status' }),
      expect.objectContaining({ field: 'job-duration-seconds', unit: 'human-duration' }),
      expect.objectContaining({ field: 'run' })
    ]));
    expect(detection.views[8].encoding.href).toEqual({ field: 'run-link', type: 'nominal' });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines safe-output diagnostics and performance in Explore', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const safeOutputs = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'safe-outputs');

    expect(document.dashboard.navigation.find(
      (/** @type {{ label: string }} */ section) => section.label === 'Explore'
    ).pages).toContain('safe-outputs');
    expect(safeOutputs.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'safe-output-distribution',
      'safe-output-trend',
      'safe-output-workflow-performance',
      'safe-output-diagnostics'
    ]);
    expect(safeOutputs.views[0]).toMatchObject({
      mark: 'chart',
      chart: 'pie',
      data: { source: 'safe-output-performance' },
      encoding: {
        x: { field: 'safe-output-label' },
        y: { field: 'safe-output-count', aggregate: 'sum' },
        color: { field: 'safe-output-status' }
      }
    });
    expect(safeOutputs.views[3].encoding.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'safe-output-kind', title: 'Signal' }),
      expect.objectContaining({ field: 'safe-output-status', display: 'status' }),
      expect.objectContaining({ field: 'safe-output-count', title: 'Items' }),
      expect.objectContaining({ field: 'run-conclusion', display: 'status' })
    ]));
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

  it('defines workflow route composition through a reusable workflow-route element', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const reportsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-detail');
    const runsPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runs');
    const runtimePage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'workflow-runtime');

    expect(reportsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-reports-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route',
      config: { body: 'reports' }
    });
    expect(runsPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runs-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route',
      config: { body: 'runs' }
    });
    expect(runtimePage.views.find((/** @type {{ id: string }} */ view) => view.id === 'workflow-runtime-route')).toMatchObject({
      mark: 'element',
      element: 'workflow-route',
      config: { body: 'insights' }
    });
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('defines the packages page through a reusable package activity shell element', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const packagesPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'packages');

    expect(packagesPage.definition.views).toEqual([
      expect.objectContaining({
        id: 'packages-by-aic',
        mark: 'chart'
      }),
      expect.objectContaining({
        id: 'packages-activity-shell',
        mark: 'element',
        element: 'package-activity-shell',
        data: {
          sources: ['workflows', 'usage', 'runs', 'outcomes', 'findings']
        }
      })
    ]);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
  });

  it('accepts workflow-route config.body and rejects unsupported values', () => {
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
          element: workflow-route
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
          element: workflow-route
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

  it('accepts experiments-evaluation config.body and rejects unsupported values', () => {
    const accepted = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: experiments-view-config
  title: Experiments view config
  pages:
    - id: experiments-page
      kind: custom
      title: Experiments page
      views:
        - id: experiments-shell
          data:
            sources: [experiments, experiment-assignments, graders, grader-observations, evals, eval-observations, runs]
          mark: element
          element: experiments-evaluation
          config:
            body: table
`);
    expect(accepted.ok).toBe(true);

    const invalidBody = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: experiments-view-config
  title: Experiments view config
  pages:
    - id: experiments-page
      kind: custom
      title: Experiments page
      views:
        - id: experiments-shell
          data:
            sources: [experiments, experiment-assignments, graders, grader-observations, evals, eval-observations, runs]
          mark: element
          element: experiments-evaluation
          config:
            body: filters
`);
    expect(invalidBody.ok).toBe(false);
    if (!invalidBody.ok) {
      expect(invalidBody.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E005',
        path: '$.dashboard.pages[0].views[0].config.body'
      }));
    }
  });

  it('accepts every package dashboard document', () => {
    for (const source of packageDashboardSources) {
      expect(validateDashboardDocument(source).ok).toBe(true);
    }
  });

  it('DLS-VIEW-005 accepts automatically binned histograms and rejects ambiguous histogram channels', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const costPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'cost');
    const histogram = costPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'cost-per-run-distribution');

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
        path: '$.dashboard.pages[3].views[1].encoding.color'
      }));
    }
  });

  it('DLS-VIEW-005 accepts bounded heatmaps and rejects invalid axes, values, and limits', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const performance = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'performance');
    const heatmap = performance.views.find((/** @type {{ id: string }} */ view) => view.id === 'job-duration-by-job-runner');

    expect(heatmap).toMatchObject({
      chart: 'heatmap',
      data: { source: 'job-performance', limit: 100 },
      encoding: {
        x: { field: 'job', type: 'nominal' },
        y: { field: 'runner', type: 'nominal' },
        color: { field: 'job-duration-seconds', type: 'quantitative', aggregate: 'mean' }
      }
    });
    expect(performance.sections.map((/** @type {{ id: string }} */ section) => section.id)).toEqual([
      'workflow-duration',
      'job-duration'
    ]);
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
      'aw-doctor-dashboard',
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
      expect(document.dashboard.navigation).toEqual([{ label: 'Package operations', pages: [pageId] }]);
      expect(page).toMatchObject({ kind: 'custom' });
      expect(page.views).toHaveLength(4);
      expect(page.views.every(
        (/** @type {{ disclosure?: string }} */ view) => view.disclosure === 'essential'
      )).toBe(true);
      const sources = page.views.map(
        (/** @type {{ data: { source: string } }} */ view) => view.data.source
      );
      expect(sources.sort()).toEqual(['operational-values', 'operational-values', 'outcomes', 'runs'].sort());
    }
  });

  it('keeps the AW Doctor run inventory aligned with the built-in run table', () => {
    const builtInDocument = JSON.parse(authoritativeDashboardSource);
    const builtInRunView = builtInDocument.dashboard.pages
      .find((/** @type {{ id: string }} */ page) => page.id === 'runs')
      .definition.views.find((/** @type {{ id: string }} */ view) => view.id === 'runs-runs-source');
    const awMaintenanceDocument = packageDashboardSources
      .map((source) => JSON.parse(source))
      .find((document) => document.dashboard.id === 'aw-doctor-dashboard');
    const runView = awMaintenanceDocument.dashboard.pages[0].views
      .find((/** @type {{ id: string }} */ view) => view.id === 'aw-doctor-runs');

    expect(runView).toMatchObject({
      mark: 'table',
      controls: 'interactive',
      encoding: {
        href: builtInRunView.encoding.href,
        columns: builtInRunView.encoding.columns.filter(
          (/** @type {{ field: string }} */ column) => column.field !== 'engine-version'
        )
      }
    });
    expect(runView.description).toContain('which AW Doctor failures need attention first');
    expect(runView.encoding.columns.some(
      (/** @type {{ field: string }} */ column) => column.field === 'engine-version'
    )).toBe(false);
  });

  it('validates source-free JSON callouts with canonical icons', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    const costPage = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'cost');
    const callout = costPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'cost-evaluation-boundary');
    expect(callout).toMatchObject({
      mark: 'callout',
      callout: { label: 'Evaluation boundary', icon: 'meter' }
    });
    expect(callout.description).toContain('partial AI Credit telemetry');
    const valuePage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'operational-value'
    );
    expect(valuePage).toBeDefined();
    const valueCallout = valuePage.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'experiment-evidence-boundary'
    );
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
        path: '$.dashboard.pages[3].views[5].callout.icon'
      }));
      expect(rejected.errors).toContainEqual(expect.objectContaining({
        code: 'DLS-E003',
        path: '$.dashboard.pages[3].views[5].data',
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

    const withoutLabel = JSON.parse(authoritativeDashboardSource);
    delete withoutLabel.dashboard.navigation[0].label;
    const withoutLabelResult = validateDashboardDocument(JSON.stringify(withoutLabel));
    expect(withoutLabelResult.ok).toBe(false);
    if (!withoutLabelResult.ok) {
      expect(withoutLabelResult.errors).toContainEqual(expect.objectContaining({
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
        '      visible-when:',
        '        source: coverage-diagnostics',
        '        field: kind',
        '        equals: github-api-rate-limit-403',
        ''
      ].join('\n')
    );
    expect(validateDashboardDocument(withCallout).ok).toBe(true);

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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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

  it('DLS-PAGE-001 rejects an explicit built-in page title when it differs from the canonical title default', () => {
    const result = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: mismatched-built-in-title
  title: Mismatched Built-in Title
  pages:
    - id: runs
      kind: built-in
      page: runs
      title: Run Details
`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E005', path: '$.dashboard.pages[0].title' })
        ])
      );
    }
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
            message: 'built-in page "packages" requires declarative definitions for source "workflows".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            message: 'built-in page "packages" requires declarative definitions for source "runs".'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            message: 'built-in page "packages" requires declarative definitions for source "usage".'
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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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

  it('DLS-PAGE-014 rejects a built-in page definition that does not expose independent availability, completeness, and freshness', () => {
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
            message: 'built-in page definition must expose independent availability, completeness, and freshness state.'
          })
        ])
      );
    }
  });

  it('DLS-PAGE-014 rejects a built-in page definition with non-canonical independent data-state markers', () => {
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
          completeness: false
          freshness: maybe
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
            message: 'built-in page definition must expose independent availability state with canonical boolean true.'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.data-state.completeness',
            message: 'built-in page definition must expose independent completeness state with canonical boolean true.'
          }),
          expect.objectContaining({
            code: 'DLS-E003',
            path: '$.dashboard.pages[0].definition.data-state.freshness',
            message: 'built-in page definition must expose independent freshness state with canonical boolean true.'
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
          completeness: true
          freshness: true
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
            data:
              source: usage
            mark: metric
            encoding:
              value:
                field: aic
                aggregate: sum
          - id: recent-findings
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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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
          completeness: true
          freshness: true
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
  title: Overview Provenance Freshness
  pages:
    - id: overview
      kind: built-in
      page: overview
      title: Overview
      definition:
        data-state:
          availability: true
          completeness: true
          freshness: true
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
                - .github/workflows/dashboard.yml
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

  it('DLS-VIEW-032 validates the chart table option', () => {
    const valid = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: valid-chart-table
  title: Valid Chart Table
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: chart-view
          data:
            source: usage
          mark: chart
          chart: pie
          table: false
          encoding:
            x:
              field: repository
            y:
              field: aic
              aggregate: sum
`);
    const invalid = validateDashboardDocument(`language-version: "0.1.0"
dashboard:
  id: invalid-chart-table
  title: Invalid Chart Table
  pages:
    - id: custom-page
      kind: custom
      views:
        - id: metric-view
          data:
            source: usage
          mark: metric
          table: hidden
          encoding:
            value:
              field: aic
              aggregate: sum
`);

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'DLS-E003', path: '$.dashboard.pages[0].views[0].table' })
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
    const overview = document.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'overview');
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
      element: 'workflow-route'
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
