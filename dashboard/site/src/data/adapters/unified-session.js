/**
 * @typedef {{
 *   line: number, timestamp?: string, source: string, type: string,
 *   fields: Record<string, unknown>, key?: string
 * }} SessionEvidence
 */

import { createDebug } from '../../debug.js';
import { matchesSessionRun, sessionMetadata, sessionRunMetadata } from './unified-session-telemetry.js';
import { alignSessionEventRecord } from '../model/session-types.js';

const debugUnifiedSession = createDebug('unified-session');

/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} value */
function string(value) {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Normalize both freshly parsed and retained safe session projections.
 * @param {SessionEvidence[]} events
 * @returns {SessionEvidence[]}
 */
export function normalizeSessionMcpEvents(events) {
  events = events.map((event) => {
    const record = alignSessionEventRecord({ ...event.fields, type: event.type });
    const { type, ...fields } = record;
    return { ...event, type: String(type), fields };
  });
  const identity = (/** @type {SessionEvidence} */ event) => {
    const server = string(event.fields.mcpServer);
    const name = string(event.fields.mcpTool ?? event.fields.toolName);
    const tool = server && event.source === 'agent' && name?.startsWith(`${server}-`)
      ? name.slice(server.length + 1) : name;
    const correlation = string(event.fields.correlationId);
    return { server, tool, key: correlation ? JSON.stringify([server, tool, correlation]) : null };
  };
  const nativeCalls = new Set(events.filter((event) => (
    event.source === 'mcp' && ['mcp.tool_call', 'mcp.rpc.request'].includes(event.type)
  )).map((event) => identity(event).key).filter((key) => key !== null));
  return events.map((event) => {
    const { server, tool, key } = identity(event);
    if (event.source !== 'agent' || !server || !tool
        || !['tool.execution_start', 'tool.execution_complete'].includes(event.type)
        || (event.type === 'tool.execution_start' && key !== null && nativeCalls.has(key))) return event;
    return {
      ...event,
      source: 'mcp',
      fields: { ...event.fields, summary: `${server}/${tool}`, mcpServer: server, mcpTool: tool }
    };
  });
}

/**
 * Project gh-aw v1 unified sessions to bounded metadata, never message bodies,
 * tool inputs/outputs, raw errors, or native provenance.
 * @param {string} content
 * @param {string} path
 */
function sessionRecords(content, path) {
  const records = content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let record;
    try {
      record = object(JSON.parse(line));
    } catch {
      throw new TypeError(`${path}:${index + 1} must contain valid JSON`);
    }
    if (!record || typeof record.type !== 'string' || !object(record.data)) {
      throw new TypeError(`${path}:${index + 1} must contain a unified session event`);
    }
    return [{ record, line: index + 1 }];
  });
  if (records[0]?.record.type !== 'session.format'
      || object(records[0].record.data)?.version !== 1) {
    debugUnifiedSession({ event: 'format-rejected', records: records.length });
    throw new TypeError(`${path} must declare unified session format version 1`);
  }
  return records;
}

/** @param {ReturnType<typeof sessionRecords>} records @param {boolean} [includeUntimed] @param {{ runId: string, attempt: number }} [context] */
function timeline(records, includeUntimed = false, context) {
  let turn = 0;
  /** @type {Map<string, { server?: string, tool?: string }>} */
  const tools = new Map();
  /** @type {Map<string, { server?: string, tool?: string }>} */
  const rpcCalls = new Map();
  const combinedCalls = new Set(records.flatMap(({ record }) => {
    const data = object(record.data) ?? {};
    return record.type === 'mcp.tool_call' && matchesSessionRun(data, context)
      ? [JSON.stringify([data.serverName ?? data.mcpServerName, data.toolName])] : [];
  }));
  const evidence = records.flatMap(({ record, line }) => {
    const data = /** @type {Record<string, unknown>} */ (record.data);
    if (!matchesSessionRun(data, context)) return [];
    const provenance = object(record.provenance);
    // Native numeric clocks vary by source; gh-aw supplies normalized milliseconds.
    const clock = provenance?.timestampMs ?? record.timestamp;
    const milliseconds = typeof clock === 'number' ? clock
      : typeof clock === 'string' ? Date.parse(clock) : NaN;
    const timestamp = Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8640000000000000
      ? new Date(milliseconds).toISOString() : undefined;
    if (!timestamp && !includeUntimed) return [];
    const toolKey = JSON.stringify([data.sessionId, data.agentId, data.parentToolCallId, data.toolCallId]);
    const previous = record.type === 'tool.execution_complete' ? tools.get(toolKey) : undefined;
    const rpcKey = JSON.stringify([data.serverName, data.rpcId ?? data.requestId]);
    const previousRpc = record.type === 'mcp.rpc.response' ? rpcCalls.get(rpcKey) : undefined;
    const server = string(data.mcpServerName ?? data.serverName) ?? previous?.server ?? previousRpc?.server;
    const tool = string(data.toolName) ?? previous?.tool ?? previousRpc?.tool;
    if (record.type === 'tool.execution_start' && string(data.toolCallId)) {
      tools.set(toolKey, { server, tool });
    }
    if (record.type === 'mcp.rpc.request' && data.method === 'tools/call') {
      rpcCalls.set(rpcKey, { server, tool });
    }
    const summary = [server, tool].filter(Boolean).join('/');
    const correlationId = string(data.toolCallId);
    /** @type {Record<string, unknown>} */
    const fields = {};
    let source = 'agent';
    switch (record.type) {
      case 'user.message':
        fields.summary = `turn ${++turn}`;
        break;
      case 'assistant.message':
      case 'assistant.reasoning':
        break;
      case 'tool.execution_start':
      case 'tool.execution_complete':
        Object.assign(fields, { summary, toolName: tool, mcpServer: server, correlationId });
        fields.invocationCount = record.type === 'tool.execution_start' ? 1 : 0;
        if (typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0) {
          fields.latencyMs = data.durationMs;
        }
        if (record.type === 'tool.execution_complete') {
          fields.status = data.success === true ? 'success'
            : data.success === false || data.isError === true ? 'error' : string(data.status);
        }
        break;
      case 'mcp.tool_call':
      case 'mcp.difc.filtered':
      case 'mcp.guard.blocked':
        source = 'mcp';
        Object.assign(fields, {
          summary, mcpServer: server, mcpTool: tool, correlationId,
          status: data.httpStatus === 429 ? 'rate-limited'
            : (data.error !== undefined && data.error !== null && data.error !== false)
              || (typeof data.httpStatus === 'number' && data.httpStatus >= 400) ? 'error' : string(data.status),
          invocationCount: record.type === 'mcp.tool_call' ? 1 : 0
        });
        for (const [native, canonical] of [['inputSize', 'requestBytes'], ['outputSize', 'responseBytes'], ['durationMs', 'latencyMs']]) {
          if (typeof data[native] === 'number' && Number.isFinite(data[native]) && Number(data[native]) >= 0
              && (canonical === 'latencyMs' || Number.isSafeInteger(data[native]))) {
            fields[canonical] = data[native];
          }
        }
        break;
      case 'mcp.rpc.request':
      case 'mcp.rpc.response':
        if (!combinedCalls.has(JSON.stringify([server, tool])) && tool && (data.method === 'tools/call' || previousRpc)
            && (data.direction === undefined || /^(OUT|OUTBOUND|IN|INBOUND)$/i.test(String(data.direction)))) {
          source = 'mcp';
          const failed = (data.error !== undefined && data.error !== null && data.error !== false)
            || (typeof data.httpStatus === 'number' && data.httpStatus >= 400);
          Object.assign(fields, { summary, mcpServer: server, mcpTool: tool,
            correlationId: string(data.toolCallId ?? data.requestId) ?? (data.rpcId === undefined ? undefined : String(data.rpcId)),
            invocationCount: record.type === 'mcp.rpc.request' ? 1 : 0,
            status: data.httpStatus === 429 ? 'rate-limited'
              : string(data.status) ?? (record.type === 'mcp.rpc.request' ? 'started' : failed ? 'error' : 'success') });
          for (const [native, canonical] of [['inputSize', 'requestBytes'], ['outputSize', 'responseBytes'], ['durationMs', 'latencyMs']]) {
            if (typeof data[native] === 'number' && Number.isFinite(data[native]) && Number(data[native]) >= 0
                && (canonical === 'latencyMs' || Number.isSafeInteger(data[native]))) fields[canonical] = data[native];
          }
          break;
        }
        return sessionMetadata(String(record.type), { ...data, serverName: server, toolName: tool }).map((entry) => ({
          line, timestamp, source: 'session', type: String(record.type), ...entry
        }));
      case 'firewall.http_access': {
        const host = string(data.host);
        if (!host) return [];
        let domain;
        try {
          domain = new URL(host.includes('://') ? host : `https://${host}`).hostname;
        } catch {
          return [];
        }
        const decision = String(data.decision ?? '');
        const denied = /denied|blocked|reject/i.test(decision)
          || (!/allow|tcp_miss|tunnel/i.test(decision) && Number(data.status) >= 400 && Number(data.status) < 600);
        source = 'firewall';
        Object.assign(fields, {
          summary: domain, domain, decision: denied ? 'denied' : 'allowed', requestCount: 1,
          status: typeof data.status === 'number' ? String(data.status) : string(data.status),
          method: string(data.method),
          ...(typeof data.bytes === 'number' && Number.isSafeInteger(data.bytes) && data.bytes >= 0 ? { responseBytes: data.bytes } : {}),
          ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? { latencyMs: data.durationMs } : {})
        });
        break;
      }
      case 'skill.invoked':
        source = 'audit';
        Object.assign(fields, {
          name: string(data.name ?? data.skillName), summary: string(data.name ?? data.skillName),
          invocationCount: 1, failedCount: data.success === false ? 1 : 0
        });
        if (string(data.source)) fields.activationSource = string(data.source);
        break;
      case 'session.error':
      case 'assistant.refusal':
      case 'session.collection_warning':
        fields.status = record.type === 'session.error' ? 'error' : 'warning';
        fields.code = string(data.code ?? data.policyCategory);
        if (record.type === 'session.error') {
          fields.model = string(data.model);
          if (typeof data.statusCode === 'number' && Number.isSafeInteger(data.statusCode)) fields.httpStatus = data.statusCode;
        }
        break;
      default:
        return sessionMetadata(String(record.type), data).map((entry) => ({
          line, timestamp, source: 'session', type: String(record.type), ...entry,
          fields: Object.fromEntries(Object.entries({
            ...entry.fields, component: provenance?.component, phase: provenance?.phase
          }).filter(([, value]) => typeof value === 'string' || typeof value === 'boolean'
            || (typeof value === 'number' && Number.isFinite(value))))
        }));
    }
    return [{ line, timestamp, source, type: String(record.type), fields }];
  });
  debugUnifiedSession({ event: 'parsed', records: records.length, evidence: evidence.length,
    skipped: records.length - new Set(evidence.map((event) => event.line)).size, turns: turn });
  return normalizeSessionMcpEvents(evidence);
}

/** @param {string} content @param {string} path */
export function parseUnifiedSession(content, path) {
  return timeline(sessionRecords(content, path));
}

/**
 * Keep typed evaluation evidence even when the producer has no event clock.
 * Observation time is supplied by ingestion, not invented as a session event.
 * @param {string} content
 * @param {string} path
 * @param {{ runId: string, attempt: number }} context
 */
export function parseUnifiedSessionDocument(content, path, context) {
  const records = sessionRecords(content, path);
  /** @type {Record<string, unknown>} */
  const evidence = {};
  /** @type {Map<string, Record<string, unknown>>} */
  const manifest = new Map();
  /** @type {Record<string, unknown>[]} */
  const results = [];
  /** @type {Record<string, unknown>[]} */
  const evals = [];
  /** @param {Record<string, unknown>} value @param {string[]} fields */
  const select = (value, fields) => Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field) && (value[field] === null
      || ['string', 'boolean'].includes(typeof value[field])
      || (typeof value[field] === 'number' && Number.isFinite(value[field]))))
    .map((field) => [field, value[field]]));
  const graderFields = ['id', 'name', 'status', 'value', 'score', 'unit', 'passed', 'direction',
    'threshold', 'source', 'digest', 'experimentId', 'experiment_id', 'variant'];
  for (const { record, line } of records) {
    const data = /** @type {Record<string, unknown>} */ (record.data);
    const clock = object(record.provenance)?.timestampMs ?? record.timestamp;
    const milliseconds = typeof clock === 'number' ? clock : typeof clock === 'string' ? Date.parse(clock) : NaN;
    const timestamp = Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8640000000000000
      ? new Date(milliseconds).toISOString() : undefined;
    const observation = { ...(timestamp ? { timestamp } : {}), sessionPayloadRef: `${path}#L${line}` };
    switch (record.type) {
      case 'experiment.state':
        // State files can contain a ledger for many runs.
        if (String(data.runId) !== context.runId) break;
        // falls through
      case 'experiment.assignment': {
        if (!matchesSessionRun(data, context)) break;
        const assignments = object(data.assignments);
        if (!assignments) throw new TypeError(`${path}:${line} must contain experiment assignments`);
        evidence.experiments = { assignments: Object.fromEntries(Object.entries(assignments)
          .filter(([name, variant]) => name.trim() && typeof variant === 'string' && variant.trim())) };
        break;
      }
      case 'grader.manifest':
        for (const candidate of Array.isArray(data.graders) ? data.graders : []) {
          const grader = object(candidate);
          if (grader && typeof grader.id === 'string') manifest.set(grader.id, select(grader, graderFields));
        }
        break;
      case 'grader.result': {
        const run = object(data.run);
        if (!matchesSessionRun(data, context) || (run && (String(run.id) !== context.runId
            || (run.attempt !== undefined && Number(run.attempt) !== context.attempt)))) break;
        for (const candidate of Array.isArray(data.results) ? data.results : [data]) {
          const grader = object(candidate);
          if (!grader || typeof grader.id !== 'string' || !grader.id.trim()) {
            throw new TypeError(`${path}:${line} must contain a grader identity`);
          }
          if (!matchesSessionRun(grader, context)) continue;
          const implementation = object(grader.implementation);
          results.push({
            ...select(grader, graderFields), ...observation,
            ...(typeof implementation?.digest === 'string' ? { evaluatorDigest: implementation.digest } : {}),
            ...(Array.isArray(grader.metrics) ? { metrics: grader.metrics.flatMap((metric) => {
              const value = object(metric);
              return value && typeof value.id === 'string' && value.id.trim()
                && typeof value.value === 'number' && Number.isFinite(value.value)
                ? [{ id: value.id, value: value.value }] : [];
            }) } : {})
          });
        }
        // An explicit empty result document is authoritative, too.
        evidence.graders = { results };
        break;
      }
      case 'eval.result':
        if (!matchesSessionRun(data, context)) break;
        evals.push({ ...select(data, ['id', 'answer', 'runId', 'experimentId', 'experiment_id', 'variant']), ...observation });
        evidence.evals = evals;
        break;
      default:
        break;
    }
  }
  for (const result of results) {
    const metadata = manifest.get(String(result.id));
    if (metadata) {
      for (const [field, value] of Object.entries(metadata)) {
        if (result[field] === undefined) result[field] = value;
      }
    }
  }
  const run = sessionRunMetadata(records, context);
  if (Array.isArray(run.safe_outputs)) {
    run.safe_outputs = run.safe_outputs.map((output) => {
      const { sessionLine, ...fields } = output;
      return { ...fields, sessionPayloadRef: `${path}#L${sessionLine}` };
    });
  }
  return { events: timeline(records, true, context), run, ...evidence };
}
