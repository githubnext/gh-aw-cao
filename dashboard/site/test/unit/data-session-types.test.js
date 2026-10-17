import { describe, expect, it } from 'vitest';
import { alignSessionEventRecord, unifiedSessionEventType } from '../../src/data/model/session-types.js';
import { pruneCanonicalRecord } from '../../src/data/model/fields.js';

describe('AW unified session event identifiers', () => {
  it('preserves native and source-specific identifiers without rewriting outcomes into type IDs', () => {
    for (const type of ['user.message', 'assistant.reasoning', 'tool.execution_start',
      'tool.execution_complete', 'mcp.tool_call', 'mcp.rpc.request', 'mcp.rpc.response',
      'mcp.guard.blocked', 'mcp.difc.filtered', 'firewall.http_access', 'skill.invoked',
      'grader.result', 'eval.result', 'safe_output.result', 'audit.finding', 'future.event']) {
      const record = { id: 'original-id', type, status: 'error', payloadRef: 'aw_session.jsonl#L2' };
      expect(unifiedSessionEventType(type)).toBe(type);
      expect(alignSessionEventRecord(record)).toBe(record);
    }
  });

  it.each([
    ['agent_turn', 'user.message'],
    ['assistant_message', 'assistant.message'],
    ['reasoning', 'assistant.reasoning'],
    ['agent_tool_start', 'tool.execution_start'],
    ['agent_tool_done', 'tool.execution_complete'],
    ['tool_call', 'mcp.tool_call'],
    ['tool.call', 'mcp.tool_call'],
    ['difc_filtered', 'mcp.difc.filtered'],
    ['guard_blocked', 'mcp.guard.blocked'],
    ['audit.skill_activation', 'skill.invoked'],
    ['workflow_run_grader', 'grader.result'],
    ['workflow_run_eval', 'eval.result'],
    ['safe_output.created', 'safe_output.result']
  ])('accepts retained %s evidence but emits %s', (legacy, native) => {
    const record = { id: 'stable-id', type: legacy, payloadRef: 'retained.jsonl#L3' };
    expect(pruneCanonicalRecord('audits', record)).toEqual({ ...record, type: native });
  });

  it('retains failure and decision facts when old split types are canonicalized', () => {
    expect(pruneCanonicalRecord('tools', { type: 'tool.error' }))
      .toEqual({ type: 'tool.execution_complete', status: 'error' });
    expect(pruneCanonicalRecord('tools', { type: 'tool.result' }))
      .toEqual({ type: 'tool.execution_complete' });
    expect(pruneCanonicalRecord('domains', { type: 'net_allowed' }))
      .toEqual({ type: 'firewall.http_access', decision: 'allowed' });
    expect(pruneCanonicalRecord('domains', { type: 'firewall.request.blocked' }))
      .toEqual({ type: 'firewall.http_access', decision: 'denied' });
    expect(pruneCanonicalRecord('domains', { type: 'net_blocked', decision: 'blocked' }))
      .toEqual({ type: 'firewall.http_access', decision: 'blocked' });
  });

  it('normalizes numeric event statuses without changing the source record', () => {
    const record = { type: 'firewall.event', status: 200 };
    expect(alignSessionEventRecord(record)).toEqual({ ...record, status: '200' });
    expect(record.status).toBe(200);
    expect(pruneCanonicalRecord('audits', record)).toEqual({ ...record, status: '200' });
    expect(alignSessionEventRecord({ type: 'firewall.event', status: null }))
      .toEqual({ type: 'firewall.event', status: null });
  });
});
