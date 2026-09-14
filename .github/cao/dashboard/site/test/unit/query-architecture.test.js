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
    const main = read('src/main.js');
    const presenter = read('src/presenter.js');
    const factoryOverview = read('src/components/factory-overview.js');
    const workProject = read('src/components/work-project-view.js');
    const presentationQueryFixture = read('test/workflow-inventory-query.js');

    expect(worker).toContain('executeDashboardQueries(context.queries, canonicalPayload, directRequests');
    expect(worker).toContain('const replacedSources = new Set(viewPayload.replacedSources)');
    expect(worker).not.toMatch(/deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources|deriveDataHealthCalloutSources/);
    expect(worker).toContain("operation === 'subscribe-canonical-dashboard'");
    expect(main).toContain('subscribeCanonicalDashboardView(');
    expect(main).toContain('signal: options.signal');
    expect(main).toContain('bindContinuations(pageId, sources, lazySources, options)');
    expect(main).toMatch(/loadCanonicalDashboardPage\(requested, dashboardContext, pagination, \{[\s\S]{0,220}pageId,[\s\S]{0,220}routeParameters: options\.routeParameters,[\s\S]{0,220}queryContext: options\.queryContext/);
    expect(main).not.toMatch(/const loadPageSources = async[\s\S]{0,600}loadCanonicalDashboardPage/);
    expect(presenter).not.toMatch(/filterDashboardSources|filterRowsForView|deriveOverviewSources|deriveRepositorySources|deriveRuntimeSources|deriveWorkflowSources/);
    expect(factoryOverview).not.toMatch(/connectedRepositoryCoverage|latestOutcomes|activityDays|exceedsThreshold|workerCount/);
    expect(workProject).not.toMatch(/normalizeState|actorForLifecycle|compareWorkItems|orchestratedPackageNames/);
    expect(read('src/components/ui-elements.js')).not.toContain('filterRows');
    expect(presentationQueryFixture).toContain("operation: 'execute-dashboard-queries'");
    expect(presentationQueryFixture).not.toMatch(/executeDashboardQueries|compileDashboardViewPayloadQueries|deriveDashboardLinkSources/);
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