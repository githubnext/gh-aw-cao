import { describe, expect, it } from 'vitest';
import { adaptGhAwTimelineFiles } from '../../src/data/adapters/gh-aw-logs.js';
import { parseUnifiedSession } from '../../src/data/adapters/unified-session.js';

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
      kind: 'tool', data: { type: 'agent_tool_start', correlationId: 'legacy-call' }
    }]);
  });
});
