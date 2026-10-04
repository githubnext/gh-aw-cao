import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { identityDigest } from '../../src/data/model/digest.js';
import { aggregateToolEvents, validateToolUsage } from '../../src/data/model/tool-usage.js';

const at = '2026-10-03T14:00:00.000Z';
/** @param {string} id @param {Record<string, unknown>} [fields] @returns {Record<string, unknown>} */
const event = (id, fields = {}) => ({
  id, runId: 'run:1', source: 'mcp', type: 'tool.call', status: 'started',
  timestamp: at, observedAt: at, name: 'read', toolType: 'mcp', mcpServer: 'github', mcpTool: 'read',
  correlationId: id, ...fields
});
/** @param {string} id @param {Record<string, unknown>} [fields] @param {Record<string, unknown>} [outcome] */
const pair = (id, fields = {}, outcome = {}) => [
  event(`${id}:call`, { correlationId: id, ...fields }),
  event(`${id}:result`, { type: 'tool.error', status: 'incomplete', correlationId: id, ...fields, ...outcome })
];

describe('Run/tool/source aggregate contract', () => {
  it('matches platform SHA-256 across Unicode and padding boundaries', () => {
    for (const value of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64),
      'a'.repeat(129), 'Tool \u00e9\u{1f680}', 'a'.repeat(1000000)]) {
      expect(identityDigest(value)).toBe(createHash('sha256').update(value).digest('hex'));
    }
  });
  it('collapses repeated calls with exact counters and counts each size once', () => {
    const result = aggregateToolEvents([
      ...pair('a', { requestBytes: 10, responseBytes: 0 }),
      ...pair('b', { requestBytes: 20, responseBytes: 4 }, { type: 'tool.result', status: 'success' })
    ]);
    expect(result.tools).toHaveLength(1);
    expect(result.toolIdentities).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({
      eventCount: 4, callCount: 2, outcomeCount: 2, successCount: 1, incompleteCount: 1,
      failedCount: 0, unknownOutcomeCount: 0, requestBytes: 30, requestBytesCount: 2,
      responseBytes: 4, responseBytesCount: 2, latencyCount: 0, unmatchedCount: 0, ambiguousCount: 0
    });
    expect(result.tools[0]).not.toHaveProperty('latencyMin');
    expect(result.toolCounters.find(counter => counter.type === 'tool.call')).toMatchObject({
      eventCount: 2, requestBytes: 30, responseBytes: 4
    });
    expect(result.toolCounters.find(counter => counter.type === 'tool.error')).toMatchObject({
      eventCount: 1, requestBytes: 0, responseBytes: 0
    });
    expect(() => validateToolUsage(result.tools[0])).not.toThrow();
  });

  it('distinguishes absent, explicit null, and zero measurements without inventing latency', () => {
    const { tools } = aggregateToolEvents([
      ...pair('absent'), ...pair('null', { requestBytes: null, latencyMs: null }),
      ...pair('zero', { requestBytes: 0, responseBytes: 0, latencyMs: 0 })
    ]);
    expect(tools[0]).toMatchObject({ callCount: 3, requestBytes: 0, requestBytesCount: 1,
      responseBytesCount: 1, latencySum: 0, latencyCount: 1, latencyMin: 0, latencyMax: 0 });
  });

  it('never derives zero latency from equal call and outcome timestamps', () => {
    expect(aggregateToolEvents(pair('a')).tools[0]).toMatchObject({ latencyCount: 0, latencySum: 0 });
  });

  it('separates server, name, type, version, protocol, missing, and null identity', () => {
    const variants = [{}, { mcpServer: 'other' }, { name: 'other' }, { toolType: 'bash' },
      { mcpServerVersion: '1' }, { mcpProtocolVersion: '1' }, { mcpServerVersion: null }];
    const result = aggregateToolEvents(variants.flatMap((fields, index) => pair(String(index), fields)));
    expect(result.toolIdentities).toHaveLength(variants.length);
    expect(result.tools).toHaveLength(variants.length);
  });

  it('scopes reused correlation IDs to Run and source, not globally', () => {
    const result = aggregateToolEvents([...pair('a'), ...pair('b', { runId: 'run:2', correlationId: 'a' }),
      ...pair('c', { source: 'gateway', correlationId: 'a' })]);
    expect(result.tools).toHaveLength(3);
    expect(result.tools.every(usage => usage.ambiguousCount === 0 && usage.unmatchedCount === 0)).toBe(true);
  });

  it('retains unknown outcomes and policy observations without claiming failed invocations', () => {
    const result = aggregateToolEvents([
      ...pair('a', {}, { status: 'unknown' }),
      ...pair('b', {}, { status: 'failed' }),
      event('policy', { type: 'guard_blocked', status: 'denied' })
    ]);
    expect(result.tools[0]).toMatchObject({ eventCount: 5, callCount: 2, unknownOutcomeCount: 1, failedCount: 1 });
    expect(result.toolCounters.find(counter => counter.type === 'guard_blocked')).toMatchObject({ eventCount: 1 });
  });

  it('reports unpaired and ambiguous evidence rather than inventing invocations', () => {
    const result = aggregateToolEvents([
      event('orphan'),
      ...pair('duplicate'),
      event('extra', { type: 'tool.result', status: 'success', correlationId: 'duplicate' })
    ]);
    expect(result.tools[0]).toMatchObject({ eventCount: 4, callCount: 2, unmatchedCount: 1, ambiguousCount: 3 });
  });

  it('preserves missing and null statuses as distinct native counter identities', () => {
    const missing = event('missing');
    delete missing.status;
    const result = aggregateToolEvents([missing, event('null', { status: null })]);
    expect(result.toolCounters).toHaveLength(2);
    expect(result.toolCounters.filter(counter => Object.hasOwn(counter, 'status'))).toHaveLength(1);
  });

  it('has deterministic aggregate identities and representatives across input order', () => {
    const events = [...pair('a'), ...pair('b')];
    expect(aggregateToolEvents(events)).toEqual(aggregateToolEvents([...events].reverse()));
  });

  it('requires deduplication before aggregation and rejects unsafe numeric evidence', () => {
    expect(() => aggregateToolEvents([event('a'), event('a')])).toThrow('deduplicated');
    for (const requestBytes of [-1, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => aggregateToolEvents(pair('a', { requestBytes }))).toThrow('safe integer');
    }
    expect(() => aggregateToolEvents([...pair('a', { requestBytes: Number.MAX_SAFE_INTEGER }), ...pair('b', { requestBytes: 1 })]))
      .toThrow('exact numeric budget');
  });

  it('rejects event-grain canonical Tool rows instead of supporting legacy imports', () => {
    expect(() => validateToolUsage(event('old'))).toThrow('toolId');
  });
});
