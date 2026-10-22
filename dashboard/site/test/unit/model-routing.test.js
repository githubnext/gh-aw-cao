import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { readCollection } from '../../src/data/storage/indexeddb.js';
import { resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/model-routing-contract.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
const now = Date.parse('2026-10-16T10:00:00Z');

/** @param {string} type @param {Record<string, unknown>} data @param {string} [phase] */
function event(type, data, phase = 'agent') {
  return { type, data, provenance: { phase, timestampMs: now, component: 'awf' } };
}

/** @param {number} run @param {Record<string, unknown>[]} events @param {number} [attempt] */
function session(run, events, attempt = 1) {
  return parseUnifiedSessionDocument([
    { type: 'session.format', data: { version: 1 } },
    event('workflow.info', { repository: 'octo/api', runId: run, engineId: 'copilot' }),
    ...events
  ].map((record) => JSON.stringify(record)).join('\n'), 'usage/aw_session.jsonl', { runId: String(run), attempt });
}

/** @param {IDBFactory} indexedDB @param {number} run @param {Record<string, unknown>[]} events @param {number} [attempt] */
async function ingest(indexedDB, run, events, attempt = 1) {
  await ingestCachedGhAwJsonl(indexedDB, JSON.stringify({
    schema_version: 5, kind: 'run',
    run: { run_id: run, run_attempt: attempt, organization: 'octo', repository: 'octo/api',
      workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      status: 'completed', conclusion: 'success',
      cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', ...session(run, events, attempt) }
    }
  }), { now });
}

/** @param {IDBFactory} indexedDB @param {typeof contract['observed-sessions'][number]} fixture
 * @param {Record<string, unknown>[]} [records] */
async function ingestObserved(indexedDB, fixture, records = fixture.records) {
  const document = parseUnifiedSessionDocument(records.map((record) => JSON.stringify(record)).join('\n'),
    'usage/aw_session.jsonl', { runId: fixture.run, attempt: 1 });
  await ingestCachedGhAwJsonl(indexedDB, JSON.stringify({
    schema_version: 5, kind: 'run',
    run: { run_id: Number(fixture.run), run_attempt: 1, organization: 'github', repository: 'github/gh-aw',
      workflow_name: 'Observed smoke workflow', workflow_path: '.github/workflows/smoke.lock.yml',
      created_at: '2026-10-21T01:00:00Z', updated_at: '2026-10-21T12:00:00Z',
      status: 'completed', conclusion: 'success',
      cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', ...document } }
  }), { now: Date.parse('2026-10-21T12:00:00Z') });
}

/** @param {IDBFactory} indexedDB @param {string[]} names */
async function query(indexedDB, names) {
  vi.stubGlobal('indexedDB', indexedDB);
  const required = new Set(resolveDashboardQuerySources(dashboard.queries, names));
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: {},
    queries: dashboard.queries.filter((/** @type {{ name: string }} */ definition) => required.has(definition.name)), sourceNames: names
  }));
}

/** Playwright run 101 replayed on the unit clock. */
const run101 = [
  event('model.config', { routing: { enabled: true } }),
  event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high',
    objective: { goal: 'cost', mode: 'auto' }, mode: 'balanced',
    labels: { task_type: 'coding', scope: 'repository', task_complexity: 'high' } }),
  event('firewall.model_routing', { stage: 'request', requestId: 'request-1', requestedModel: 'gpt-5',
    selectedModel: 'gpt-5', routed: 'as_selected', outcome: 'success' }),
  event('firewall.token_usage', { requestId: 'request-1', model: 'gpt-5', aic: 4 }),
  event('workflow.job_result', { jobId: 'agent', result: 'success' }),
  event('session.collection', { sources: [{ path: 'firewall/agent/token-usage.jsonl', phase: 'agent', component: 'firewall', events: 1 }] }, 'conclusion')
];

describe('model routing unified-session contract', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('compacts real SDK, routed and CLI sessions and pairs only matching main-request costs', async () => {
    const indexedDB = new IDBFactory();
    for (const fixture of contract['observed-sessions']) await ingestObserved(indexedDB, fixture);
    const result = await query(indexedDB, ['routing-runs', 'routing-health', 'routing-weekly-cost']);
    expect(result['routing-runs'].rows).toHaveLength(3);
    const sdk = result['routing-runs'].rows.find((row) => row.run === '39529495361');
    expect(sdk).toMatchObject({ 'routing-aggregate-version': 1, 'routing-state': 'selected',
      'pick-model': 'gpt-5.6-luna', 'baseline-model': 'claude-sonnet-5.5',
      'baseline-aic': contract['baseline-estimate-aic'], 'baseline-complete': true, paired: true });
    expect(sdk?.['main-aic']).toBeCloseTo(contract['baseline-main-aic'], 10);
    const health = result['routing-health'].rows.find((row) => row['baseline-model'] === 'claude-sonnet-5.5');
    expect(health?.['estimated-cost-vs-baseline']).toBeCloseTo(0.671398 / 6.02079, 10);
    const baseline = result['routing-weekly-cost'].rows.find((row) => String(row['cost-series']).startsWith('Baseline estimate'));
    expect(baseline).toMatchObject({ 'median-aic': null, 'complete-runs': 1 });
    const observed = result['routing-weekly-cost'].rows.find((row) => String(row['cost-series']).startsWith('Main requests observed'));
    expect(observed?.['median-aic']).toBeNull();
    expect(result['routing-runs'].rows.find((row) => row.run === '39529502581')).toMatchObject({
      'routing-state': 'unrouted', 'baseline-aic': null, paired: false
    });
    expect(result['routing-runs'].rows.find((row) => row.run === '39540473269')).toMatchObject({
      'routing-state': 'selected', 'baseline-aic': null, paired: false
    });
    const sparse = await query(indexedDB, ['routing-weekly-cost']);
    expect(sparse['routing-weekly-cost'].rows.every((row) => row['median-aic'] === null)).toBe(true);
  });

  it.each([
    { label: 'incomplete', complete: false, aic: 6.02079 },
    { label: 'zero denominator', complete: true, aic: 0 },
    { label: 'missing denominator', complete: true, aic: undefined }
  ])('keeps the $label estimate unknown instead of implying savings', async ({ complete, aic }) => {
    const indexedDB = new IDBFactory();
    const fixture = contract['observed-sessions'][0];
    // Deliberately modified test variants of the observed SDK record.
    const records = fixture.records.map((record) => record.type === 'model.baseline_estimate'
      ? { ...record, data: { ...record.data, complete, aic, unpricedRequests: complete ? 0 : 1 } } : record);
    await ingestObserved(indexedDB, fixture, records);
    const result = await query(indexedDB, ['routing-health', 'routing-weekly-cost']);
    expect(result['routing-health'].rows[0]['estimated-cost-vs-baseline']).toBeNull();
    expect(result['routing-weekly-cost'].rows.some((row) => String(row['cost-series']).startsWith('Baseline estimate'))).toBe(false);
  });

  it.each(['mismatched count', 'missing observed cost', 'missing baseline model'])(
    'does not pair a complete estimate with $0', async (variant) => {
      const indexedDB = new IDBFactory();
      const fixture = contract['observed-sessions'][0];
      const records = fixture.records.map((record) => {
        if (record.type === 'model.baseline_estimate') return { ...record, data: {
          ...record.data,
          ...(variant === 'mismatched count' ? { mainRequests: 5 } : {}),
          ...(variant === 'missing baseline model' ? { baselineModel: undefined } : {})
        } };
        if (variant === 'missing observed cost' && record.type === 'firewall.token_usage') {
          return { ...record, data: { ...record.data, aic: undefined } };
        }
        return record;
      });
      await ingestObserved(indexedDB, fixture, records);
      const result = await query(indexedDB, ['routing-health']);
      expect(result['routing-health'].rows[0]['estimated-cost-vs-baseline']).toBeNull();
    });

  it('shows identifier-only upstream errors once and diagnoses only known candidate coverage gaps', async () => {
    const indexedDB = new IDBFactory();
    // T-UAS-082 req-1 projection; no native provider body is retained.
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', eligibleChoices: 6, catalogueOverlap: 5 }),
      event('firewall.upstream_error', { requestId: 'req-1', provider: 'copilot', model: 'claude-haiku-4.5',
        status: 400, errorCode: 'invalid_reasoning_effort', message: 'PRIVATE BODY', headers: { secret: 'PRIVATE HEADER' } })
    ]);
    await ingest(indexedDB, 2, [event('firewall.model_routing', {
      stage: 'selection', selectedModel: 'gpt-5', eligibleChoices: 6, catalogueOverlap: 6
    })]);
    await ingest(indexedDB, 3, [event('firewall.model_routing', {
      stage: 'selection', selectedModel: 'gpt-5', eligibleChoices: 6
    })]);
    const result = await query(indexedDB, ['routing-problems', 'routing-events']);
    expect(result['routing-problems'].rows.map((row) => [row.run, row['problem-kind'], row['problem-cause']])).toEqual([
      ['1', 'candidates not rankable', '5/6'], ['1', 'upstream error', 'invalid_reasoning_effort']
    ]);
    expect(result['routing-events'].rows.find((row) => row['event-type'] === 'firewall.upstream_error')).toMatchObject({
      'correlation-id': 'req-1', provider: 'copilot', 'telemetry-model': 'claude-haiku-4.5', 'http-status': 400,
      code: 'invalid_reasoning_effort'
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('combines distinct upstream codes once per run and leaves missing codes unknown', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.upstream_error', { errorCode: 'invalid_reasoning_effort' }),
      event('firewall.upstream_error', { errorCode: 'invalid_reasoning_effort' }),
      event('firewall.upstream_error', { errorCode: 'model_not_supported' }),
      event('firewall.event', { event: 'UPSTREAM_ERROR_RESPONSE' })
    ]);
    await ingest(indexedDB, 2, [event('firewall.upstream_error', { status: 503 })]);
    const result = await query(indexedDB, ['routing-problems']);
    expect(result['routing-problems'].rows).toHaveLength(2);
    expect(result['routing-problems'].rows.every((row) => row['problem-kind'] === 'upstream error')).toBe(true);
    expect(result['routing-problems'].rows.find((row) => row.run === '1')?.['problem-cause'])
      .toBe('invalid_reasoning_effort, model_not_supported');
    expect(result['routing-problems'].rows.find((row) => row.run === '2')?.['problem-cause']).toBe('unknown');
  });

  it('keeps overview reads run-sized for a 100-request test variant and drops unused event rows', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      ...run101,
      event('model.inventory', { endpoints: [{ provider: 'copilot', models: ['unused'] }] }),
      event('firewall.event', { event: 'unused' }),
      ...Array.from({ length: 100 }, (_, index) => event('firewall.token_usage', { requestId: `r-${index}`, aic: 1 }))
    ]);
    const reads = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    const result = await query(indexedDB, ['routing-health', 'routing-weekly-models', 'routing-weekly-cost', 'routing-problems', 'routing-runs']);
    expect(result['routing-runs'].rows).toHaveLength(1);
    expect(reads.mock.instances.some((store) => store instanceof IDBObjectStore && store.name === 'audits')).toBe(false);
    reads.mockRestore();
    const events = await query(indexedDB, ['routing-events']);
    expect(events['routing-events'].rows.some((row) => ['model.inventory', 'firewall.event'].includes(String(row['event-type'])))).toBe(false);
    const runs = await readCollection(indexedDB, 'runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ routingAggregateVersion: 1, routingState: 'selected' });
    const audits = await readCollection(indexedDB, 'audits');
    expect(audits.some((record) => ['routingBaselineModel', 'routingBaselineComplete', 'routingBaselineMainRequests',
      'eligibleChoices', 'catalogueOverlap'].some((field) => Object.hasOwn(record, field)))).toBe(false);
  });

  it.each(['firewall.upstream_error'])('preserves numeric status and HTTP evidence for %s', (type) => {
    const document = session(1, [event(type, { status: 429 })]);
    expect(document.events.find((entry) => entry.type === type)?.fields)
      .toMatchObject({ status: '429', httpStatus: 429 });
  });

  it('loads action-first views without forms or parameters through the production worker', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'github-copilot/gpt-5',
        selectedEffort: 'high', objective: { goal: 'cost', mode: 'auto' }, mode: 'balanced',
        labels: { task_type: 'coding', scope: 'repository', task_complexity: 'high' } }),
      event('firewall.model_routing', { stage: 'failure', code: 'ai_credits_limit_exceeded' }),
      event('workflow.info', { modelRouting: { status: 'rejected', wireModel: 'WRONG', effort: 'low' } }),
      event('workflow.job_result', { jobId: 'agent', result: 'success' })
    ]);
    const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page);
    expect(page.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual(contract.views);
    expect(page.views.map((/** @type {{ title?: string, 'disclosure-label'?: string }} */ view) => view.title ?? view['disclosure-label'])).toEqual([
      'Fix routing problems', 'Review workflow routing', 'Review model choices', 'Compare routing costs', 'Inspect recent runs'
    ]);
    expect(page.form).toBeUndefined();
    expect(page.views.filter((/** @type {{ disclosure?: string }} */ view) => !view.disclosure)
      .map((/** @type {{ id: string }} */ view) => view.id)).toEqual(contract['essential-views']);
    const routingQueries = new Set(resolveDashboardQuerySources(dashboard.queries, contract.queries));
    expect(dashboard.queries.filter((/** @type {{ name: string }} */ definition) => routingQueries.has(definition.name))
      .every((/** @type {{ parameters?: unknown }} */ definition) => !definition.parameters)).toBe(true);
    for (const view of page.views) {
      const payload = compileDashboardViewPayloadQueries(page, page.id, {
        queries: dashboard.queries, views: dashboard.views, viewId: view.id, sourceNames: [view.data.source]
      });
      if (payload.aliases.length === 0) {
        const result = await query(indexedDB, [view.data.source]);
        expect(result[view.data.source].metadata.availability).not.toBe('unavailable');
        continue;
      }
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'load-dashboard-query-sources', sources: {},
        queries: [...dashboard.queries, ...payload.queries], sourceNames: payload.aliases
      }));
      expect(result[payload.aliases[0]].metadata.availability).not.toBe('unavailable');
    }
    const detail = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.detail);
    expect(detail.form).toBeUndefined();
    expect(detail.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual(contract['detail-views']);
    for (const view of detail.views) {
      const payload = compileDashboardViewPayloadQueries(detail, detail.id, {
        queries: dashboard.queries, views: dashboard.views, viewId: view.id, sourceNames: [view.data.source],
        routeParameters: { 'routing-run': 'octo/api:1' }
      });
      expect(payload.aliases.length).toBeGreaterThan(0);
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'load-dashboard-query-sources', sources: {},
        queries: [...dashboard.queries, ...payload.queries], sourceNames: payload.aliases
      }));
      expect(result[payload.aliases[0]].metadata.availability).not.toBe('unavailable');
    }
    const result = await query(indexedDB, contract.queries);
    expect(result['routing-resolutions'].rows).toEqual([]);
    expect(result['routing-runs'].rows).toMatchObject([{
      'routing-state': 'selected', 'pick-model': 'gpt-5', 'pick-effort': 'high', 'failure-count': 1,
      'routing-task-type': 'coding', 'routing-scope': 'repository', 'routing-complexity': 'high'
    }]);
    expect(result['routing-health'].rows).toEqual([expect.objectContaining({
      'full-repository': 'octo/api', workflow: '.github/workflows/worker.md', 'routed-runs': 1,
      'selected-percent': '100%', 'failure-percent': '100%', 'success-percent': '100%', 'median-aic': null
    })]);
    expect(result['routing-problems'].rows).toEqual([expect.objectContaining({
      run: '1', 'full-repository': 'octo/api', workflow: '.github/workflows/worker.md',
      'problem-kind': 'routing failure', 'problem-cause': 'ai_credits_limit_exceeded', 'observed-at': '2026-10-16T10:00:00.000Z',
      'next-action': contract['problem-actions']['routing failure'],
      'routing-dashboard-link': expect.objectContaining({ 'dashboard-href': '#page-routing-run?routing-run=octo%2Fapi%3A1' })
    })]);
  });

  it('keeps each routing state distinct, including explicit and inferred unrouted runs', async () => {
    const indexedDB = new IDBFactory();
    const inputs = [
      [event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5' })],
      [event('firewall.model_routing', { stage: 'failure', code: 'provider_unavailable' })],
      [event('workflow.info', { modelRouting: { status: 'selected', model: 'gpt-5' } })],
      [event('model.config', { routing: { enabled: false } })],
      [event('model.config', { routing: { enabled: true } })],
      [event('firewall.token_usage', { aic: 1 })],
      []
    ];
    for (const [index, events] of inputs.entries()) await ingest(indexedDB, index + 1, events);
    const result = await query(indexedDB, ['routing-runs']);
    expect(result['routing-runs'].rows.map((row) => row['routing-state']).sort()).toEqual([...contract.states].sort());
    const summary = await query(indexedDB, ['routing-health', 'routing-weekly-models']);
    expect(summary['routing-health'].rows).toEqual([expect.objectContaining({
      'full-repository': 'octo/api', workflow: '.github/workflows/worker.md', 'routed-runs': 4,
      'selected-share': 0.25, 'selected-percent': '25%', 'failure-share': 0.25, 'failure-percent': '25%',
      'followed-share': null, 'followed-percent': null, 'success-rate': null, 'success-percent': null, 'median-aic': null
    })]);
    expect(summary['routing-weekly-models'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'pick-model': 'gpt-5', runs: 1
    })]);
  });

  it('keeps deviation denominators and all five token-class coverage counters explicit', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'request', requestId: 'a', routed: 'deviated' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'b', routed: 'as_selected' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'c', routed: 'deviated' }),
      event('firewall.token_usage', { requestId: 'a', aic: 2, purpose: 'agent', usage: {
        inputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 1
      } }),
      event('firewall.token_usage', { requestId: 'b', aic: 6, purpose: 'agent' })
    ]);
    const result = await query(indexedDB, ['routing-deviations', 'routing-attributed-accounting']);
    expect(result['routing-deviations'].rows.map((row) => row['routing-routed'])).toEqual(['deviated', 'as_selected', 'deviated']);
    const tokenClasses = ['input-tokens', 'output-tokens', 'reasoning-tokens', 'cache-read-tokens', 'cache-write-tokens'];
    expect(result['routing-attributed-accounting'].rows.map((row) => [row['correlation-id'], row.aic, ...tokenClasses.map((field) => row[field] ?? null)]))
      .toEqual([['a', 2, 10, 4, 2, 3, 1], ['b', 6, null, null, null, null, null]]);
  });

  it('reports pick adherence and deviation problems for a selected run', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'a', routed: 'deviated' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'b', routed: 'as_selected' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'c', routed: 'deviated' })
    ]);
    const result = await query(indexedDB, ['routing-health', 'routing-problems']);
    expect(result['routing-health'].rows).toEqual([expect.objectContaining({
      'routed-runs': 1, 'adherence-known-runs': 1, 'followed-runs': 0, 'followed-share': 0, 'followed-percent': '0%'
    })]);
    expect(result['routing-problems'].rows).toEqual([expect.objectContaining({
      run: '1', 'problem-kind': 'deviation', 'problem-cause': 'deviated'
    })]);
  });

  it('provides a concrete next action and run link for every recorded problem kind', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', eligibleChoices: 6, catalogueOverlap: 5 }),
      event('firewall.model_routing', { stage: 'failure', code: 'unsupported_reasoning_effort' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'a', routed: 'deviated' }),
      event('firewall.upstream_error', { requestId: 'a', errorCode: 'invalid_reasoning_effort' }),
      event('model.resolution', { engine: 'copilot', role: 'main', configured_model: 'small',
        status: 'failed', cause: 'model_unavailable' })
    ]);
    const result = await query(indexedDB, ['routing-problems']);
    expect(result['routing-problems'].rows).toHaveLength(contract['problem-kinds'].length);
    for (const [kind, action] of Object.entries(contract['problem-actions'])) {
      expect(result['routing-problems'].rows.find((row) => row['problem-kind'] === kind)).toMatchObject({
        'next-action': action,
        'routing-dashboard-link': { 'dashboard-href': '#page-routing-run?routing-run=octo%2Fapi%3A1' }
      });
    }
  });

  it.each([
    { events: [event('firewall.model_routing', { stage: 'failure', code: 'provider_unavailable' })],
      action: 'Investigate failures or fallbacks' },
    { events: [event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'a', routed: 'deviated' })],
      action: 'Inspect requests that did not follow the pick' },
    { events: [event('model.config', { routing: { enabled: true } })],
      action: 'Collect missing proxy selection evidence' },
    { events: run101, action: 'Collect at least 10 paired baseline runs' }
  ])('prioritizes "$action" without user input', async ({ events, action }) => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, events);
    const result = await query(indexedDB, ['routing-health']);
    expect(result['routing-health'].rows).toMatchObject([{ 'next-action': action }]);
  });

  it.each([
    { baseline: 8, action: 'Monitor costs and validate outcome quality' },
    { baseline: 2, action: 'Review routing goal or mode' }
  ])('requires ten paired runs before recommending "$action"', async ({ baseline, action }) => {
    const indexedDB = new IDBFactory();
    const events = [...run101, event('model.baseline_estimate', {
      estimated: true, baselineModel: 'baseline-model', aic: baseline, mainRequests: 1,
      pricedRequests: 1, unpricedRequests: 0, unattributedRequests: 0, complete: true
    })];
    for (let run = 1; run <= 9; run++) await ingest(indexedDB, run, events);
    const sparse = await query(indexedDB, ['routing-health', 'routing-weekly-cost']);
    expect(sparse['routing-health'].rows).toMatchObject([{
      'paired-runs': 9, 'next-action': 'Collect at least 10 paired baseline runs'
    }]);
    expect(sparse['routing-weekly-cost'].rows.every((row) => row['median-aic'] === null)).toBe(true);
    await ingest(indexedDB, 10, events);
    const enough = await query(indexedDB, ['routing-health', 'routing-weekly-cost']);
    expect(enough['routing-health'].rows).toMatchObject([{ 'paired-runs': 10, 'next-action': action }]);
    expect(enough['routing-weekly-cost'].rows.filter((row) => String(row['cost-series']).startsWith('Baseline estimate')))
      .toMatchObject([{ 'complete-runs': 10, 'median-aic': baseline }]);
    expect(enough['routing-weekly-cost'].rows.filter((row) => String(row['cost-series']).startsWith('Main requests observed')))
      .toMatchObject([{ 'complete-runs': 10, 'median-aic': 4 }]);
  });

  it('counts only the four specified agent-job outcomes as known results', async () => {
    const indexedDB = new IDBFactory();
    for (const [index, result] of ['success', 'failure', 'cancelled', 'skipped', 'timed_out'].entries()) {
      await ingest(indexedDB, index + 1, [
        event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high' }),
        event('workflow.job_result', { jobId: 'agent', result })
      ]);
    }
    const result = await query(indexedDB, ['routing-health', 'routing-weekly-models']);
    expect(result['routing-health'].rows).toEqual([expect.objectContaining({
      'routed-runs': 5, successes: 1, 'known-outcomes': 4, 'success-rate': 0.25, 'success-percent': '25%',
      'selected-percent': '100%', 'failure-percent': '0%', 'followed-percent': null
    })]);
    expect(result['routing-weekly-models'].rows).toEqual([expect.objectContaining({ 'pick-model': 'gpt-5', runs: 5 })]);
  });

  it('chooses proxy accounting per phase and never makes missing purpose agent traffic', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.token_usage', { requestId: 'classifier', purpose: 'routing_classification', aic: 1 }),
      event('usage.report', { requestId: 'classifier', purpose: 'routing_classification', aic: 900 }),
      event('firewall.token_usage', { requestId: 'unknown', model: 'gpt-5' }),
      event('firewall.token_usage', { requestId: 'sub', agentName: 'reviewer', aic: 3 }),
      event('firewall.model_routing', { stage: 'request', requestId: 'main', routed: 'as_selected' }),
      event('firewall.token_usage', { requestId: 'main', aic: 4 }),
      event('usage.report', { requestId: 'detection', aic: 2 }, 'detection'),
      event('usage.report', { requestId: 'evals', aic: 5 }, 'evals'),
      event('session.result', { totalAic: 5000, agentMetrics: { reviewer: { totalNanoAiu: 1000000000 } } })
    ]);
    const result = await query(indexedDB, ['routing-attributed-accounting']);
    const rows = result['routing-attributed-accounting'].rows;
    expect(rows.map((row) => row.bucket).sort()).toEqual(['classifier', 'unattributed', 'subagent_exact', 'main_agent', 'detection', 'evals'].sort());
    expect(rows.filter((row) => row.bucket === 'classifier')).toMatchObject([{ aic: 1, 'unknown-aic-count': 0 }]);
    expect(rows.filter((row) => row.bucket === 'unattributed')).toMatchObject([{ 'unknown-aic': true, 'unknown-aic-count': 1 }]);
  });

  it('normalizes legacy fields and strips content before persistence', () => {
    const projected = session(1, [
      event('firewall.model_routing', { stage: 'selection', selected_model: 'provider/model-x',
        selected_effort: 'high', classifier_model: 'provider/classifier',
        labels: { task_type: '[redacted]', task_complexity: 'private label text' },
        message: 'PRIVATE', detail: 'PRIVATE', reason: 'PRIVATE', conversation_sha256: 'PRIVATE',
        degradedReason: 'PRIVATE FREE TEXT', response_body: 'PRIVATE' }),
      event('firewall.token_usage', { request_id: 'r1', ai_credits_this_response: 0,
        usage: { input_tokens: 10, cache_read_input_tokens: 2 } })
    ]);
    expect(JSON.stringify(projected.events)).not.toContain('PRIVATE');
    expect(projected.events.find((event) => event.type === 'firewall.model_routing')?.fields).toMatchObject({
      routingSelectedModel: 'model-x', routingSelectedEffort: 'high', routingTaskType: 'redacted'
    });
    expect(projected.events.find((event) => event.type === 'firewall.token_usage')?.fields).toMatchObject({
      aic: 0, inputTokens: 10, cacheReadTokens: 2, correlationId: 'r1'
    });
  });

  it('correlates repeated complete token quartets one-to-one after exact ownership', async () => {
    const indexedDB = new IDBFactory();
    const usage = { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    await ingest(indexedDB, 1, [
      event('subagent.request', { requestId: 'exact', agentName: 'exact-owner', model: 'p/model-x', usage }),
      event('subagent.request', { requestId: 'engine-a', agentName: 'first-owner', model: 'model-x', usage }),
      event('subagent.request', { requestId: 'engine-b', agentName: 'second-owner', model: 'model-x', usage }),
      event('firewall.token_usage', { requestId: 'exact', model: 'model-x', usage, aic: 1 }),
      event('firewall.token_usage', { requestId: 'proxy-a', model: 'model-x', usage, aic: 2 }),
      event('firewall.token_usage', { requestId: 'proxy-b', model: 'model-x', usage, aic: 3 }),
      event('firewall.token_usage', { requestId: 'no-quartet', model: 'model-x', aic: 4 })
    ]);
    const result = await query(indexedDB, ['routing-attributed-accounting']);
    expect(result['routing-attributed-accounting'].rows).toMatchObject([
      { 'correlation-id': 'exact', bucket: 'subagent_exact', 'agent-name': 'exact-owner' },
      { 'correlation-id': 'proxy-a', bucket: 'subagent_correlated', 'agent-name': 'first-owner' },
      { 'correlation-id': 'proxy-b', bucket: 'subagent_correlated', 'agent-name': 'second-owner' },
      { 'correlation-id': 'no-quartet', bucket: 'unattributed' }
    ]);
  });

  it('requires source receipts and excludes missing costs and ambiguous local failures', async () => {
    const indexedDB = new IDBFactory();
    const receipt = event('session.collection', {
      sources: [{ path: 'firewall/agent/token-usage.jsonl', phase: 'agent', component: 'firewall', events: 1 }]
    }, 'conclusion');
    await ingest(indexedDB, 1, [receipt, event('firewall.token_usage', { requestId: 'a', aic: 4 })]);
    await ingest(indexedDB, 2, [receipt, event('firewall.token_usage', { requestId: 'a' })]);
    await ingest(indexedDB, 3, [receipt,
      event('firewall.model_routing', { stage: 'request', requestId: 'a', outcome: 'rejected' })]);
    const localFailure = event('firewall.model_routing', { stage: 'failure', code: 'unsupported_reasoning_effort' });
    const failed = event('firewall.model_routing', { stage: 'request', requestId: 'a', outcome: 'failed' });
    await ingest(indexedDB, 4, [receipt, localFailure, failed,
      event('firewall.model_routing', { stage: 'request', requestId: 'b', outcome: 'failed' })]);
    await ingest(indexedDB, 5, [receipt, localFailure, failed]);
    await ingest(indexedDB, 6, [event('firewall.token_usage', { requestId: 'a', aic: 4 })]);
    const result = await query(indexedDB, ['routing-cost-runs', 'routing-phase-costs']);
    const costs = result['routing-cost-runs'].rows;
    expect(costs.map((row) => [row['cost-complete'], row['complete-aic']])).toEqual([
      [true, 4], [false, null], [true, 0], [false, null], [true, 0], [false, null]
    ]);
    expect(result['routing-phase-costs'].rows.find((row) => row['routing-run-key'] === costs[0]['routing-run-key'] && row.phase === 'agent'))
      .toMatchObject({ phase: 'agent', complete: true, 'source-present': true });
  });

  it('uses normalized time before file order and preserves unsupported and legacy coverage', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      { ...event('firewall.model_routing', { stage: 'selection', selectedModel: 'new', selectedEffort: 'high',
        schema: 'model-routing/v0.28.38' }), provenance: { phase: 'agent', timestampMs: now + 1 } },
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'old', selectedEffort: 'low',
        schema: 'model-routing/v0.28.51' }),
      event('firewall.model_routing', { stage: 'request', requestId: 'r', routed: 'deviated', deviations: ['endpoint'] })
    ]);
    const result = await query(indexedDB, ['routing-runs', 'routing-deviations']);
    expect(result['routing-runs'].rows).toMatchObject([{ 'pick-model': 'new' }]);
    expect(result['routing-deviations'].rows).toMatchObject([{ 'routing-routed': 'as_selected' }]);
    const legacy = parseUnifiedSessionDocument(JSON.stringify(event('workflow.info', { repository: 'octo/api', runId: 1 })), 'usage/aw_session.jsonl', { runId: '1', attempt: 1 });
    expect(legacy.events.some((row) => row.type === 'session.format' && row.fields.status === 'legacy')).toBe(true);
    const unsupported = parseUnifiedSessionDocument([
      { type: 'session.format', data: { version: 2 } },
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'must-not-read' })
    ].map((row) => JSON.stringify(row)).join('\n'), 'usage/aw_session.jsonl', { runId: '1', attempt: 1 });
    expect(unsupported.events).toHaveLength(1);
    expect(unsupported.events[0].fields).toMatchObject({ status: 'unsupported' });
    expect(parseUnifiedSessionDocument('{"type":"session.format","data":{"version":2}}\nnot-v1-json',
      'usage/aw_session.jsonl', { runId: '1', attempt: 1 }).events).toHaveLength(1);
  });

  it('includes all routing states and late accounting without filter input', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high' }),
      { ...event('firewall.token_usage', { requestId: 'a', aic: 4 }),
        provenance: { phase: 'agent', timestampMs: now + 3600000 } }
    ]);
    await ingest(indexedDB, 2, [event('model.config', { routing: { enabled: false } })]);
    const result = await query(indexedDB, ['routing-runs', 'routing-attributed-accounting']);
    expect(result['routing-runs'].rows).toHaveLength(2);
    expect(result['routing-attributed-accounting'].rows).toMatchObject([{ aic: 4 }]);
    expect(result['routing-runs'].rows[0]['routing-dashboard-link']).toMatchObject({
      'dashboard-href': '#page-routing-run?routing-run=octo%2Fapi%3A1'
    });
  });

  it('replaces ingested attempts without mixing their picks or accounting', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'old', selectedEffort: 'high' }),
      event('firewall.token_usage', { requestId: 'old-request', aic: 20 })
    ]);
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'new', selectedEffort: 'high' }),
      event('firewall.token_usage', { requestId: 'new-request', aic: 2 })
    ], 2);
    const result = await query(indexedDB, ['routing-runs', 'routing-attributed-accounting']);
    expect(result['routing-runs'].rows).toMatchObject([{ 'pick-model': 'new', 'selection-count': 1 }]);
    expect(result['routing-attributed-accounting'].rows).toMatchObject([{ aic: 2 }]);
    expect(result['routing-attributed-accounting'].rows).toHaveLength(1);
  });

  it('uses recorded source clocks and includes wholly untimed sessions without invented dates', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      { type: 'user.message', data: { content: 'NEVER_RETAIN_MESSAGE' },
        provenance: { timestampMs: now - 60000 } },
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5' })
    ]);
    const untimed = parseUnifiedSessionDocument([
      { type: 'session.format', data: { version: 1 } },
      { type: 'workflow.info', data: { repository: 'octo/api', runId: 2, engineId: 'copilot' } }
    ].map((record) => JSON.stringify(record)).join('\n'), 'usage/aw_session.jsonl', { runId: '2', attempt: 1 });
    await ingestCachedGhAwJsonl(indexedDB, JSON.stringify({ schema_version: 5, kind: 'run',
      run: { run_id: 2, run_attempt: 1, repository: 'octo/api', organization: 'octo',
        workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
        created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
        status: 'completed', conclusion: 'success',
        cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', ...untimed } } }), { now });
    const all = await query(indexedDB, ['routing-runs']);
    expect(all['routing-runs'].rows).toMatchObject([
      { run: '1', 'run-clock': now - 60000 }, { run: '2', 'run-clock': null }
    ]);
    expect(JSON.stringify(all)).not.toContain('NEVER_RETAIN_MESSAGE');
    const models = await query(indexedDB, ['routing-weekly-models']);
    expect(models['routing-weekly-models'].rows).toMatchObject([{ runs: 1 }]);
  });

  it('gates weekly cost medians at exactly ten complete runs without a slider', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 101, run101);
    const sparse = await query(indexedDB, ['routing-weekly-cost']);
    expect(sparse['routing-weekly-cost'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'routing-state': 'selected', runs: 1, 'complete-runs': 1, 'median-aic': null, 'sample-status': 'insufficient data'
    })]);
    for (let run = 102; run <= 109; run++) await ingest(indexedDB, run, run101);
    const nine = await query(indexedDB, ['routing-weekly-cost']);
    expect(nine['routing-weekly-cost'].rows).toMatchObject([{ 'complete-runs': 9, 'median-aic': null }]);
    await ingest(indexedDB, 110, run101);
    const enough = await query(indexedDB, ['routing-weekly-cost']);
    expect(enough['routing-weekly-cost'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'routing-state': 'selected', runs: 10, 'complete-runs': 10, 'median-aic': 4, 'sample-status': 'observational'
    })]);
  });

  it('reports run 101 as healthy with no problems', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 101, run101);
    const result = await query(indexedDB, ['routing-health', 'routing-weekly-models', 'routing-problems']);
    expect(result['routing-health'].rows).toEqual([expect.objectContaining({
      'routed-runs': 1, 'selected-percent': '100%', 'failure-percent': '0%', 'followed-percent': '100%',
      'success-percent': '100%', 'median-aic': 4
    })]);
    expect(result['routing-weekly-models'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'pick-model': 'gpt-5', runs: 1
    })]);
    expect(result['routing-problems'].rows).toEqual([]);
  });
});
