import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseUnifiedSessionDocument } from '../../src/data/adapters/unified-session.js';
import { adaptCachedGhAwJsonl, adaptGhAwLogs } from '../../src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../src/data/normalize/index.js';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { processDataRequest } from '../../src/data-worker.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const content = readFileSync(resolve('test/fixtures/unified-telemetry-session.jsonl'), 'utf8');
const document = () => ({
  version: 1, path: 'usage/aw_session.jsonl',
  ...parseUnifiedSessionDocument(content, 'usage/aw_session.jsonl', { runId: '303', attempt: 1 })
});
const cached = () => `${JSON.stringify({
  schema_version: 5, kind: 'run', run: {
    run_id: 303, run_attempt: 1, organization: 'octo', repository: 'octo/api',
    workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
    created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:01:00Z',
    status: 'completed', conclusion: 'success',
    model_id: 'legacy-model', engine_id: 'legacy-engine',
    token_usage_summary: { total_aic: 999, total_input_tokens: 999 },
    mcp_tool_usage: { tool_calls: [{ tool_name: 'legacy-tool' }] },
    firewall_analysis: { requests_by_domain: { 'legacy.test': { allowed: 20 } } },
    safe_outputs: [{ type: 'create_issue', url: 'https://github.com/octo/api/issues/999' }],
    cao_unified_session: document()
  }
})}\n`;

afterEach(() => vi.unstubAllGlobals());

describe('complete unified telemetry ingestion', () => {
  it('mines every retained telemetry family without payload bodies or invented native timestamps', () => {
    const parsed = document();
    const types = new Set(parsed.events.map((event) => event.type));
    const native = content.trim().split('\n').map((line) => JSON.parse(line));
    for (const event of parsed.events) {
      expect(event.type).toBe(native[event.line - 1].type);
    }
    for (const event of native) {
      if (['session.format', 'mcp.tool_call', 'mcp.guard.blocked', 'mcp.difc.filtered',
        'firewall.http_access', 'skill.invoked'].includes(event.type)) continue;
      expect(types.has(event.type), event.type).toBe(true);
    }
    expect(parsed.events.filter((event) => event.type === 'mcp.configuration')).toHaveLength(2);
    expect(parsed.events.find((event) => event.type === 'workflow.info')).not.toHaveProperty('timestamp', expect.anything());
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE_/);
    const batch = normalize(adaptCachedGhAwJsonl(cached()).observations);
    expect(batch.tools.filter((row) => row.type === 'mcp.tool_call')).toHaveLength(1);
    expect(batch.domains).toHaveLength(2);
    expect(batch.domains.find((row) => row.domain === 'api.github.com')).toMatchObject({
      method: 'GET', responseBytes: 1024, latencyMs: 7
    });
    expect(batch.issues).toMatchObject([{ number: 42, url: 'https://github.com/octo/api/issues/42' }]);
    expect(JSON.stringify(batch)).not.toMatch(/PRIVATE_|legacy-tool|legacy\.test|issues\/999/);
  });

  it('uses measured per-phase reports once, not proxy duplicates, repeated request revisions or engine snapshots', () => {
    const batch = normalize(adaptCachedGhAwJsonl(cached()).observations);
    expect(batch.runs).toMatchObject([{
      agentId: 'copilot', agentVersion: '1.0', modelId: 'gpt-model',
      resolvedModel: 'gpt-model', ghAwVersion: '0.92.4', firewallVersion: '0.9', gatewayVersion: '0.8',
      aicTotal: 1.2, inputTokens: 12, outputTokens: 3, cacheReadTokens: 3, reasoningTokens: 1
    }]);
    expect(batch.audits.find((row) => row.type === 'session.result')).toMatchObject({
      evidenceState: 'snapshot', inputTokens: 999, errorsCount: 1, permissionDenialsCount: 1
    });
  });

  it('uses RPC request/response pairs when combined MCP tool-call records are unavailable', () => {
    const events = [
      { type: 'session.format', data: { version: 1 } },
      { type: 'mcp.rpc.request', data: { serverName: 'github', rpcId: 1, direction: 'OUT', method: 'tools/call', toolName: 'get_issue' } },
      { type: 'mcp.rpc.response', data: { serverName: 'github', rpcId: 1, direction: 'IN', outputSize: 7, error: { message: 'PRIVATE_RPC_ERROR' } } }
    ].map((event) => JSON.stringify(event)).join('\n');
    const batch = normalize(adaptGhAwLogs({
      observedAt: '2026-10-15T10:01:00Z',
      repository: { githubId: 1, owner: 'octo', name: 'api' },
      workflow: { githubId: 2, name: 'Worker', path: '.github/workflows/worker.lock.yml' },
      run: { githubRunId: 303, attempt: 1, createdAt: '2026-10-15T10:00:00Z' },
      files: [{ path: 'usage/aw_session.jsonl', content: events }]
    }).observations);
    expect(batch.tools).toMatchObject([
      { mcpServer: 'github', mcpTool: 'get_issue', type: 'mcp.rpc.request', invocationCount: 1 },
      { mcpServer: 'github', mcpTool: 'get_issue', type: 'mcp.rpc.response', invocationCount: 0, responseBytes: 7 }
    ]);
    expect(JSON.stringify(batch)).not.toMatch(/PRIVATE_/);
  });

  it('fills unreported accounting dimensions independently without adding snapshots or trusting unrelated run identities', () => {
    const parsed = parseUnifiedSessionDocument([
      { type: 'session.format', data: { version: 1 } },
      { type: 'workflow.info', data: { runId: '404', engineId: 'wrong-engine' } },
      { type: 'usage.report', data: { requestId: 'request-1', aic: 0.5 } },
      { type: 'firewall.token_usage', data: { requestId: 'request-1', aic: 999, usage: { inputTokens: 10 } } },
      { type: 'session.result', data: { usage: { inputTokens: 999, outputTokens: 3 } } },
      { type: 'session.info', data: { usageSnapshot: { outputTokens: 999 }, estimatedTokens: 999 } },
      { type: 'firewall.http_access', data: { host: 'api.github.com', decision: 'ALLOWED', status: 404 } },
      { type: 'safe_output.request', data: { type: 'create_issue', url: 'https://github.com/octo/api/issues/1' } },
      { type: 'safe_output.result', data: { type: 'create_issue', status: 'error', url: 'https://github.com/octo/api/issues/2' } }
    ].map((event) => JSON.stringify(event)).join('\n'), 'usage/aw_session.jsonl', { runId: '303', attempt: 1 });
    expect(parsed.run).toEqual({ token_usage_summary: { total_aic: 0.5, total_input_tokens: 10, total_output_tokens: 3 } });
    expect(parsed.events.find((event) => event.source === 'firewall')?.fields.decision).toBe('allowed');
    expect(JSON.stringify(parsed)).not.toContain('wrong-engine');
    expect(parsed.run).not.toHaveProperty('safe_outputs');
  });

  it('exposes measured MCP, firewall and runtime metadata through canonical ingestion and production worker queries', async () => {
    const indexedDB = new IDBFactory();
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    await ingestCachedGhAwJsonl(indexedDB, cached(), { now: Date.parse('2026-10-16T00:00:00Z') });
    const sources = /** @type {Record<string, { rows: Record<string, unknown>[] }>} */ (await processDataRequest({
      operation: 'query-canonical-dashboard', sourceNames: ['mcp-calls', 'domains', 'audits'],
      context: { queries: authoritativeDashboard.dashboard.queries, pages: authoritativeDashboard.dashboard.pages }
    }));
    expect(sources['mcp-calls'].rows).toMatchObject([{
      'mcp-server': 'github', 'mcp-tool': 'get_issue', 'request-bytes': 8, 'response-bytes': 42
    }]);
    expect(sources['mcp-calls'].rows).toHaveLength(1);
    expect(sources.domains.rows.find((row) => row.domain === 'api.github.com')).toMatchObject({
      method: 'GET', 'response-bytes': 1024, 'latency-ms': 7
    });
    expect(sources.audits.rows.find((row) => row['event-type'] === 'github_api.rate_limit')).toMatchObject({
      resource: 'core', limit: 5000, remaining: 4999, used: 1, 'delay-ms': 5, 'request-attempt': 1
    });
    expect(sources.audits.rows.find((row) => row['event-type'] === 'workflow.info')).toMatchObject({
      'telemetry-engine': 'copilot', 'telemetry-model': 'auto'
    });
  });
});
