/**
 * @typedef {{
 *   line: number, timestamp: string, source: string, type: string,
 *   fields: Record<string, unknown>
 * }} SessionEvidence
 */

import { createDebug } from '../../debug.js';

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

/** @param {ReturnType<typeof sessionRecords>} records */
function timeline(records) {
  let turn = 0;
  /** @type {Map<string, { server?: string, tool?: string }>} */
  const tools = new Map();
  const evidence = records.flatMap(({ record, line }) => {
    const data = /** @type {Record<string, unknown>} */ (record.data);
    const provenance = object(record.provenance);
    // Native numeric clocks vary by source; gh-aw supplies normalized milliseconds.
    const clock = provenance?.timestampMs ?? record.timestamp;
    const milliseconds = typeof clock === 'number' ? clock
      : typeof clock === 'string' ? Date.parse(clock) : NaN;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8640000000000000) return [];
    const timestamp = new Date(milliseconds).toISOString();
    const toolKey = JSON.stringify([data.sessionId, data.agentId, data.parentToolCallId, data.toolCallId]);
    const previous = record.type === 'tool.execution_complete' ? tools.get(toolKey) : undefined;
    const server = string(data.mcpServerName ?? data.serverName) ?? previous?.server;
    const tool = string(data.toolName) ?? previous?.tool;
    if (record.type === 'tool.execution_start' && string(data.toolCallId)) {
      tools.set(toolKey, { server, tool });
    }
    const summary = [server, tool].filter(Boolean).join('/');
    const correlationId = string(data.toolCallId);
    /** @type {Record<string, unknown>} */
    const fields = {};
    let source = 'agent';
    let type;
    switch (record.type) {
      case 'user.message':
        type = 'agent_turn';
        fields.summary = `turn ${++turn}`;
        break;
      case 'assistant.message':
        type = 'assistant_message';
        break;
      case 'assistant.reasoning':
        type = 'reasoning';
        break;
      case 'tool.execution_start':
      case 'tool.execution_complete':
        type = record.type === 'tool.execution_start' ? 'agent_tool_start' : 'agent_tool_done';
        Object.assign(fields, { summary, toolName: tool, mcpServer: server, correlationId });
        if (record.type === 'tool.execution_complete') {
          fields.status = data.success === true ? 'success'
            : data.success === false || data.isError === true ? 'error' : string(data.status);
        }
        break;
      case 'mcp.tool_call':
      case 'mcp.difc.filtered':
      case 'mcp.guard.blocked':
        source = 'mcp';
        type = record.type === 'mcp.tool_call' ? 'tool_call'
          : record.type === 'mcp.difc.filtered' ? 'difc_filtered' : 'guard_blocked';
        Object.assign(fields, {
          summary, mcpServer: server, mcpTool: tool, correlationId,
          status: string(data.status),
          requestBytes: typeof data.inputSize === 'number' ? data.inputSize : undefined,
          responseBytes: typeof data.outputSize === 'number' ? data.outputSize : undefined
        });
        break;
      case 'firewall.http_access': {
        const host = string(data.host);
        if (!host) return [];
        let domain;
        try {
          domain = new URL(host.includes('://') ? host : `https://${host}`).hostname;
        } catch {
          return [];
        }
        const denied = /denied|blocked|reject/i.test(String(data.decision ?? ''))
          || (Number(data.status) >= 400 && Number(data.status) < 600);
        source = 'firewall';
        type = denied ? 'net_blocked' : 'net_allowed';
        Object.assign(fields, {
          summary: domain, domain, decision: denied ? 'denied' : 'allowed', requestCount: 1,
          status: typeof data.status === 'number' ? String(data.status) : undefined
        });
        break;
      }
      case 'skill.invoked':
        source = 'audit';
        type = 'audit.skill_activation';
        Object.assign(fields, {
          name: string(data.name ?? data.skillName), summary: string(data.name ?? data.skillName),
          invocationCount: 1, failedCount: data.success === false ? 1 : 0
        });
        if (string(data.source)) fields.activationSource = string(data.source);
        break;
      case 'session.error':
      case 'assistant.refusal':
      case 'session.collection_warning':
        type = record.type;
        fields.status = record.type === 'session.error' ? 'error' : 'warning';
        break;
      default:
        return [];
    }
    return [{ line, timestamp, source, type, fields }];
  });
  debugUnifiedSession({ event: 'parsed', records: records.length, evidence: evidence.length, skipped: records.length - evidence.length, turns: turn });
  return evidence;
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
  /** @param {Record<string, unknown>} value */
  const matchesRun = (value) => ['runId', 'run_id', 'runid'].every((field) =>
    value[field] === undefined || String(value[field]) === context.runId)
    && ['runAttempt', 'run_attempt'].every((field) => value[field] === undefined
      || (Number.isInteger(Number(value[field])) && Number(value[field]) === context.attempt));
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
        if (!matchesRun(data)) break;
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
        if (!matchesRun(data) || (run && (String(run.id) !== context.runId
            || (run.attempt !== undefined && Number(run.attempt) !== context.attempt)))) break;
        for (const candidate of Array.isArray(data.results) ? data.results : [data]) {
          const grader = object(candidate);
          if (!grader || typeof grader.id !== 'string' || !grader.id.trim()) {
            throw new TypeError(`${path}:${line} must contain a grader identity`);
          }
          if (!matchesRun(grader)) continue;
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
        if (!matchesRun(data)) break;
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
  return { events: timeline(records), ...evidence };
}
