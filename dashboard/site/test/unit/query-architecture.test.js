import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_FIELDS } from '../../src/specification.js';

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
    const databaseAccess = read('src/data/queries/database.js');
    const databaseQueries = JSON.parse(read('src/data/queries/database.json'));
    const dashboard = JSON.parse(read('dashboard.json')).dashboard;
    const optimizationDashboard = JSON.parse(read('../../optimization/dashboard.json')).dashboard;

    expect(worker).toContain('queryIndexedDatabaseSources(');
    expect(worker).toMatch(/executeDashboardQueries\(\s*context\.queries,\s*\{ \.\.\.databasePayload, \.\.\.healthPayload \},\s*directRequests/);
    expect(worker).toContain('const replacedSources = new Set(viewPayload.replacedSources)');
    expect(worker).toContain('deriveDataHealthCalloutSources(databasePayload)');
    expect(worker).not.toMatch(/deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources/);
    expect(worker).toContain("operation === 'subscribe-canonical-dashboard'");
    expect(worker).not.toContain('createDashboardQueryMemoization');
    expect(existsSync(resolve('src/data/queries/memoization.js'))).toBe(false);
    expect(databaseQueries.every((/** @type {{ stores?: unknown }} */ query) => Array.isArray(query.stores))).toBe(true);
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
    expect(workProject).not.toMatch(/normalizeState|actorForLifecycle|compareWorkItems|orchestratedCampaignNames/);
    expect(read('src/components/ui-elements.js')).not.toContain('filterRows');
    expect(presentationQueryFixture).toContain("operation: 'execute-dashboard-queries'");
    expect(presentationQueryFixture).not.toMatch(/executeDashboardQueries|compileDashboardViewPayloadQueries|deriveDashboardLinkSources/);
    expect(databaseAccess).not.toContain('tokenEfficiencySources');
    expect(databaseAccess).not.toContain('projectCanonicalViewSources');
    expect(databaseAccess).not.toContain('failedRunsSource');
    for (const projection of [
      'campaignsSource',
      'repositoriesSource',
      'workflowsSource',
      'runsSource',
      'recordsSource',
      'mcpCallsSource',
      'findingsSource',
      'detectionObservationsSource',
      'safeOutputPerformanceSource'
    ]) {
      expect(databaseAccess).not.toContain(`function ${projection}`);
    }
    expect(databaseQueries.map((/** @type {{ name?: string }} */ query) => query.name)).toEqual(expect.arrayContaining([
      'campaigns',
      'repositories',
      'workflows',
      'runs',
      'run-records',
      'mcp-calls',
      'findings',
      'detection-observations',
      'safe-output-performance'
    ]));
    for (const query of /** @type {Array<{
      name: keyof typeof SOURCE_FIELDS,
      select: Array<{ field: string, as?: string }>
    }>} */ (databaseQueries)) {
      const expectedFields = SOURCE_FIELDS[query.name];
      if (!expectedFields) continue;
      const selectedFields = new Set(query.select.map((field) => field.as ?? field.field));
      expect(expectedFields.filter((field) => !selectedFields.has(field)), query.name).toEqual([]);
    }
    expect(dashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'failed-runs'))
      .toMatchObject({ from: 'runs' });
    expect(dashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-opportunities'))
      .toBeUndefined();
    expect(dashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-interventions'))
      .toBeUndefined();
    expect(optimizationDashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-opportunities')?.from)
      .toBe('audits');
    expect(optimizationDashboard.queries.find((/** @type {{ name?: string }} */ query) => query.name === 'token-efficiency-interventions')?.from)
      .toBe('audits');
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

  it('keeps canonical database reads out of the UI JavaScript layer', () => {
    const diagnostics = read('src/diagnostics.js');
    const configurationView = read('src/components/configuration-view.js');
    const processor = read('src/data-processor.js');
    const worker = read('src/data-worker.js');

    expect(diagnostics).not.toMatch(/data\/storage\/indexeddb|indexedDB|readCollection/);
    expect(configurationView).not.toMatch(/data\/storage\/indexeddb|indexedDB|readCollection/);
    expect(processor).toContain("operation: 'query-canonical-database-diagnostics'");
    expect(worker).toContain("operation === 'query-canonical-database-diagnostics'");
    expect(worker).toContain('queryCanonicalDatabaseDiagnostics(indexedDB)');
  });
});