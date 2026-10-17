/** Metadata-only projection of the model-routing analytics session contract. */

import { createDebug } from '../../debug.js';

const debugModelRouting = createDebug('model-routing');

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}

/** @param {Record<string, unknown>} data @param {string} name */
function field(data, name) {
  return data[name] ?? data[name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
}

/** @param {unknown} value */
function identifier(value) {
  return value === '[redacted]' ? 'redacted'
    : typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) ? value : undefined;
}

/** @param {unknown} value */
function model(value) {
  return identifier(value)?.split('/').at(-1);
}

/** @param {unknown} value */
function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const TYPES = new Set([
  'firewall.model_routing', 'firewall.token_usage', 'usage.report', 'firewall.steering',
  'firewall.event', 'firewall.upstream_error', 'workflow.info', 'workflow.job_result',
  'model.config', 'model.inventory', 'model.baseline_estimate', 'model.resolution',
  'model_routing.outcome', 'model_endpoint.mismatch', 'session.collection',
  'session.collection_warning', 'session.format', 'subagent.request', 'subagent.started', 'subagent.configured',
  'subagent.completed', 'subagent.failed', 'subagent.model_unavailable'
]);

/**
 * Keep source facts, not view metrics. All joins, attribution, state precedence,
 * coverage and aggregates are declared in Dashboard Language.
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @returns {{ key?: string, fields: Record<string, unknown> }[] | null}
 */
export function routingMetadata(type, data) {
  if (!TYPES.has(type)) return null;
  const routing = type === 'workflow.info' ? object(field(data, 'modelRouting')) : data;
  const objective = object(routing.objective);
  const labels = object(routing.labels);
  const router = object(routing.router);
  const usage = object(data.usage);
  const config = object(data.routing);
  const selection = object(field(data, 'modelSelection'));
  const steering = object(data.steering);
  /** @type {Record<string, unknown>} */
  const fields = {
    routingStage: identifier(routing.stage),
    routingSchema: identifier(routing.schema ?? routing._schema),
    routingStatus: type === 'workflow.info' ? identifier(routing.status) : undefined,
    routingGoal: identifier(objective.goal ?? config.goal),
    routingConfiguredMode: identifier(objective.mode ?? config.mode),
    routingMode: identifier(routing.mode),
    routingSelectedModel: model(field(routing, 'selectedModel') ?? field(routing, 'wireModel')
      ?? (type === 'workflow.info' ? routing.model : undefined)),
    routingSelectedEffort: identifier(field(routing, 'selectedEffort')
      ?? (type === 'workflow.info' ? routing.effort : undefined)),
    routingRequestedModel: model(field(data, 'requestedModel')),
    routingRequestedEffort: identifier(field(data, 'requestedEffort')),
    routingAppliedEffort: identifier(field(routing, 'appliedEffort')),
    routingTaskType: identifier(field(labels, 'taskType')),
    routingScope: identifier(labels.scope),
    routingComplexity: identifier(field(labels, 'taskComplexity')),
    routingPurpose: identifier(data.purpose),
    routingAgentName: identifier(field(data, 'agentName') ?? field(data, 'agentDisplayName')),
    routingAgentId: identifier(field(data, 'agentId')),
    routingRouted: identifier(data.routed),
    routingOutcome: identifier(data.outcome),
    routingRouterVersion: identifier(router.version ?? field(routing, 'routerVersion')),
    routingAwfVersion: identifier(field(data, 'awfVersion')),
    routingClassifierModel: model(field(data, 'classifierModel')),
    routingClassifierEffort: identifier(field(data, 'classifierEffort')),
    routingClassifierAttempts: numeric(field(data, 'classifierAttempts')),
    routingLatencyMs: numeric(field(data, 'latencyMs')),
    routingDegraded: typeof field(data, 'degradedClassification') === 'boolean'
      ? field(data, 'degradedClassification') : undefined,
    routingDegradedReason: identifier(field(data, 'degradedReason')),
    routingEnabled: typeof config.enabled === 'boolean' ? config.enabled : undefined,
    routingSubstitution: identifier(selection.status),
    routingEffectiveModel: model(field(selection, 'effectiveModel')),
    routingSteeringType: identifier(steering.type ?? data.steeringType),
    routingSteeringThreshold: numeric(steering.threshold),
    routingMaxCredits: numeric(field(data, 'maxAiCredits')),
    evidenceState: data.legacyEndpointNormalization === true ? 'legacy-endpoint-normalization' : undefined,
    required: type === 'workflow.info' ? Boolean(identifier(data.repository)
      && /^\d+$/.test(String(field(data, 'runId')))) : undefined,
    model: model(data.model ?? field(data, 'wireModel')),
    effort: identifier(data.effort ?? field(data, 'reasoningEffort')),
    provider: identifier(data.provider),
    correlationId: identifier(field(data, 'requestId')),
    code: identifier(data.code ?? field(data, 'errorCode') ?? field(data, 'failureCode')),
    name: identifier(field(data, 'jobId') ?? data.event),
    status: type === 'session.format' ? (data.version === 1 ? 'supported' : 'unsupported')
      : identifier(typeof data.status === 'number' && Number.isFinite(data.status)
        ? String(data.status) : data.status ?? data.result),
    durationMs: numeric(field(data, 'durationMs')),
    httpStatus: numeric(field(data, 'httpStatus') ?? (typeof data.status === 'number' ? data.status : undefined)),
    threshold: numeric(data.threshold),
    aic: numeric(data.aic ?? data.ai_credits_this_response),
    totalAic: numeric(field(data, 'totalAic')),
    requestAttempt: numeric(data.attempt),
    sourceEngine: identifier(field(data, 'engineId')),
    inputTokens: numeric(field(usage, 'inputTokens')),
    outputTokens: numeric(field(usage, 'outputTokens')),
    cacheReadTokens: numeric(field(usage, 'cacheReadInputTokens') ?? field(usage, 'cacheReadTokens')),
    cacheWriteTokens: numeric(field(usage, 'cacheCreationInputTokens') ?? field(usage, 'cacheWriteTokens')),
    reasoningTokens: numeric(field(usage, 'reasoningOutputTokens'))
  };
  if (Array.isArray(data.deviations)) {
    fields.routingDeviations = data.deviations.map(identifier).filter(Boolean).join('/');
  }
  /** @param {Record<string, unknown>} value */
  const clean = (value) => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  if (type === 'session.collection') {
    return [
      { key: 'summary', fields: clean({ status: 'collection-summary',
        errorsCount: numeric(data.warnings), totalEvents: numeric(field(data, 'untimedEvents')) }) },
      ...(Array.isArray(data.sources) ? data.sources : []).map((candidate, index) => {
        const source = object(candidate);
        return { key: `source:${index}`, fields: clean({
          name: typeof source.path === 'string' && /\.(?:jsonl|json)$/.test(source.path)
            ? identifier(source.path.split('/').at(-1)) : undefined,
          component: identifier(source.component),
          phase: identifier(source.phase), totalEvents: numeric(source.events), status: 'collected'
        }) };
      }),
      ...(Array.isArray(field(data, 'absentComponents')) ? /** @type {unknown[]} */ (field(data, 'absentComponents')) : [])
        .map((component, index) => ({ key: `absent:${index}`, fields: clean({ component: identifier(component), status: 'absent' }) }))
    ];
  }
  if (type === 'model.inventory') {
    return (Array.isArray(data.endpoints) ? data.endpoints : []).flatMap((candidate, index) => {
      const endpoint = object(candidate);
      const common = { provider: identifier(endpoint.provider),
        routingInventoryComplete: typeof field(data, 'modelsFetchComplete') === 'boolean'
          ? field(data, 'modelsFetchComplete') : undefined };
      return [
        { key: `endpoint:${index}`, fields: clean({ ...common, status: 'inventory-endpoint',
          totalEvents: Array.isArray(endpoint.models) ? endpoint.models.length : undefined }) },
        ...(Array.isArray(endpoint.models) ? endpoint.models : []).map((entry, offset) => ({
          key: `${index}:${offset}`, fields: clean({ ...common, model: model(entry), status: 'available' })
        }))
      ];
    });
  }
  return [{ fields: clean(fields) }];
}

/**
 * AWF before v0.28.39 counted an endpoint-only change as a deviation.
 * @param {{ record: Record<string, unknown>, line: number }[]} records
 */
export function normalizeLegacyRouting(records) {
  const selection = records.filter(({ record }) => record.type === 'firewall.model_routing'
    && object(record.provenance).phase === 'agent' && object(record.data).stage === 'selection')
    .sort((left, right) => {
      /** @param {Record<string, unknown>} record */
      const clock = (record) => {
        const value = object(record.provenance).timestampMs ?? record.timestamp;
        const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(timestamp) ? timestamp : -Infinity;
      };
      return (clock(left.record) - clock(right.record)) || left.line - right.line;
    }).at(-1);
  const data = object(selection?.record.data);
  const version = String(data.schema ?? data._schema).match(/^model-routing\/v(\d+)\.(\d+)\.(\d+)$/);
  if (!version) {
    debugModelRouting({ event: 'legacy-normalization', status: 'skipped', reason: 'no-versioned-selection', records: records.length });
    return records;
  }
  if (Number(version[1]) !== 0
      || Number(version[2]) > 28 || (Number(version[2]) === 28 && Number(version[3]) >= 39)) {
    debugModelRouting({ event: 'legacy-normalization', status: 'skipped', reason: 'current-schema', records: records.length });
    return records;
  }
  debugModelRouting({ event: 'legacy-normalization', status: 'applied', records: records.length,
    schemaMinor: Number(version[2]), schemaPatch: Number(version[3]) });
  return records.map((entry) => {
    const data = object(entry.record.data);
    return entry.record.type === 'firewall.model_routing' && data.stage === 'request'
      && data.routed === 'deviated' && Array.isArray(data.deviations)
      && data.deviations.length === 1 && data.deviations[0] === 'endpoint'
      ? { ...entry, record: { ...entry.record, data: { ...data, routed: 'as_selected', legacyEndpointNormalization: true } } }
      : entry;
  });
}
