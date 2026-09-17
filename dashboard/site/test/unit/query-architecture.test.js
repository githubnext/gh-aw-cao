import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** @param {string} path */
const read = (path) => readFileSync(resolve(path), 'utf8');

describe('dashboard query architecture', () => {
  it('gives agents an explicit database-authoritative query and effect contract', () => {
    const guidance = read('../../AGENTS.md');

    expect(guidance).toContain('Eliminate every JavaScript-based dashboard query.');
    expect(guidance).toContain('executed by the query engine in the data Web Worker against the canonical database');
    expect(guidance).toContain('Keep the active page or view subscribed to its worker query');
    expect(guidance).toContain('Effects may synchronize query results and local interaction state to owned DOM only.');
  });

  it('executes dashboard queries and subscriptions through the canonical data worker', () => {
    const worker = read('src/data-worker.js');
    const startup = read('src/data/startup.js');
    const presenter = read('src/presenter.js');
    const factoryElements = read('src/components/factory-elements.js');
    const workProject = read('src/components/work-project-view.js');
    const presentationQueryFixture = read('test/workflow-inventory-query.js');
    const canonicalSources = read('src/data/queries/view-sources.js');
    const dashboard = JSON.parse(read('dashboard.json')).dashboard;
    const optimizationDashboard = JSON.parse(read('../../optimization/dashboard.json')).dashboard;

    expect(worker).toMatch(/executeDashboardQueries\(\s*context\.queries,\s*\{ \.\.\.canonicalPayload, \.\.\.healthPayload \},\s*directRequests/);
    expect(worker).toContain('const replacedSources = new Set(viewPayload.replacedSources)');
    expect(worker).toContain('deriveDataHealthCalloutSources(canonicalPayload)');
    expect(worker).not.toMatch(/deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources/);
    expect(worker).toContain("operation === 'subscribe-canonical-dashboard'");
    expect(startup).toContain('subscribeCanonicalDashboardView(');
    expect(startup).toContain('signal: pageOptions.signal');
    expect(startup).toContain('bindContinuations(pageId, sources, paginatedSources, pageOptions)');
    expect(startup).toContain('const sourceName = bindings[alias]?.sourceName');
    expect(startup).toContain('dashboardContext,\n        pagination,');
    expect(startup).toContain('viewId: binding?.viewId');
    expect(startup).toContain('routeParameters: pageOptions.routeParameters');
    expect(startup).toContain('queryContext: pageOptions.queryContext');
    expect(presenter).not.toMatch(/filterDashboardSources|filterRowsForView|deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources/);
    expect(factoryElements).not.toMatch(/connectedRepositoryCoverage|latestOutcomes|activityDays|exceedsThreshold|workerCount/);
    expect(factoryElements).toMatch(/requestSource|publishSource/);
    expect(factoryElements).not.toMatch(/indexedDB/);
    expect(workProject).not.toMatch(/normalizeState|actorForLifecycle|compareWorkItems|orchestratedPackageNames/);
    expect(read('src/components/ui-elements.js')).not.toContain('filterRows');
    expect(presentationQueryFixture).toContain("operation: 'execute-dashboard-queries'");
    expect(presentationQueryFixture).not.toMatch(/executeDashboardQueries|compileDashboardViewPayloadQueries|deriveDashboardLinkSources/);
    expect(canonicalSources).not.toContain('tokenEfficiencySources');
    expect(dashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-opportunities'))
      .toBeUndefined();
    expect(dashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-interventions'))
      .toBeUndefined();
    expect(optimizationDashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-opportunities')?.from)
      .toBe('events');
    expect(optimizationDashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-interventions')?.from)
      .toBe('events');
    for (const legacyModule of [
      'inferred-sources.js',
      'notification-stories.js',
      'overview-data.js',
      'repository-data.js',
      'runtime-data.js',
      'workflow-data.js',
      'components/notifications-inbox.js'
    ]) {
      expect(existsSync(resolve('src', legacyModule))).toBe(false);
    }
  });
});