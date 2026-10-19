import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries, dashboardFormDefaultValues, resolveDashboardQueryParameters } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import { originalSessions, realSession, replay, runCacheLine } from '../model-resolution-fixture.js';

const dashboard = authoritativeDashboard.dashboard;
const now = Date.parse('2026-10-18T12:00:00Z');

/** @typedef {import('../model-resolution-fixture.js').FixtureSession} FixtureSession */

/** @param {IDBFactory} indexedDB @param {FixtureSession} source @param {{ attempt?: number, workflow?: string }} [overrides] */
async function ingest(indexedDB, source, overrides = {}) {
  await ingestCachedGhAwJsonl(indexedDB, runCacheLine(source, now, overrides), { now });
}

/** @param {IDBFactory} indexedDB @param {string[]} names @param {Record<string, string|number|boolean>} [parameters] @param {string} [pageId] */
async function query(indexedDB, names, parameters = {}, pageId = 'model-routing') {
  vi.stubGlobal('indexedDB', indexedDB);
  const required = new Set(resolveDashboardQuerySources(dashboard.queries, names));
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: {},
    queries: resolveDashboardQueryParameters(dashboard.queries.filter((/** @type {{ name: string }} */ definition) => required.has(definition.name)), {
      ...dashboardFormDefaultValues(dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === pageId).form), ...parameters
    }), sourceNames: names
  }));
}

/**
 * Resolves one declared view through the production view-payload compiler and data worker.
 * @param {IDBFactory} indexedDB @param {string} pageId @param {string} viewId
 * @param {Record<string, string>} [routeParameters] @param {Record<string, string|number|boolean>} [parameters]
 */
async function viewRows(indexedDB, pageId, viewId, routeParameters = {}, parameters = {}) {
  vi.stubGlobal('indexedDB', indexedDB);
  const page = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === pageId);
  const view = page.views.find((/** @type {{ id: string }} */ entry) => entry.id === viewId);
  const required = new Set(resolveDashboardQuerySources(dashboard.queries, [view.data.source]));
  const queries = resolveDashboardQueryParameters(dashboard.queries.filter((/** @type {{ name: string }} */ definition) => required.has(definition.name)), {
    ...dashboardFormDefaultValues(page.form), ...parameters
  });
  const payload = compileDashboardViewPayloadQueries(page, page.id, {
    queries, views: dashboard.views, viewId, sourceNames: [view.data.source], routeParameters
  });
  expect(payload.aliases.length).toBeGreaterThan(0);
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: {}, queries: [.../** @type {unknown[]} */ (queries), ...payload.queries], sourceNames: payload.aliases
  }));
  expect(result[payload.aliases[0]].metadata.availability).not.toBe('unavailable');
  return result[payload.aliases[0]].rows;
}

/** @param {IDBFactory} indexedDB */
async function ingestOriginals(indexedDB) {
  for (const source of originalSessions) await ingest(indexedDB, source);
}

const PI_ROLES = [
  { 'resolution-role-label': 'main', 'configured-model': 'copilot/gpt-5.3', 'resolved-model-label': 'gpt-5.3-codex', 'resolution-status': 'resolved' },
  { 'resolution-role-label': 'compact-whoami', 'configured-model': 'copilot/gpt-4o-mini', 'resolved-model-label': 'gpt-4o-mini', 'resolution-status': 'exact' },
  { 'resolution-role-label': 'haiku-whoami', 'configured-model': 'copilot/claude-haiku-4.5', 'resolved-model-label': 'claude-haiku-4.5', 'resolution-status': 'exact' },
  { 'resolution-role-label': 'mini-whoami', 'configured-model': 'copilot/gpt-5-mini', 'resolved-model-label': 'gpt-5-mini', 'resolution-status': 'exact' }
].map((row) => ({ ...row, 'resolution-engine': 'pi', 'resolution-provider': 'copilot', 'resolution-cause': null }));

describe('model resolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('projects four real pi resolution roles', async () => {
    const source = realSession('smoke-pi-sub-agents');
    const text = source.records.map((record) => JSON.stringify(record.envelope)).join('\n');
    const document = parseUnifiedSessionDocument(text, 'usage/aw_session.jsonl', { runId: String(source.run), attempt: 1 });
    const resolutions = document.events.filter((entry) => entry.type === 'model.resolution');
    expect(resolutions.map((entry) => entry.fields)).toEqual([
      ['main', 'copilot/gpt-5.3', 'gpt-5.3-codex', 'resolved'], ['compact-whoami', 'copilot/gpt-4o-mini', 'gpt-4o-mini', 'exact'],
      ['haiku-whoami', 'copilot/claude-haiku-4.5', 'claude-haiku-4.5', 'exact'], ['mini-whoami', 'copilot/gpt-5-mini', 'gpt-5-mini', 'exact']
    ].map(([role, configured, resolved, status]) => expect.objectContaining({
      sourceEngine: 'pi', resolutionRole: role, resolutionConfiguredModel: configured, resolutionResolvedModel: resolved,
      provider: 'copilot', status
    })));
    for (const entry of resolutions) expect(entry.fields).not.toHaveProperty('code');

    const indexedDB = new IDBFactory();
    await ingest(indexedDB, source);
    const result = await query(indexedDB, ['routing-resolutions', 'routing-problems']);
    expect(result['routing-resolutions'].rows).toHaveLength(4);
    expect(result['routing-resolutions'].rows).toMatchObject(PI_ROLES);
    expect(result['routing-resolutions'].rows.every((row) => row['event-timestamp'] === null || row['event-timestamp'] === undefined)).toBe(true);
    expect(result['routing-problems'].rows).toEqual([]);

    const drill = await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:39091103540' });
    expect(drill).toMatchObject(PI_ROLES.map((row) => ({ ...row, 'configured-to-resolved': `${row['configured-model']} → ${row['resolved-model-label']}` })));
  });

  it('shows the real small alias resolution on its run page', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, realSession('smoke-copilot-small'));
    const drill = await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:39091097441' });
    expect(drill).toMatchObject([{
      'resolution-engine': 'copilot', 'resolution-role-label': 'main', 'configured-model': 'small', 'resolved-model-label': 'claude-haiku-5.5',
      'resolution-status': 'resolved', 'configured-to-resolved': 'small → claude-haiku-5.5'
    }]);
  });

  it('preserves failed null resolution and distinct causes', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, replay('pi-main-model-unavailable'));
    await ingest(indexedDB, replay('pi-main-catalog-unavailable'));
    const problems = await viewRows(indexedDB, 'model-routing', 'routing-problems');
    expect(problems).toEqual(['catalog_unavailable', 'model_unavailable'].map((cause, index) => expect.objectContaining({
      run: String(990000004 - index), 'full-repository': 'github/gh-aw', workflow: '.github/workflows/smoke-pi-sub-agents.md',
      'problem-kind': 'resolution failure', 'problem-cause': cause,
      'routing-dashboard-link': expect.objectContaining({ 'dashboard-href': `#page-routing-run?routing-run=github%2Fgh-aw%3A${990000004 - index}` })
    })));
    expect(problems.map((row) => row['observed-at'] ?? null)).toEqual([null, null]);
    expect(await viewRows(indexedDB, 'model-routing', 'routing-problems', {}, { 'routing-filter-engine': 'codex' })).toEqual([]);
    const drill = await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:990000003' });
    expect(drill).toMatchObject([{
      'resolution-role-label': 'main', 'resolution-status': 'failed', 'resolution-cause': 'model_unavailable',
      'configured-model': 'copilot/gpt-5.3', 'resolved-model-label': 'unknown', 'configured-to-resolved': 'copilot/gpt-5.3 → unknown'
    }]);
    expect(drill[0]['resolution-resolved-model'] ?? null).toBeNull();
  });

  it('separates routed absence from missing evidence and accepts legacy sessions', async () => {
    const indexedDB = new IDBFactory();
    await ingestOriginals(indexedDB);
    const before = await query(indexedDB, ['routing-resolutions', 'routing-problems', 'routing-runs']);
    expect(before['routing-runs'].rows).toHaveLength(5);
    expect(before['routing-resolutions'].rows).toHaveLength(7);
    expect(new Set(before['routing-resolutions'].rows.map((row) => row.run)).size).toBe(4);
    expect(before['routing-problems'].rows).toEqual([]);
    expect(before['routing-runs'].rows.find((row) => row.run === '39091105929')).toMatchObject({ 'routing-state': 'selected' });
    expect(await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:39091105929' })).toEqual([]);

    await ingest(indexedDB, replay('legacy-without-resolution'));
    const after = await query(indexedDB, ['routing-resolutions', 'routing-problems', 'routing-runs']);
    expect(after['routing-resolutions'].rows).toHaveLength(7);
    expect(after['routing-problems'].rows).toEqual([]);
    expect(after['routing-runs'].rows.find((row) => row.run === '990000006')?.['routing-state']).not.toBe('selected');
    expect(after['routing-runs'].rows).toHaveLength(6);
    expect(after['routing-runs'].rows.filter((row) => row['routing-state'] === 'selected').map((row) => row.run)).toEqual(['39091105929']);
    expect(await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:990000006' })).toEqual([]);
  });

  it('honors scope, latest attempt, and unknown clocks', async () => {
    const indexedDB = new IDBFactory();
    await ingestOriginals(indexedDB);
    await ingest(indexedDB, replay('opus-before'));
    await ingest(indexedDB, replay('opus-after'));
    const pi = await query(indexedDB, ['routing-resolutions'], { 'routing-filter-engine': 'pi' });
    expect(pi['routing-resolutions'].rows).toHaveLength(4);
    expect(new Set(pi['routing-resolutions'].rows.map((row) => row['resolution-engine']))).toEqual(new Set(['pi']));
    const workflow = await query(indexedDB, ['routing-resolutions'], { 'routing-filter-workflow': '.github/workflows/smoke-copilot-small.md' });
    expect(workflow['routing-resolutions'].rows.map((row) => row.run)).toEqual(['39091097441']);

    const bounded = { 'routing-filter-start': '2026-10-18T03:30:00Z' };
    const timed = await query(indexedDB, ['routing-resolutions', 'routing-runs'], bounded);
    expect(timed['routing-runs'].rows.map((row) => row.run)).toEqual(['990000002']);
    expect(timed['routing-resolutions'].rows).toMatchObject([{ run: '990000002', 'configured-model': 'opus', 'resolved-model-label': 'claude-opus-5.5' }]);
    expect(await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:990000001' }, bounded)).toEqual([]);

    const untimed = await query(indexedDB, ['routing-resolutions']);
    expect(untimed['routing-resolutions'].rows.find((row) => row['configured-model'] === 'haiku')).toMatchObject({ untimed: true });

    const rerun = replay('opus-before');
    rerun.records = rerun.records.map((record) => record.envelope.type === 'model.resolution'
      ? { ...record, envelope: { ...record.envelope, data: { ...record.envelope.data, resolved_model: 'claude-opus-5.5' } } } : record);
    await ingest(indexedDB, rerun, { attempt: 2 });
    const latest = await query(indexedDB, ['routing-resolutions', 'routing-runs']);
    expect(latest['routing-resolutions'].rows.filter((row) => row.run === '990000001')).toMatchObject([{ 'resolved-model-label': 'claude-opus-5.5' }]);
    expect(latest['routing-runs'].rows).toHaveLength(7);
    expect(latest['routing-resolutions'].rows).toHaveLength(9);
  });

  it('rejects unsafe identifiers without retaining content', async () => {
    const indexedDB = new IDBFactory();
    const source = replay('unsafe-values');
    await ingest(indexedDB, source);
    const result = await query(indexedDB, ['routing-resolutions']);
    expect(result['routing-resolutions'].rows).toMatchObject([{
      'resolution-engine': 'claude', 'resolution-role-label': 'unknown', 'configured-model': 'unknown', 'resolved-model-label': 'unknown',
      'resolution-provider': 'unknown', 'resolution-status': 'resolved', 'resolution-cause': null
    }]);
    const serialized = JSON.stringify(result);
    for (const fragment of ['ignore previous', '<script>', 'provider!', 'example.invalid', 'token=1']) expect(serialized).not.toContain(fragment);
    const missing = replay('unsafe-values');
    missing.run = 990000007;
    missing.records = missing.records.map((record) => {
      if (record.envelope.type === 'workflow.info') return { ...record, envelope: { ...record.envelope, data: { ...record.envelope.data, run_id: 990000007 } } };
      if (record.envelope.type !== 'model.resolution') return record;
      return { ...record, envelope: { ...record.envelope, data: { status: 'pending' } } };
    });
    await ingest(indexedDB, missing);
    const drill = await viewRows(indexedDB, 'routing-run', 'routing-run-resolutions', { 'routing-run': 'github/gh-aw:990000007' });
    expect(drill).toMatchObject([{ 'resolution-engine': 'unknown', 'resolution-role-label': 'unknown', 'resolution-status': 'unknown',
      'configured-to-resolved': 'unknown → unknown', 'resolution-cause': null, 'resolution-provider': 'unknown' }]);
  });
});
