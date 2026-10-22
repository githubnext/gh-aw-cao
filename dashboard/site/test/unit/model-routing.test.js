import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries, dashboardFormDefaultValues, resolveDashboardQueryParameters } from '../../src/data/queries/view-payload-compiler.js';
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

/** @param {IDBFactory} indexedDB @param {string[]} names @param {Record<string, string|number|boolean>} [parameters] */
async function query(indexedDB, names, parameters = {}) {
  vi.stubGlobal('indexedDB', indexedDB);
  const required = new Set(resolveDashboardQuerySources(dashboard.queries, names));
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: {},
    queries: resolveDashboardQueryParameters(dashboard.queries.filter((/** @type {{ name: string }} */ definition) => required.has(definition.name)), {
      ...dashboardFormDefaultValues(dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page).form), ...parameters
    }), sourceNames: names
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
  it.each(['firewall.upstream_error'])('preserves numeric status and HTTP evidence for %s', (type) => {
    const document = session(1, [event(type, { status: 429 })]);
    expect(document.events.find((entry) => entry.type === type)?.fields)
      .toMatchObject({ status: '429', httpStatus: 429 });
  });

  it('declares the five essential views and resolves payloads through the production worker', async () => {
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
    expect(page.views.map((/** @type {{ title: string }} */ view) => view.title)).toEqual([
      'Routing health by workflow', 'Models picked over time', 'Cost per run over time', 'Problems', 'Routing runs'
    ]);
    expect(page.views.filter((/** @type {{ disclosure?: string }} */ view) => view.disclosure)).toEqual([]);
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
    const result = await query(indexedDB, contract.queries, { 'minimum-sample': 1 });
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

  it('filters entire runs before event joins rather than truncating accounting at time bounds', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 1, [
      event('firewall.model_routing', { stage: 'selection', selectedModel: 'gpt-5', selectedEffort: 'high' }),
      { ...event('firewall.token_usage', { requestId: 'a', aic: 4 }),
        provenance: { phase: 'agent', timestampMs: now + 3600000 } }
    ]);
    await ingest(indexedDB, 2, [event('model.config', { routing: { enabled: false } })]);
    const result = await query(indexedDB, ['routing-runs', 'routing-attributed-accounting'], {
      'routing-filter-state': 'selected', 'routing-filter-repository': 'octo/api',
      'routing-filter-start': new Date(now).toISOString(), 'routing-filter-end': new Date(now + 1).toISOString()
    });
    expect(result['routing-runs'].rows).toHaveLength(1);
    expect(result['routing-attributed-accounting'].rows).toMatchObject([{ aic: 4 }]);
    expect(result['routing-runs'].rows[0]['routing-dashboard-link']).toMatchObject({
      'dashboard-href': '#page-routing-run?routing-run=octo%2Fapi%3A1'
    });
    const absent = await query(indexedDB, ['routing-runs'], { 'routing-filter-repository': 'octo/not-enrolled' });
    expect(absent['routing-runs'].rows).toHaveLength(0);
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

  it('uses every recorded source clock and leaves wholly untimed sessions outside bounded ranges', async () => {
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
    const bounded = await query(indexedDB, ['routing-runs'], {
      'routing-filter-start': new Date(now - 120000).toISOString(), 'routing-filter-end': new Date(now).toISOString()
    });
    expect(bounded['routing-runs'].rows).toHaveLength(1);
    expect(bounded['routing-runs'].rows[0].run).toBe('1');
  });

  it('gates weekly cost medians by the configured complete sample', async () => {
    const indexedDB = new IDBFactory();
    await ingest(indexedDB, 101, run101);
    const sparse = await query(indexedDB, ['routing-weekly-cost']);
    expect(sparse['routing-weekly-cost'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'routing-state': 'selected', runs: 1, 'complete-runs': 1, 'median-aic': null, 'sample-status': 'insufficient data'
    })]);
    const enough = await query(indexedDB, ['routing-weekly-cost'], { 'minimum-sample': 1 });
    expect(enough['routing-weekly-cost'].rows).toEqual([expect.objectContaining({
      week: '2026-10-12T00:00:00.000Z', 'routing-state': 'selected', runs: 1, 'complete-runs': 1, 'median-aic': 4, 'sample-status': 'observational'
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
