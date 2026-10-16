/** @param {unknown} value */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {unknown} value */
function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** @param {Record<string, unknown>} value @param {{ runId: string, attempt: number }} [context] */
export function matchesSessionRun(value, context) {
  return !context || (['runId', 'run_id', 'runid'].every((field) =>
    value[field] === undefined || String(value[field]) === context.runId)
    && ['runAttempt', 'run_attempt'].every((field) => value[field] === undefined
      || ((typeof value[field] === 'string' || typeof value[field] === 'number')
        && Number.isInteger(Number(value[field])) && Number(value[field]) === context.attempt)));
}

/** @param {Record<string, unknown>} value @param {string[]} fields */
function strings(value, fields) {
  return Object.fromEntries(fields.filter((field) => typeof value[field] === 'string' && value[field] !== '')
    .map((field) => [field, value[field]]));
}

/** @param {Record<string, unknown>} value @param {string[]} fields */
function numbers(value, fields) {
  return Object.fromEntries(fields.filter((field) => number(value[field]) !== undefined)
    .map((field) => [field, value[field]]));
}

const TOKEN_FIELDS = {
  inputTokens: 'inputTokens', outputTokens: 'outputTokens', totalTokens: 'totalTokens',
  cacheReadInputTokens: 'cacheReadTokens', cacheCreationInputTokens: 'cacheWriteTokens',
  reasoningOutputTokens: 'reasoningTokens'
};

/** @param {unknown} input */
export function sessionUsage(input) {
  const usage = object(input);
  return Object.fromEntries(Object.entries(TOKEN_FIELDS)
    .filter(([field]) => Number.isSafeInteger(usage[field]) && Number(usage[field]) >= 0)
    .map(([field, canonical]) => [canonical, usage[field]]));
}

const METADATA_FIELDS = /** @type {Record<string, string[]>} */ ({
  'agent.execution': [],
  'session.init': ['sourceEngine', 'model', 'reasoningEffort'],
  'session.start': ['sourceEngine', 'model', 'reasoningEffort'],
  'session.info': ['model', 'status', 'sourceType', 'kind'],
  'session.shutdown': ['shutdownType', 'currentModel'],
  'session.task_complete': [],
  'session.result': ['sourceEngine', 'status', 'sourceType'],
  'prompt.system': [],
  'prompt.user': [],
  'assistant.message_update': ['model', 'sourceType'],
  'tool.execution_update': ['toolName', 'status', 'taskType', 'taskId'],
  'mcp.rpc.request': ['serverName', 'method', 'direction', 'toolName'],
  'mcp.rpc.response': ['serverName', 'method', 'direction', 'toolName'],
  'mcp.event': ['serverName', 'event', 'level', 'status'],
  'firewall.event': ['event', 'level', 'status'],
  'firewall.steering': ['event', 'level', 'status'],
  'firewall.model_routing': ['provider', 'stage', 'purpose', 'mode', 'selectedId', 'outcome', 'code'],
  'model_routing.outcome': ['status', 'failureCode'],
  'model_endpoint.mismatch': ['phase', 'configured_model', 'resolved_model', 'wire_api', 'wire_api_source'],
  'safe_output.request': ['type', 'repo', 'provider', 'status', 'errorCode'],
  'safe_output.result': ['type', 'repo', 'provider', 'status', 'errorCode'],
  'safe_output.error': ['type', 'repo', 'provider', 'status', 'errorCode'],
  'usage.report': ['provider', 'model', 'purpose', 'status'],
  'firewall.token_usage': ['provider', 'model', 'purpose', 'status'],
  'execution.result': ['outcome', 'conclusion'],
  'detection.result': ['jobResult', 'conclusion'],
  'guardrail.daily_aic': ['status'],
  'workflow.info': ['engineId', 'agentVersion', 'cliVersion', 'awfVersion', 'mcpgVersion', 'model', 'requestedModel', 'triggerType'],
  'workflow.job_result': ['jobId', 'result'],
  'plugin.installation': ['plugin', 'repository', 'ref', 'status'],
  'github_api.rate_limit': ['source', 'credentialSource', 'operation', 'resource', 'status'],
  'session.collection_warning': ['code'],
  'skill.context_delivered_ref': ['interactionId', 'source', 'contentId']
});
const DYNAMIC_EVENTS = new Set([
  'dynamicWorkflows.task_started', 'dynamicWorkflows.task_progress', 'dynamicWorkflows.task_updated',
  'dynamicWorkflows.task_notification', 'dynamicWorkflows.background_tasks_changed'
]);

/**
 * Bounded, typed metadata only. Message bodies, errors, paths, RPC payloads and
 * routing objectives are deliberately not copied, even for unknown extensions.
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @returns {{ fields: Record<string, unknown>, key?: string }[]}
 */
function metadata(type, data) {
  if (type === 'mcp.configuration') {
    return (Array.isArray(data.servers) ? data.servers : []).flatMap((candidate, index) => {
      const server = object(candidate);
      if (typeof server.serverName !== 'string') return [];
      const base = { name: server.serverName, transport: server.transport,
        ...(typeof server.required === 'boolean' ? { required: server.required } : {}) };
      const tools = Array.isArray(server.tools) ? server.tools.filter((tool) => typeof tool === 'string') : [];
      return [{ key: `server:${index}`, fields: { ...base, status: 'configured' } },
        ...tools.map((tool, toolIndex) => ({
          key: `server:${index}:tool:${toolIndex}`, fields: { name: server.serverName, summary: tool, status: 'configured-tool' }
        }))];
    });
  }
  if (type === 'skill.inventory' || type === 'model.inventory') {
    const entries = type === 'skill.inventory' ? data.skills : data.endpoints;
    return (Array.isArray(entries) ? entries : []).flatMap(/** @returns {{ key: string, fields: Record<string, unknown> }[]} */ (candidate, index) => {
      const value = object(candidate);
      if (type === 'skill.inventory') return [{
        key: String(index), fields: { ...strings(value, ['name', 'scope', 'digest']), summary: value.source, status: 'available' }
      }];
      return (Array.isArray(value.models) ? value.models : []).filter((model) => typeof model === 'string')
        .map((model, modelIndex) => ({
          key: `${index}:${modelIndex}`, fields: { provider: value.provider, model, status: 'available' }
        }));
    });
  }
  if (type === 'skill.conflict') return [{
    fields: { ...strings(data, ['name']), code: data.kind, status: 'conflict' }
  }];
  if (type === 'session.collection') {
    const sources = (Array.isArray(data.sources) ? data.sources : []).map((candidate, index) => {
      const value = object(candidate);
      return { key: `source:${index}`, fields: { ...strings(value, ['component', 'phase']),
        totalEvents: number(value.events), status: 'collected' } };
    });
    const absent = (Array.isArray(data.absentComponents) ? data.absentComponents : [])
      .filter((component) => typeof component === 'string')
      .map((component, index) => ({ key: `absent:${index}`, fields: { component, status: 'absent' } }));
    return [...sources, ...absent, { key: 'summary', fields: {
      errorsCount: number(data.warnings), totalEvents: number(data.untimedEvents), status: 'collection-summary'
    } }];
  }
  if (DYNAMIC_EVENTS.has(type)) {
    const entries = [data, ...(Array.isArray(data.tasks) ? data.tasks.map(object) : []),
      ...(Array.isArray(data.workflowProgress) ? data.workflowProgress.map(object) : [])];
    return entries.map((value, index) => ({
      key: String(index), fields: {
        ...strings(value, ['model', 'status']), name: value.workflowName ?? value.taskType,
        correlationId: value.taskId ?? value.toolCallId ?? value.agentId,
        ...sessionUsage(value.usage), ...numbers(object(value.usage), ['durationMs']),
        toolCalls: number(object(value.usage).toolUses),
        requestAttempt: number(value.attempt), decision: value.state
      }
    }));
  }
  const fields = METADATA_FIELDS[type];
  if (!fields) return [];
  const selected = strings(data, fields);
  const usage = sessionUsage(data.usage);
  /** @type {Record<string, unknown>} */
  const projected = {
    ...strings(data, ['provider', 'model', 'method', 'direction', 'resource', 'status']),
    ...numbers(data, ['durationMs', 'httpStatus', 'premiumRequests', 'totalCostUsd',
      'remaining', 'used', 'delayMs', 'threshold']),
    rateLimit: number(data.limit),
    requestAttempt: number(data.attempt),
    ...usage,
    aic: number(data.aic), totalAic: number(data.totalAic),
    sourceEngine: data.sourceEngine ?? data.engineId,
    model: data.model ?? data.wireModel ?? data.selectedModel ?? data.resolved_model ?? data.currentModel,
    effort: data.appliedEffort ?? data.effort ?? data.selectedEffort ?? data.reasoningEffort,
    correlationId: data.requestId ?? data.toolCallId ?? data.interactionId
      ?? ((typeof data.rpcId === 'string' || typeof data.rpcId === 'number') ? String(data.rpcId) : undefined),
    requestBytes: number(data.inputSize), responseBytes: number(data.outputSize),
    turns: number(data.numTurns),
    ...(typeof data.exitCode === 'number' && Number.isSafeInteger(data.exitCode) ? { exitCode: data.exitCode } : {}),
    errorsCount: Array.isArray(data.errors) ? data.errors.length : undefined,
    permissionDenialsCount: Array.isArray(data.permissionDenials) ? data.permissionDenials.length : undefined,
    summary: Object.entries(selected).map(([key, value]) => `${key}=${value}`).join(', '),
    code: data.code ?? data.errorCode ?? data.failureCode,
    name: data.jobId ?? data.plugin ?? data.kind,
    status: data.status ?? data.result ?? data.outcome ?? data.conclusion ?? data.shutdownType,
    ...(typeof data.success === 'boolean' ? { status: data.success ? 'success' : 'error' } : {}),
    ...(data.usageSnapshot !== undefined || type === 'session.result' ? { evidenceState: 'snapshot' } : {})
  };
  if (type === 'guardrail.daily_aic') {
    Object.assign(projected, { value: number(data.total), threshold: number(data.threshold),
      decision: typeof data.exceeded === 'boolean' ? (data.exceeded ? 'exceeded' : 'under-budget') : undefined });
  }
  if (type === 'github_api.rate_limit' && typeof data.reset === 'number' && Number.isFinite(data.reset)
      && data.reset > 0 && data.reset * 1000 <= 8640000000000000) {
    projected.resetAt = new Date(data.reset * 1000).toISOString();
  }
  if (type === 'detection.result') {
    return [projected, ...['promptInjection', 'secretLeak', 'maliciousPatch']
      .filter((field) => typeof data[field] === 'boolean')
      .map((field) => ({ code: field, decision: data[field] ? 'detected' : 'clear' }))]
      .map((value, index) => ({ key: String(index), fields: value }));
  }
  if (type === 'agent.execution') {
    return [projected, ...['categories', 'errorCodes', 'errorTypes'].flatMap((field) =>
      (Array.isArray(data[field]) ? data[field] : []).filter((value) =>
        typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
        .map((value) => ({ code: String(value), name: field })))]
      .map((value, index) => ({ key: String(index), fields: value }));
  }
  return [{ fields: projected }];
}

/** @param {string} type @param {Record<string, unknown>} data */
export function sessionMetadata(type, data) {
  const integers = new Set(['exitCode', 'httpStatus', 'requestBytes', 'responseBytes', 'errorsCount',
    'permissionDenialsCount', 'rateLimit', 'remaining', 'used', 'requestAttempt', 'turns', 'toolCalls', 'totalEvents']);
  return metadata(type, data).map((entry) => ({
    ...entry,
    fields: Object.fromEntries(Object.entries(entry.fields).filter(([, value]) =>
      typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)))
      .filter(([field, value]) => !integers.has(field) || Number.isSafeInteger(value)))
  }));
}

/**
 * Prefer measured per-phase usage reports over proxy copies and engine result
 * snapshots. Repeated request IDs are revisions, and cumulative AIC is not summed.
 * @param {{ record: Record<string, unknown>, line: number }[]} records
 * @param {{ runId: string, attempt: number }} context
 */
export function sessionRunMetadata(records, context) {
  /** @type {Record<string, unknown>} */
  const run = {};
  /** @type {Map<string, Map<number, Map<string, Record<string, unknown>>>>} */
  const phases = new Map();
  /** @type {Record<string, unknown>[]} */
  const safeOutputs = [];
  for (const { record, line } of records) {
    const data = object(record.data);
    const provenance = object(record.provenance);
    const phase = typeof provenance.phase === 'string' ? provenance.phase : 'agent';
    if (!matchesSessionRun(data, context)) continue;
    if (record.type === 'safe_output.result' && typeof data.type === 'string' && !data.error && !data.errorCode
        && !['error', 'failure', 'failed', 'skipped'].includes(String(data.status))) {
      const projected = { ...strings(data, ['type', 'repo', 'provider']),
        ...(Number.isSafeInteger(data.number) && Number(data.number) > 0 ? { number: data.number } : {}),
        sessionLine: line };
      if (typeof data.url === 'string') {
        try {
          const url = new URL(data.url);
          if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
            Object.assign(projected, { url: url.href });
          }
        } catch {
          // Invalid references remain metadata, never created GitHub entities.
        }
      }
      safeOutputs.push(projected);
      run.safe_outputs = safeOutputs;
      run.safe_items_count = safeOutputs.length;
    }
    if (record.type === 'workflow.info') {
      if (data.runId !== undefined && String(data.runId) !== context.runId) continue;
      const mapping = {
        engineId: 'engine_id', agentVersion: 'agent_version', cliVersion: 'cli_version',
        awfVersion: 'firewall_version', mcpgVersion: 'gateway_version', model: 'model', requestedModel: 'requested_model'
      };
      for (const [source, target] of Object.entries(mapping)) {
        if (typeof data[source] === 'string') run[target] = data[source];
      }
      const selection = object(data.modelSelection);
      const routing = object(data.modelRouting);
      const model = selection.effectiveModel ?? selection.resolvedModel ?? routing.wireModel;
      if (typeof model === 'string') run.resolved_model = model;
    }
    if (record.type === 'model_routing.outcome' && phase === 'agent' && typeof data.wireModel === 'string') {
      run.resolved_model = data.wireModel;
    }
    const rank = record.type === 'usage.report' ? 3 : record.type === 'firewall.token_usage' ? 2
      : record.type === 'session.result' && !data.parentToolCallId && !data.parentToolUseId ? 1 : 0;
    if (!rank) continue;
    const usage = sessionUsage(data.usage);
    if (!Object.keys(usage).length && number(data.aic) === undefined && number(data.totalAic) === undefined) continue;
    const sources = phases.get(phase) ?? new Map();
    const entries = sources.get(rank) ?? new Map();
    const identity = rank === 1 ? 'snapshot'
      : typeof data.requestId === 'string' ? data.requestId : `line:${line}`;
    entries.delete(identity);
    entries.set(identity, { ...usage, aic: number(data.aic), totalAic: number(data.totalAic) });
    sources.set(rank, entries);
    phases.set(phase, sources);
  }
  /** @type {Record<string, number>} */
  const totals = {};
  const fields = { inputTokens: 'total_input_tokens', outputTokens: 'total_output_tokens',
    cacheReadTokens: 'total_cache_read_tokens', cacheWriteTokens: 'total_cache_write_tokens',
    reasoningTokens: 'total_reasoning_tokens' };
  for (const sources of phases.values()) {
    for (const [field, target] of Object.entries(fields)) {
      const entries = [3, 2, 1].map((rank) => sources.get(rank))
        .find((entries) => entries && [...entries.values()].some((usage) => typeof usage[field] === 'number'));
      if (!entries) continue;
      for (const usage of entries.values()) {
        if (typeof usage[field] === 'number') totals[target] = (totals[target] ?? 0) + usage[field];
      }
    }
    const entries = [3, 2, 1].map((rank) => sources.get(rank))
      .find((entries) => entries && [...entries.values()].some((usage) =>
        typeof usage.aic === 'number' || typeof usage.totalAic === 'number'));
    if (!entries) continue;
    let aic;
    let cumulative;
    for (const usage of entries.values()) {
      if (typeof usage.aic === 'number') aic = (aic ?? 0) + usage.aic;
      if (typeof usage.totalAic === 'number') cumulative = usage.totalAic;
    }
    const measured = cumulative ?? aic;
    if (measured !== undefined) totals.total_aic = (totals.total_aic ?? 0) + measured;
  }
  if (Object.keys(totals).length) run.token_usage_summary = totals;
  return run;
}
