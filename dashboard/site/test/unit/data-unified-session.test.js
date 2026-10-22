import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { adaptGhAwTimelineFiles } from '../../src/data/adapters/gh-aw-logs.js';
import { normalizeSessionMcpEvents, parseUnifiedSession } from '../../src/data/adapters/unified-session.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

/** @param {Record<string, unknown>[]} events */
function session(events) {
  return [
    { type: 'session.format', data: { version: 1 } },
    ...events.map((event) => ({
      timestamp: '2026-10-15T10:00:00Z',
      provenance: { component: 'agent', path: 'native.jsonl', index: 0 },
      ...event
    }))
  ].map((event) => JSON.stringify(event)).join('\n');
}

describe('unified session ingestion', () => {
  it('prefers the unified session over conflicting raw logs for every engine', () => {
    const content = session([
      { type: 'user.message', data: { content: 'private prompt' } },
      { type: 'assistant.message', data: { content: 'private answer' } },
      { type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'call-1', input: 'private input' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true, output: 'private output' } },
      { type: 'mcp.tool_call', data: { serverName: 'github', toolName: 'get_issue', status: 'success', outputSize: 12 } },
      { type: 'mcp.guard.blocked', data: { serverName: 'github', toolName: 'create_issue' } },
      { type: 'mcp.difc.filtered', data: { serverName: 'github', toolName: 'get_file' } },
      { type: 'firewall.http_access', data: { host: 'api.github.com', status: 200 } },
      { type: 'firewall.http_access', data: { host: 'blocked.test', decision: 'DENIED', status: 403 } },
      { type: 'skill.invoked', data: { name: 'review', path: '/private/skill' } },
      { type: 'session.error', data: { message: 'private error' } }
    ]);
    const files = [
      { path: 'run-1/usage/aw_session.jsonl', content },
      { path: 'run-1/mcp-logs/gateway.jsonl', content: 'invalid legacy JSON' },
      { path: 'run-1/sandbox/firewall/audit/audit.jsonl', content: 'invalid legacy JSON' },
      { path: 'run-1/copilot-session-state/abc/events.jsonl', content: 'invalid legacy JSON' }
    ];
    const events = adaptGhAwTimelineFiles(files, 'run:1');
    expect(events.map((event) => event.kind)).toEqual([
      'audit', 'audit', 'tool', 'tool', 'tool', 'tool', 'tool', 'domain', 'domain', 'skill', 'audit'
    ]);
    expect(events.filter((event) => event.data.correlationId === 'call-1')).toHaveLength(2);
    expect(events.every((event) => event.data.runId === 'run:1')).toBe(true);
    expect(events[2].data.name).toBe('bash');
    expect(events[3].data.name).toBe('bash');
    expect(events[7].data.domain).toBe('api.github.com');
    expect(events[8].data.decision).toBe('denied');
    expect(JSON.stringify(events)).not.toContain('private');
    expect(JSON.stringify(parseUnifiedSession(content, 'aw_session.jsonl'))).not.toContain('private');
  });

  it('uses normalized provenance milliseconds instead of native clocks and skips untimed observations', () => {
    const content = session([
      {
        type: 'assistant.message', timestamp: 1792062000, data: {},
        provenance: { timestampMs: Date.parse('2026-10-15T11:00:00Z') }
      },
      { type: 'assistant.message', timestamp: 1792062000000, data: {} },
      { type: 'assistant.message', timestamp: null, data: {} },
      { type: 'unknown.future_event', data: {} }
    ]);
    const events = parseUnifiedSession(content, 'aw_session.jsonl');
    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBe('2026-10-15T11:00:00.000Z');
    expect(events[1].timestamp).toBe(new Date(1792062000000).toISOString());
    expect(events.map((event) => event.line)).toEqual([2, 3]);
  });

  it('does not invent failure for tool completions without an outcome', () => {
    const events = parseUnifiedSession(session([
      { type: 'tool.execution_complete', data: { toolName: 'bash' } },
      { type: 'tool.execution_complete', data: { toolName: 'bash', isError: true } }
    ]), 'aw_session.jsonl');
    expect(events[0].fields.status).toBeUndefined();
    expect(events[1].fields.status).toBe('error');
  });

  it('drops unused generic firewall events before canonical storage', () => {
    const content = session([
      { type: 'firewall.event', data: { event: 'response', status: 200 } }
    ]);
    expect(parseUnifiedSession(content, 'aw_session.jsonl')).toEqual([]);
    expect(adaptGhAwTimelineFiles([{ path: 'aw_session.jsonl', content }], 'run:1')).toEqual([]);
  });

  it('normalizes MCP executions, inherits completion identity, and leaves local tools alone', () => {
    const events = parseUnifiedSession(session([
      { type: 'tool.execution_start', data: { mcpServerName: 'github', toolName: 'github-actions_list', toolCallId: 'call-1' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true } },
      { type: 'tool.execution_start', data: { mcpServerName: 'github', toolName: 'issue_read', toolCallId: 'call-2' } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-2', isError: true } },
      { type: 'tool.execution_start', data: { toolName: 'view', toolCallId: 'local' } },
      { type: 'mcp.difc.filtered', data: { serverName: 'github', toolName: 'issue_read' } },
      { type: 'mcp.guard.blocked', data: { serverName: 'github', toolName: 'issue_read' } }
    ]), 'aw_session.jsonl');
    expect(events.map((event) => [event.source, event.type])).toEqual([
      ['mcp', 'tool.execution_start'], ['mcp', 'tool.execution_complete'],
      ['mcp', 'tool.execution_start'], ['mcp', 'tool.execution_complete'],
      ['agent', 'tool.execution_start'], ['mcp', 'mcp.difc.filtered'], ['mcp', 'mcp.guard.blocked']
    ]);
    expect(events[0].fields).toMatchObject({ mcpServer: 'github', mcpTool: 'actions_list', summary: 'github/actions_list' });
    expect(events[1].fields).toMatchObject({ mcpServer: 'github', mcpTool: 'actions_list', status: 'success' });
    expect(events[3].fields).toMatchObject({ mcpTool: 'issue_read', status: 'error' });
    expect(normalizeSessionMcpEvents(events)).toEqual(events);
  });

  it('counts correlated native and agent MCP evidence once, regardless of ordering', () => {
    const start = { type: 'tool.execution_start', data: { mcpServerName: 'github', toolName: 'github-issue_read', toolCallId: 'same-call' } };
    const native = { type: 'mcp.tool_call', data: { serverName: 'github', toolName: 'issue_read', toolCallId: 'same-call', inputSize: 4, outputSize: 8 } };
    for (const records of [[start, native], [native, start]]) {
      const events = parseUnifiedSession(session(records), 'aw_session.jsonl');
      expect(events.filter((event) => event.type === 'mcp.tool_call')).toMatchObject([{
        source: 'mcp', fields: { mcpTool: 'issue_read', requestBytes: 4, responseBytes: 8 }
      }]);
      expect(events.filter((event) => event.type === 'tool.execution_start')).toHaveLength(1);
      expect(normalizeSessionMcpEvents(events)).toEqual(events);
    }
  });

  it('fails explicitly for empty, malformed, unsupported or ambiguous published sessions', () => {
    for (const content of ['', '{', JSON.stringify({ type: 'session.format', data: { version: 2 } }),
      session([{ type: 'assistant.message', data: null }])]) {
      expect(() => adaptGhAwTimelineFiles([{ path: 'aw_session.jsonl', content }], 'run:1')).toThrow();
    }
    expect(() => adaptGhAwTimelineFiles([
      { path: 'usage/aw_session.jsonl', content: session([]) },
      { path: 'called-usage/aw_session.jsonl', content: session([]) }
    ], 'run:1')).toThrow('Multiple unified sessions');
    expect(adaptGhAwTimelineFiles([{ path: 'aw_session.jsonl', content: session([]) }], 'run:1')).toEqual([]);
  });

  it('retains the legacy parser only when no unified session exists', () => {
    const content = JSON.stringify({
      type: 'tool.execution_start', timestamp: '2026-10-15T10:00:00Z',
      data: { toolName: 'legacy', toolCallId: 'legacy-call' }
    });
    expect(adaptGhAwTimelineFiles([{
      path: 'copilot-session-state/abc/events.jsonl', content
    }], 'run:1')).toMatchObject([{
      kind: 'tool', data: { type: 'tool.execution_start', correlationId: 'legacy-call' }
    }]);
  });
});

describe('unified session MCP view boundary', () => {
  afterEach(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  });

  for (const retained of [false, true]) {
    it(`populates MCP views from ${retained ? 'retained pre-fix' : 'newly collected'} session evidence`, async () => {
      const content = session([
        { type: 'tool.execution_start', data: { mcpServerName: 'github', toolName: 'github-actions_list', toolCallId: 'call-1', input: 'PRIVATE_INPUT' } },
        { type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true, output: 'PRIVATE_OUTPUT' } },
        { type: 'tool.execution_start', data: { mcpServerName: 'safeoutputs', toolName: 'safeoutputs-noop', toolCallId: 'safe-1' } },
        { type: 'tool.execution_start', data: { mcpServerName: 'safe_outputs', toolName: 'noop', toolCallId: 'safe-2' } },
        { type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'local' } },
        { type: 'mcp.tool_call', data: { serverName: 'github', toolName: 'issue_read', toolCallId: 'native', inputSize: 4, outputSize: 8 } },
        { type: 'mcp.difc.filtered', data: { serverName: 'github', toolName: 'issue_read' } }
      ]);
      const events = parseUnifiedSession(content, 'usage/aw_session.jsonl').map((event) => {
        if (!retained) return event;
        const fields = { ...event.fields };
        if (fields.toolName && event.source === 'mcp') {
          delete fields.mcpTool;
          return { ...event, source: 'agent', type: event.type === 'tool.execution_start' ? 'agent_tool_start' : 'agent_tool_done', fields };
        }
        return event.type === 'mcp.tool_call' ? { ...event, type: 'tool_call' } : event;
      });
      const now = Date.parse('2026-10-15T10:05:00Z');
      await ingestCachedGhAwJsonl(indexedDB, JSON.stringify({
        schema_version: 5, kind: 'run',
        run: {
          run_id: 303, run_attempt: 1, organization: 'octo', repository: 'octo/api',
          workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
          created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:01:00Z',
          status: 'completed', conclusion: 'success',
          cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', events }
        }
      }), { now });
      const dashboard = authoritativeDashboard.dashboard;
      const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'mcps');
      const payload = compileDashboardViewPayloadQueries(page, 'mcps', {
        queries: dashboard.queries, views: dashboard.views,
        viewId: 'mcp-top-tools', sourceNames: ['mcp-top-tools']
      });
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
        await processDataRequest({
          operation: 'load-dashboard-query-sources', sources: {},
          queries: [...dashboard.queries, ...payload.queries],
          sourceNames: ['mcp-calls', 'mcp-tool-totals', ...payload.aliases]
        })
      );
      expect(result['mcp-calls'].rows).toHaveLength(4);
      expect(result['mcp-tool-totals'].rows).toEqual([
        { 'mcp-tool-label': 'github/actions_list', 'mcp-server': 'github', 'mcp-tool': 'actions_list', calls: 1, workflows: 1, 'request-bytes': 0, 'response-bytes': 0 },
        { 'mcp-tool-label': 'github/issue_read', 'mcp-server': 'github', 'mcp-tool': 'issue_read', calls: 1, workflows: 1, 'request-bytes': 4, 'response-bytes': 8 }
      ]);
      expect(result[payload.aliases[0]].metadata.availability).toBe('available');
      expect(result[payload.aliases[0]].rows).toEqual(result['mcp-tool-totals'].rows);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    });
  }
});
