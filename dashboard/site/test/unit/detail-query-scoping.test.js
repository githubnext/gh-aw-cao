import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  dashboardQueryDefects,
  dashboardQueryOutputFields
} from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/detail-query-contracts.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'detail-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-10-02T00:00:00Z',
  'retrieved-at': '2026-10-02T00:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

/** @param {string} pageId @param {string} viewId @param {Record<string, string>} routeParameters */
function compileDetail(pageId, viewId, routeParameters) {
  return compileDashboardViewPayloadQueries(
    dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === pageId),
    pageId,
    { viewId, routeParameters, queries: dashboard.queries, views: dashboard.views }
  );
}

/** @param {unknown[]} queries @param {string[]} requested @param {Record<string, Record<string, unknown>[]>} rows */
function execute(queries, requested, rows) {
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries,
    sourceNames: requested,
    sources: Object.fromEntries(Object.entries(rows).map(([source, rows]) => [source, { source, rows, metadata }]))
  }));
}

describe('selected entity query compiler contracts', () => {
  it('preserves declared detail schemas, identities, arguments and table pagination', () => {
    const definitions = new Map(dashboard.queries.map((/** @type {{ name: string }} */ query) => [query.name, query]));
    /** @param {string} name @returns {string[] | undefined} */
    const fields = (name) => definitions.has(name)
      ? dashboardQueryOutputFields(definitions.get(name), fields)
      : /** @type {Record<string, string[]>} */ (TABLE_FIELDS)[name];
    for (const [source, expected] of Object.entries(contract.sources)) {
      expect(fields(source)).toEqual(expected);
    }
    for (const entry of contract.views) {
      const page = dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === entry.page);
      const reusable = new Map(dashboard.views.map((/** @type {{ id: string }} */ view) => [view.id, view]));
      const view = page.views.map((/** @type {any} */ candidate) => (
        typeof candidate === 'string' ? reusable.get(candidate) : candidate
      )).find((/** @type {{ id: string }} */ candidate) => candidate.id === entry.id);
      expect(view.data.source).toBe(entry.source);
      expect(view.data.arguments.map((/** @type {{ field: string }} */ argument) => argument.field)).toEqual(entry.arguments);
      if ('identity' in entry) expect(fields(entry.source)).toContain(entry.identity);
      if ('lazy-list' in entry) expect(view['lazy-list']).toBe(true);
      const payload = compileDetail(entry.page, entry.id, entry.page === 'run-events'
        ? contract.run : { tool: contract.tools[0] });
      expect(dashboardQueryDefects(payload.queries).size).toBe(0);
      const compiled = new Map(payload.queries.map((query) => [query.name, query]));
      /** @param {string} name @returns {string[] | undefined} */
      const compiledFields = (name) => compiled.has(name)
        ? dashboardQueryOutputFields(/** @type {any} */ (compiled.get(name)), compiledFields)
        : fields(name);
      expect(compiledFields(payload.aliases[0])).toEqual(fields(entry.source));
    }
  });

  it('pushes every run identity field into all four union branches without dropping event grain', () => {
    const payload = compileDetail('run-events', 'run-events', contract.run);
    const branches = payload.queries.filter((query) => ['audits', 'domains', 'tool-observations', 'issues'].includes(String(query.from)));
    expect(branches).toHaveLength(4);
    for (const branch of branches) {
      expect(branch.filter).toEqual({
        predicates: Object.entries(contract.run).map(([field, equals]) => ({ field, equals }))
      });
    }
    const inputs = Object.fromEntries(['audits', 'domains', 'tool-observations', 'issues'].map((source, index) => [
      source, [
        { ...contract.run, event: `${source}:selected`, 'event-timestamp': `2026-10-02T00:00:0${index}Z` },
        { ...contract.run, event: `${source}:attempt-2`, 'run-attempt': 2 },
        { ...contract.run, event: `${source}:other-run`, run: '999' }
      ]
    ]));
    const result = execute(payload.queries, payload.aliases, inputs)[payload.aliases[0]];
    expect(result.rows.map((row) => row.event)).toEqual([
      'issues:selected', 'tool-observations:selected', 'domains:selected', 'audits:selected'
    ]);
    expect(result.rows.every((row) => String(row['run-attempt']) === '1')).toBe(true);
  });

  it('keeps computed concat equality opaque, including ambiguous delimiters and missing components', () => {
    const rows = [
      { 'call-count': 1, 'tool-usage-id': 'a', 'mcp-server': 'server/with', 'mcp-tool': 'slash/tool', 'mcp-status': 'success' },
      { 'call-count': 1, 'tool-usage-id': 'b', 'mcp-server': 'server', 'mcp-tool': 'with/slash/tool', 'mcp-status': 'success' },
      { 'call-count': 1, 'tool-usage-id': 'c', 'mcp-tool': 'missing-server', 'mcp-status': 'success' },
      { 'call-count': 1, 'tool-usage-id': 'd', 'mcp-server': 'missing-tool', 'mcp-status': 'success' },
      { 'call-count': 1, 'tool-usage-id': 'e', 'mcp-server': null, 'mcp-tool': 'missing-server', 'mcp-status': 'success' },
      { 'call-count': 1, 'tool-usage-id': 'f', 'mcp-server': { untrusted: true }, 'mcp-tool': 'missing-server', 'mcp-status': 'success' }
    ];
    for (const [tool, observations] of [
      ['server/with/slash/tool', ['a', 'b']],
      ['/missing-server', ['c', 'e', 'f']],
      ['missing-tool/', ['d']]
    ]) {
      const payload = compileDetail('tool-runs', 'tool-runs-table', { tool: String(tool) });
      expect(payload.queries.some((query) => /** @type {any} */ (query.filter)?.predicates?.some(
        (/** @type {{ field: string }} */ predicate) => ['mcp-server', 'mcp-tool'].includes(predicate.field)
      ))).toBe(false);
      expect(execute(payload.queries, payload.aliases, { 'mcp-calls': rows })[payload.aliases[0]].rows
        .map((row) => row['tool-usage-id'])).toEqual(observations);
    }
  });

  it('preserves negated computed predicates without treating excluded or ambiguous labels as component filters', () => {
    const labelQuery = dashboard.queries.find((/** @type {{ name: string }} */ query) => query.name === 'mcp-tool-calls');
    const queries = [
      labelQuery,
      {
        name: 'external-calls', from: 'mcp-tool-calls',
        filter: { predicates: [{ field: 'safe-output-server', equals: false }] },
        compute: [{
          as: 'excluded-label', function: 'equals-any',
          args: [{ field: 'mcp-tool-label' }, { value: contract.tools[0] }]
        }]
      },
      {
        name: 'not-excluded', from: 'external-calls',
        filter: { predicates: [{ field: 'excluded-label', equals: false }] }
      }
    ];
    const page = {
      views: [{ data: { source: 'not-excluded', arguments: [{ name: 'tool', field: 'mcp-tool-label' }] } }]
    };
    const rows = [
      { 'call-count': 1, 'tool-usage-id': 'excluded', 'mcp-server': 'github', 'mcp-tool': 'issue_read' },
      { 'call-count': 1, 'tool-usage-id': 'internal', 'mcp-server': 'safe_outputs', 'mcp-tool': 'optimization_skills_curator' },
      { 'call-count': 1, 'tool-usage-id': 'observed-safe-output', 'mcp-server': 'safeoutputs', 'mcp-tool': 'optimization_skills_curator' },
      { 'call-count': 1, 'tool-usage-id': 'ambiguous-one', 'mcp-server': 'server/with', 'mcp-tool': 'slash/tool' },
      { 'call-count': 1, 'tool-usage-id': 'ambiguous-two', 'mcp-server': 'server', 'mcp-tool': 'with/slash/tool' }
    ];
    for (const [tool, observations] of [
      [contract.tools[0], []],
      ['safe_outputs/optimization_skills_curator', []],
      [contract.tools[1], ['observed-safe-output']],
      [contract.tools[2], ['ambiguous-one', 'ambiguous-two']]
    ]) {
      const payload = compileDashboardViewPayloadQueries(page, 'arbitrary-page', {
        queries, routeParameters: { tool: String(tool) }
      });
      expect(execute(payload.queries, payload.aliases, { 'mcp-calls': rows })[payload.aliases[0]].rows
        .map((row) => row['tool-usage-id'])).toEqual(observations);
      expect(payload.queries.some((query) => /** @type {any} */ (query.filter)?.predicates?.some(
        (/** @type {{ field: string }} */ predicate) => ['mcp-server', 'mcp-tool'].includes(predicate.field)
      ))).toBe(false);
    }
  });

  it('keeps absent, empty and nonmatching routes empty rather than falling back to all observations', () => {
    const rows = [
      { 'call-count': 1, 'tool-usage-id': 'selected', 'mcp-server': 'github', 'mcp-tool': 'issue_read' },
      { 'call-count': 1, 'tool-usage-id': 'missing-components' },
      { 'call-count': 1, 'tool-usage-id': 'empty-components', 'mcp-server': '', 'mcp-tool': '' }
    ];
    for (const route of /** @type {Record<string, string>[]} */ ([
      {}, { tool: '' }, { tool: ' ' }, { tool: 'not-observed/tool' }
    ])) {
      for (const [page, view] of [
        ['tool-runs', 'tool-runs-table'],
        ['tool-insights', 'tool-insights-chart']
      ]) {
        const payload = compileDetail(page, view, route);
        const result = execute(payload.queries, payload.aliases, { 'mcp-calls': rows })[payload.aliases[0]];
        expect(result.rows).toEqual([]);
        expect(result.metadata.availability).toBe('empty');
      }
    }
  });

  it('retains missing and unavailable branch failures even when no selected entity can match', () => {
    const payload = compileDetail('run-events', 'run-events', { ...contract.run, run: 'unknown-run' });
    const result = execute(payload.queries, payload.aliases, { domains: [], tools: [], issues: [] });
    expect(result[payload.aliases[0]].metadata).toMatchObject({
      availability: 'unavailable',
      'query-error': { code: 'input-unavailable', source: 'audits' }
    });
    const additiveUnion = execute(payload.queries, payload.aliases, { audits: [], domains: [], tools: [] });
    expect(additiveUnion[payload.aliases[0]].metadata).toMatchObject({ availability: 'empty', completeness: 'partial' });
    const tool = compileDetail('tool-insights', 'tool-insights-chart', {});
    expect(execute(tool.queries, tool.aliases, {})[tool.aliases[0]].metadata.availability).toBe('unavailable');
  });

  it('moves only group-key predicates through aggregates and preserves limit and enrichment barriers', () => {
    const definitions = [
      { name: 'base', from: 'runs', limit: 1 },
      { name: 'groups', from: 'base', aggregate: { by: ['repository'], values: [{ field: 'run', as: 'calls', reducer: 'count' }] } }
    ];
    const page = { views: [{ id: 'groups', data: { source: 'groups', arguments: [{ name: 'repo', field: 'repository' }] } }] };
    const payload = compileDashboardViewPayloadQueries(page, 'arbitrary-page', {
      queries: definitions, routeParameters: { repo: 'selected' }
    });
    const result = execute(payload.queries, payload.aliases, {
      runs: [{ run: 'first', repository: 'other' }, { run: 'second', repository: 'selected' }]
    });
    expect(result[payload.aliases[0]].rows).toEqual([]);
    expect(payload.queries.find((query) => query.from === 'runs')?.filter).toBeUndefined();
    const joinDefinitions = [
      { name: 'joined', from: 'runs', joins: [{ source: 'extra', on: [{ left: 'run', right: 'run' }], fields: [{ field: 'value', as: 'value' }] }] },
      { name: 'result', from: 'joined' }
    ];
    const joined = compileDashboardViewPayloadQueries({ views: [{ data: { source: 'result', filters: { repository: 'selected' } } }] }, 'arbitrary-page', {
      queries: joinDefinitions
    });
    const failedJoin = execute(joined.queries, joined.aliases, {
      runs: [], extra: [{ run: '1', value: 1 }, { run: '1', value: 2 }]
    })[joined.aliases[0]];
    expect(failedJoin.metadata.availability).toBe('unavailable');
  });

  it('uses unique dependency names when different declarations have the same slug', () => {
    const payload = compileDashboardViewPayloadQueries({ views: [{ data: { source: 'combined', filters: { run: '1' } } }] }, 'arbitrary-page', {
      queries: [
        { name: 'a:b', from: 'runs' },
        { name: 'a-b', from: 'runs' },
        { name: 'combined', from: 'a:b', union: ['a-b'] }
      ]
    });
    expect(new Set(payload.queries.map((query) => query.name)).size).toBe(payload.queries.length);
    expect(dashboardQueryDefects(payload.queries).size).toBe(0);
    expect(execute(payload.queries, payload.aliases, { runs: [{ run: '1' }] })[payload.aliases[0]].rows).toHaveLength(2);
  });
});
