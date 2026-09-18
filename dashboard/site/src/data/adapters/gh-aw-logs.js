import {
  repositoryCoordinateId,
  runId,
  sourceId,
  workflowCoordinateId,
  workflowSourcePath
} from '../model/ids.js';
import { canonicalTimestamp, requiredString } from '../model/schema.js';
import cachedJsonlExpression from '../ingest/expressions/gh-aw-logs-v2.json' with { type: 'json' };
import { createDebug } from '../../debug.js';

const debug = createDebug('data:ingestion:jsonl');

const OBSERVATION_SOURCE = 'gh-aw-logs';
const REPOSITORY_COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** @param {unknown} value @param {string} field */
function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} field */
function identifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(`${field} is required`);
  }
  return String(value).trim();
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${field} must be a positive integer`);
  return number;
}

/** @param {unknown} value */
function optionalString(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

/** @param {Record<string, unknown>} record */
function safeOutputGithubEntityType(record) {
  if (optionalString(record.provider)?.toLowerCase() !== 'github' && record.provider !== undefined) {
    return undefined;
  }
  const target = record.target && typeof record.target === 'object' && !Array.isArray(record.target)
    ? /** @type {Record<string, unknown>} */ (record.target)
    : {};
  const explicitKind = optionalString(target.kind);
  if (explicitKind) return explicitKind.toLowerCase().replaceAll('-', '_');

  const url = optionalString(record.url);
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.toLowerCase() === 'github.com') {
        if (/\/pull\/\d+(?:\/|$)/.test(parsed.pathname)) return 'pull_request';
        if (/\/issues\/\d+(?:\/|$)/.test(parsed.pathname)) return 'issue';
        if (/\/discussions\/\d+(?:\/|$)/.test(parsed.pathname)) return 'discussion';
        if (/\/projects\/\d+(?:\/|$)/.test(parsed.pathname)) return 'project';
      }
    } catch {
      // Fall through to the safe-output action.
    }
  }

  const action = optionalString(record.type)?.toLowerCase();
  if (!action) return undefined;
  if (action.includes('pull_request_review_comment')) return 'pull_request_review_comment';
  if (action.includes('pull_request_review')) return 'pull_request_review';
  if (action.includes('pull_request')) return 'pull_request';
  if (action.includes('discussion')) return 'discussion';
  if (action.includes('project_status_update')) return 'project_status_update';
  if (action.includes('project')) return 'project';
  if (action.includes('code_scanning_alert')) return 'code_scanning_alert';
  if (action.includes('issue')) return 'issue';
  return undefined;
}

/** @param {unknown} title @param {unknown} event */
function dispatchTargetRepository(title, event) {
  if (event !== 'workflow_dispatch' || typeof title !== 'string') return undefined;
  const parts = title.split('·').map((part) => part.trim());
  if (parts.length !== 3 || !['review', 'live'].includes(parts[2])) return undefined;
  return REPOSITORY_COORDINATE_PATTERN.test(parts[1]) ? parts[1] : undefined;
}

/** @param {...unknown} values */
function firstOptionalString(...values) {
  return values.map(optionalString).find((value) => value !== undefined);
}

/** @param {string} fallback @param {...unknown} values */
function normalizedId(fallback, ...values) {
  return values
    .map(optionalString)
    .find((value) => value?.trim())
    ?.trim() ?? fallback;
}

/** @param {Record<string, unknown>} value */
function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** @param {unknown} value */
function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value @param {string} field @param {string[]} allowed */
function enumValue(value, field, allowed) {
  const normalized = requiredString(value, field);
  if (!allowed.includes(normalized)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} field */
function optionalTimestamp(value, field) {
  return value === undefined || value === null
    ? undefined
    : canonicalTimestamp(value, field);
}

/** @param {unknown} value @param {string} field */
function optionalIdentifierArray(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => identifier(item, `${field}[${index}]`));
}

/** @param {Record<string, unknown>} run */
function runMetadata(run) {
  const awInfo = run.aw_info && typeof run.aw_info === 'object' && !Array.isArray(run.aw_info)
    ? /** @type {Record<string, unknown>} */ (run.aw_info)
    : {};
  const tokenUsage = run.token_usage_summary ?? run.token_usage ?? null;
  const summary = tokenUsage && typeof tokenUsage === 'object' && !Array.isArray(tokenUsage)
    ? /** @type {Record<string, unknown>} */ (tokenUsage)
    : {};
  const byModel = summary.by_model && typeof summary.by_model === 'object' && !Array.isArray(summary.by_model)
    ? /** @type {Record<string, unknown>} */ (summary.by_model)
    : {};
  const dominantModel = Object.entries(byModel)
    .map(([model, usage]) => {
      const record = usage && typeof usage === 'object' && !Array.isArray(usage)
        ? /** @type {Record<string, unknown>} */ (usage)
        : {};
      return { model, aic: finiteNumber(record.aic) ?? 0 };
    })
    .sort((left, right) => right.aic - left.aic || left.model.localeCompare(right.model))[0]?.model;
  const aicTotal = finiteNumber(summary.total_aic) ?? finiteNumber(run.aic);
  return {
    agentId: normalizedId('copilot', run.agent_id, run.agent, run.engine_id, awInfo.engine_id),
    agentVersion: firstOptionalString(
      run.agent_version,
      run.engine_version,
      awInfo.agent_version,
      awInfo.version
    ),
    modelId: normalizedId('auto', run.model_id, run.resolved_model, run.model, awInfo.model, dominantModel),
    ghAwVersion: firstOptionalString(
      run.gh_aw_version,
      run.ghAwVersion,
      run.cli_version,
      run.version,
      awInfo.cli_version
    ),
    engine: firstOptionalString(run.engine, awInfo.engine_name),
    engineId: firstOptionalString(run.engine_id, awInfo.engine_id),
    engineVersion: firstOptionalString(
      run.engine_version,
      awInfo.agent_version,
      awInfo.version
    ),
    requestedModel: firstOptionalString(run.requested_model, run.requestedModel, run.model, awInfo.model),
    resolvedModel: firstOptionalString(
      run.resolved_model,
      run.resolvedModel,
      run.model_resolved,
      run.model,
      awInfo.model,
      dominantModel
    ),
    agentRuntime: firstOptionalString(run.agent_runtime, awInfo.agent_runtime),
    firewallVersion: firstOptionalString(run.firewall_version, awInfo.firewall_version, awInfo.awf_version),
    gatewayVersion: firstOptionalString(run.gateway_version, awInfo.awmg_version),
    aicTotal,
    tokenUsage
  };
}

/** @param {Record<string, unknown>} run */
function runAggregates(run) {
  const audit = run.audit && typeof run.audit === 'object' && !Array.isArray(run.audit)
    ? /** @type {Record<string, unknown>} */ (run.audit)
    : {};
  const firewallValue = Object.hasOwn(run, 'firewall_analysis')
    ? run.firewall_analysis
    : audit.firewall_analysis;
  const firewall = firewallValue && typeof firewallValue === 'object' && !Array.isArray(firewallValue)
    ? /** @type {Record<string, unknown>} */ (firewallValue)
    : {};
  const requestsByDomain = firewall.requests_by_domain
    && typeof firewall.requests_by_domain === 'object'
    && !Array.isArray(firewall.requests_by_domain)
    ? /** @type {Record<string, unknown>} */ (firewall.requests_by_domain)
    : {};
  const hasFirewallAggregate = firewallValue !== null && typeof firewallValue === 'object'
    && !Array.isArray(firewallValue);
  let firewallAllowedCalls = 0;
  let firewallBlockedCalls = 0;
  for (const value of Object.values(requestsByDomain)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const counts = /** @type {Record<string, unknown>} */ (value);
    firewallAllowedCalls += Math.max(0, finiteNumber(counts.allowed) ?? 0);
    firewallBlockedCalls += Math.max(0, finiteNumber(counts.blocked) ?? 0);
  }

  const mcpValue = Object.hasOwn(run, 'mcp_tool_usage')
    ? run.mcp_tool_usage
    : audit.mcp_tool_usage;
  const mcp = mcpValue && typeof mcpValue === 'object' && !Array.isArray(mcpValue)
    ? /** @type {Record<string, unknown>} */ (mcpValue)
    : {};
  const toolCalls = Array.isArray(mcp.tool_calls) ? mcp.tool_calls : [];
  const hasMcpAggregate = mcpValue !== null && typeof mcpValue === 'object'
    && !Array.isArray(mcpValue);
  const mcpResponseBytes = toolCalls.reduce((total, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return total;
    return total + Math.max(0, finiteNumber(/** @type {Record<string, unknown>} */ (value).output_size) ?? 0);
  }, 0);

  const graders = run.graders && typeof run.graders === 'object' && !Array.isArray(run.graders)
    ? /** @type {Record<string, unknown>} */ (run.graders)
    : {};
  const operationalValueResults = (Array.isArray(graders.results) ? graders.results : [])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
    .map((value) => /** @type {Record<string, unknown>} */ (value))
    .filter((value) => value.id === 'operational-value' || value.source === 'operational-value')
    .map((value) => {
      const primaryMetric = Array.isArray(value.metrics) ? value.metrics[0] : undefined;
      return finiteNumber(primaryMetric && typeof primaryMetric === 'object' ? primaryMetric.value : value.value);
    })
    .filter((value) => value !== null);

  const auditItems = ['key_findings', 'observability_insights', 'recommendations']
    .flatMap((field) => Array.isArray(audit[field]) ? audit[field] : [])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
    .map((value) => /** @type {Record<string, unknown>} */ (value));
  const hasPriorityAggregate = ['key_findings', 'observability_insights', 'recommendations']
    .some((field) => Array.isArray(audit[field]));
  /** @param {string} priority */
  const priorityCount = (priority) => auditItems.filter((item) =>
    optionalString(item.severity ?? item.priority)?.toLowerCase() === priority).length;
  const startedAt = timestamp(run.started_at ?? run.created_at);
  const completedAt = run.status === 'completed' ? timestamp(run.completed_at ?? run.updated_at) : null;

  return {
    agenticDurationSeconds: startedAt && completedAt
      ? Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
      : null,
    firewallAllowedCalls: hasFirewallAggregate ? firewallAllowedCalls : null,
    firewallBlockedCalls: hasFirewallAggregate ? firewallBlockedCalls : null,
    mcpToolCalls: hasMcpAggregate ? toolCalls.length : null,
    mcpResponseBytes: hasMcpAggregate ? mcpResponseBytes : null,
    operationalValue: operationalValueResults.length === 1 ? operationalValueResults[0] : null,
    highPriorityAuditItems: hasPriorityAggregate ? priorityCount('high') : null,
    mediumPriorityAuditItems: hasPriorityAggregate ? priorityCount('medium') : null
  };
}

/** @param {string} content @param {string} filePath */
function parseJsonl(content, filePath) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new TypeError(`${filePath}:${index + 1} must contain valid JSON`, { cause: error });
    }
    return [{ value: objectValue(value, `${filePath}:${index + 1}`), line: index + 1 }];
  });
}

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** @param {unknown} value */
function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

/** @param {unknown} value */
function firewallDomain(value) {
  const host = text(value).trim();
  if (!host || host === '-') return '';
  try {
    return new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return host.replace(/:\d+$/, '');
  }
}

/** @param {string[]} parts */
function detail(parts) {
  return parts.filter(Boolean).join('/');
}

/** @param {unknown} value */
function stableDigest(value) {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} fields
 * @returns {'domain' | 'tool' | 'audit' | 'issue'}
 */
function recordKind(type, fields) {
  if (fields.source === 'firewall' || type === 'net_allowed' || type === 'net_blocked') return 'domain';
  if (type === 'safe_output.created'
    && ['issue', 'pull_request'].includes(String(fields.githubEntityType))) return 'issue';
  if (fields.source === 'mcp'
    || type === 'tool_call'
    || type === 'agent_tool_start'
    || type === 'agent_tool_done'
    || type === 'guard_blocked'
    || type === 'difc_filtered'
    || type === 'audit.skill_activation') return 'tool';
  return 'audit';
}

/** @param {string} type @param {Record<string, unknown>} fields @param {'domain' | 'tool' | 'audit' | 'issue'} kind */
function specializedFields(type, fields, kind) {
  if (kind === 'issue') {
    return {
      isPullRequest: fields.githubEntityType === 'pull_request',
      url: fields.correlationId
    };
  }
  if (kind === 'tool') {
    const name = optionalString(fields.mcpTool ?? fields.toolName ?? fields.summary) ?? 'unknown';
    const isSkill = type === 'audit.skill_activation';
    const isBash = /(^|[/.:_-])(bash|shell)(?:$|[/.:_-])/i.test(name);
    return {
      toolType: isSkill ? 'skill' : isBash ? 'bash' : 'mcp',
      isSkill,
      name
    };
  }
  return {};
}

/** @param {string} repositoryName @param {string} [fallbackOwner] */
function repositoryCoordinates(repositoryName, fallbackOwner = '') {
  const parts = repositoryName.split('/').filter(Boolean);
  const owner = parts.length === 2 ? parts[0] : fallbackOwner;
  const name = parts.length === 2 ? parts[1] : repositoryName;
  if (!owner || !name) throw new TypeError(`Repository must use OWNER/REPOSITORY form: ${repositoryName}`);
  return { owner, name, fullName: `${owner}/${name}` };
}

/**
 * @template {{ line: number, observedAt: string, value: Record<string, unknown> }} T
 * @param {T} left
 * @param {T} right
 * @returns {T}
 */
function preferNewer(left, right) {
  const rightIsNewer = Date.parse(right.observedAt) > Date.parse(left.observedAt)
    || (right.observedAt === left.observedAt && right.line > left.line);
  if (!rightIsNewer) return left;
  return {
    ...right,
    value: { ...left.value, ...right.value }
  };
}

/** @param {unknown} input */
function logFiles(input) {
  if (!Array.isArray(input)) throw new TypeError('gh-aw logs files must be an array');
  return input.map((candidate, index) => {
    const file = objectValue(candidate, `gh-aw logs file ${index}`);
    const content = file.content;
    if (typeof content !== 'string') throw new TypeError(`gh-aw logs file ${index}.content must be a string`);
    return {
      path: requiredString(file.path, `gh-aw logs file ${index}.path`).replaceAll('\\', '/'),
      content
    };
  });
}

/**
 * @param {string} runId
 * @param {string} filePath
 * @param {number} line
 * @param {string} eventTimestamp
 * @param {string} eventSource
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 */
function eventObservation(runId, filePath, line, eventTimestamp, eventSource, type, fields = {}) {
  const recordFields = { source: eventSource, ...fields };
  const kind = recordKind(type, recordFields);
  return {
    kind,
    source: OBSERVATION_SOURCE,
    sourceId: `${runId}:${filePath}:${line}`,
    observedAt: eventTimestamp,
    data: {
      runId,
      timestamp: eventTimestamp,
      source: eventSource,
      type,
      payloadRef: `${filePath}#L${line}`,
      sourceSequence: line,
      ...fields,
      ...specializedFields(type, recordFields, kind)
    }
  };
}

/** @param {string} runId @param {{ path: string, content: string }} file */
function agentEvents(runId, file) {
  let turn = 0;
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.timestamp);
    if (!eventTimestamp) return [];
    const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? /** @type {Record<string, unknown>} */ (value.data)
      : {};
    switch (value.type) {
      case 'user.message':
        turn += 1;
        return [eventObservation(runId, file.path, line, eventTimestamp, 'agent', 'agent_turn', {
          summary: `turn ${turn}`
        })];
      case 'assistant.message':
        return [eventObservation(runId, file.path, line, eventTimestamp, 'agent', 'assistant_message')];
      case 'reasoning':
      case 'assistant.reasoning':
        return [eventObservation(runId, file.path, line, eventTimestamp, 'agent', 'reasoning')];
      case 'tool.execution_start':
        return [eventObservation(runId, file.path, line, eventTimestamp, 'agent', 'agent_tool_start', {
          summary: detail([text(data.mcpServerName), text(data.toolName)]),
          correlationId: optionalString(data.toolCallId)
        })];
      case 'tool.execution_complete':
        return [eventObservation(runId, file.path, line, eventTimestamp, 'agent', 'agent_tool_done', {
          summary: detail([text(data.mcpServerName), text(data.toolName)]),
          status: data.success === true ? 'success' : 'error',
          correlationId: optionalString(data.toolCallId)
        })];
      default:
        return [];
    }
  });
}

/** @param {string} runId @param {{ path: string, content: string }} file @param {boolean} rpc */
function gatewayEvents(runId, file, rpc) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.timestamp);
    if (!eventTimestamp) return [];
    if (rpc) {
      if (value.type === 'DIFC_FILTERED') {
        return [eventObservation(runId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
          summary: detail([text(value.server_id), text(value.tool_name)]),
          status: optionalString(value.reason)
        })];
      }
      if (value.type === 'REQUEST' && value.direction === 'OUT') {
        return [eventObservation(runId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
          summary: optionalString(value.method)
        })];
      }
      return [];
    }
    if (value.type === 'DIFC_FILTERED') {
      return [eventObservation(runId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
        summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
        status: optionalString(value.reason)
      })];
    }
    if (value.type === 'GUARD_POLICY_BLOCKED') {
      return [eventObservation(runId, file.path, line, eventTimestamp, 'gateway', 'guard_blocked', {
        summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
        status: optionalString(value.reason)
      })];
    }
    if (value.event === 'tool_call') {
      return [eventObservation(runId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
        summary: detail([text(value.server_name), text(value.tool_name)]),
        status: value.error ? 'error' : optionalString(value.status),
        correlationId: optionalString(value.tool_call_id)
      })];
    }
    return [];
  });
}

/** @param {string} runId @param {{ path: string, content: string }} file */
function firewallEvents(runId, file) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.ts);
    const host = text(value.host ?? value.domain);
    const domain = firewallDomain(host);
    if (!eventTimestamp || !domain || value.url === 'error:transaction-end-before-headers') return [];
    const decision = text(value.decision ?? value.squid_request_status);
    const status = Number(value.status ?? value.http_status);
    const blocked = /denied|blocked|reject/i.test(decision)
      || (Number.isFinite(status) && status >= 400 && status < 600);
    return [eventObservation(runId, file.path, line, eventTimestamp, 'firewall', blocked ? 'net_blocked' : 'net_allowed', {
      summary: [host, text(value.method)].filter(Boolean).join(' '),
      status: Number.isFinite(status) && status > 0 ? String(status) : blocked ? 'blocked' : 'allowed',
      domain,
      decision: blocked ? 'denied' : 'allowed',
      requestCount: 1
    })];
  });
}

/**
 * Converts gh-aw's raw agent, gateway, and firewall JSONL files into its
 * unified timeline vocabulary for one canonical Run.
 *
 * @param {unknown} input
 * @param {string} runId
 * @returns {import('../model/schema.js').CanonicalObservation[]}
 */
export function adaptGhAwTimelineFiles(input, runId) {
  const canonicalRunId = requiredString(runId, 'gh-aw logs runId');
  const files = logFiles(input);
  const gateway = files.find((file) => /(^|\/)gateway\.jsonl$/.test(file.path));
  const rpc = gateway ? undefined : files.find((file) => /(^|\/)rpc-messages\.jsonl$/.test(file.path));
  return [
    ...(gateway ? gatewayEvents(canonicalRunId, gateway, false) : rpc ? gatewayEvents(canonicalRunId, rpc, true) : []),
    ...files.filter((file) => /firewall.*\/audit\.jsonl$/.test(file.path)).flatMap((file) => firewallEvents(canonicalRunId, file)),
    ...files.filter((file) => /copilot-session-state\/[^/]+\/events\.jsonl$/.test(file.path)).flatMap((file) => agentEvents(canonicalRunId, file))
  ];
}

/**
 * Converts raw gh-aw run artifact files into a complete canonical observation
 * graph. The input carries GitHub identity context; Event data remains sourced
 * from gh-aw's agent, gateway, and firewall JSONL files.
 *
 * @param {unknown} input
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptGhAwLogs(input) {
  const document = objectValue(input, 'gh-aw logs input');
  const observedAt = canonicalTimestamp(document.observedAt, 'gh-aw logs observedAt');
  const repository = objectValue(document.repository, 'gh-aw logs repository');
  const workflow = objectValue(document.workflow, 'gh-aw logs workflow');
  const run = objectValue(document.run, 'gh-aw logs run');

  const repositoryGithubId = identifier(repository.githubId, 'repository.githubId');
  const repositoryOwner = requiredString(repository.owner, 'repository.owner');
  const repositoryName = requiredString(repository.name, 'repository.name');
  const canonicalRepositoryId = repositoryCoordinateId(repositoryOwner, repositoryName);
  const workflowGithubId = identifier(workflow.githubId, 'workflow.githubId');
  const workflowPath = requiredString(workflow.path, 'workflow.path');
  const canonicalWorkflowId = workflowCoordinateId(repositoryOwner, repositoryName, workflowPath);
  const githubRunId = identifier(run.githubRunId, 'run.githubRunId');
  const attempt = positiveInteger(run.attempt, 'run.attempt');
  const canonicalRunId = runId(githubRunId, attempt);
  const events = adaptGhAwTimelineFiles(document.files, canonicalRunId);

  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [
    {
      kind: 'repository', source: OBSERVATION_SOURCE, sourceId: `repository:${repositoryGithubId}`, observedAt,
      data: {
        id: canonicalRepositoryId,
        githubId: repositoryGithubId,
        owner: repositoryOwner,
        name: repositoryName,
        fullName: `${repositoryOwner}/${repositoryName}`,
        visibility: optionalString(repository.visibility) ?? 'unknown'
      }

    },
    {
      kind: 'workflow', source: OBSERVATION_SOURCE, sourceId: `workflow:${workflowGithubId}`, observedAt,
      data: {
        id: canonicalWorkflowId,
        githubId: workflowGithubId,
        repositoryId: canonicalRepositoryId,
        name: requiredString(workflow.name, 'workflow.name'),
        path: workflowSourcePath(workflowPath),
        state: optionalString(workflow.state) ?? 'unknown'
      }
    },
    {
      kind: 'run', source: OBSERVATION_SOURCE, sourceId: `run:${githubRunId}:${attempt}`, observedAt,
      data: {
        githubRunId,
        attempt,
        repositoryId: canonicalRepositoryId,
        workflowId: canonicalWorkflowId,
        event: optionalString(run.event) ?? 'unknown',
        status: optionalString(run.status) ?? 'unknown',
        conclusion: optionalString(run.conclusion) ?? null,
        createdAt: optionalString(run.createdAt) ?? null,
        startedAt: optionalString(run.startedAt) ?? null,
        completedAt: optionalString(run.completedAt) ?? null
      }
    }
  ];
  observations.push(...events);
  return { observations };
}

/**
 * @param {string | Uint8Array} content
 * @param {{ context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} [options]
 * @returns {{
 *   observations: import('../model/schema.js').CanonicalObservation[],
 *   records: number,
 *   rawPayloadRecords: number,
 *   rawRuns: number,
 *   agenticRunRecords: number,
 *   agenticRuns: number,
 *   duplicateRawRunObservations: number,
 *   duplicateAgenticRunObservations: number,
 *   unenrichedRuns: number,
 *   recordsByKind: Record<string, number>,
 *   safeOutputItems: number,
 *   mappedSafeOutputItems: number,
 *   rateLimits: number,
 *   mappedRateLimits: number
 * }}
 */
export function adaptCachedGhAwJsonl(content, options = {}) {
  const binaryContent = typeof content !== 'string'
    && ArrayBuffer.isView(content)
    && content.BYTES_PER_ELEMENT === 1;
  if (typeof content !== 'string' && !binaryContent) {
    throw new TypeError('gh-aw JSONL must be a string or Uint8Array');
  }
  if (cachedJsonlExpression.contract !== 'gh-aw-cao.jsonl-ingestion'
    || cachedJsonlExpression.version !== 1) {
    throw new TypeError('Unsupported cached gh-aw ingestion expression');
  }
  const sourceSchemaVersion = cachedJsonlExpression.sourceSchemaVersion;
  const knownKinds = new Set(Object.keys(cachedJsonlExpression.variants));
  const decoder = new TextDecoder();
  /** @param {string} line @param {number} lineNumber */
  const parseEnvelope = (line, lineNumber) => {
    let envelope;
    try { envelope = objectValue(JSON.parse(line), `gh-aw JSONL line ${lineNumber}`); } catch (error) {
      throw new TypeError(`gh-aw JSONL line ${lineNumber} must contain valid JSON`, { cause: error });
    }
    if (envelope.schema_version !== sourceSchemaVersion) {
      throw new TypeError(
        `Unsupported gh-aw JSONL schema version at line ${lineNumber}: ${String(envelope.schema_version)}`
      );
    }
    const kind = requiredString(envelope.kind, `gh-aw JSONL line ${lineNumber}.kind`);
    return knownKinds.has(kind) ? { envelope, line: lineNumber } : null;
  };
  function* envelopes() {
    let start = 0;
    let lineNumber = 0;
    while (start <= content.length) {
      lineNumber += 1;
      const end = typeof content === 'string'
        ? content.indexOf('\n', start)
        : content.indexOf(10, start);
      const boundary = end === -1 ? content.length : end;
      const line = typeof content === 'string'
        ? content.slice(start, boundary)
        : decoder.decode(content.subarray(start, boundary));
      if (line.trim()) {
        const parsed = parseEnvelope(line, lineNumber);
        if (parsed) yield parsed;
      }
      if (end === -1) break;
      start = end + 1;
    }
  }
  const accumulator = createCachedGhAwJsonlAccumulator(options);
  for (const envelope of envelopes()) accumulator.accept(envelope);
  return accumulator.finish();
}

export function createCachedJsonlPayloadHasher() {
  const hashes = Array.from({ length: 8 }, (_, index) => (0x811c9dc5 ^ (index * 0x9e3779b9)) >>> 0);
  return {
    /** @param {Uint8Array} bytes */
    update(bytes) {
      for (const byte of bytes) {
        for (let index = 0; index < hashes.length; index += 1) {
          hashes[index] = Math.imul(hashes[index] ^ byte, 0x01000193 + (index * 2)) >>> 0;
        }
      }
    },
    digest() {
      return hashes.map((hash) => hash.toString(16).padStart(8, '0')).join('');
    }
  };
}

/** @param {string | Uint8Array} content */
export function cachedJsonlPayloadIdentity(content) {
  const hasher = createCachedJsonlPayloadHasher();
  hasher.update(typeof content === 'string' ? new TextEncoder().encode(content) : content);
  return hasher.digest();
}

/**
 * @param {AsyncIterable<string | Uint8Array>} chunks
 * @param {{ context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[], onProgress?: (progress: { bytesProcessed: number, linesProcessed: number, recordsIngested: number }) => void, payloadIdentity?: string }} [options]
 */
export async function adaptCachedGhAwJsonlStream(chunks, options = {}) {
  if (cachedJsonlExpression.contract !== 'gh-aw-cao.jsonl-ingestion'
    || cachedJsonlExpression.version !== 1) {
    throw new TypeError('Unsupported cached gh-aw ingestion expression');
  }
  const sourceSchemaVersion = cachedJsonlExpression.sourceSchemaVersion;
  const knownKinds = new Set(Object.keys(cachedJsonlExpression.variants));
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const hasher = options.payloadIdentity === undefined ? createCachedJsonlPayloadHasher() : null;
  const accumulator = createCachedGhAwJsonlAccumulator(options);
  let pending = '';
  let lineNumber = 0;
  let bytesProcessed = 0;
  let recordsIngested = 0;
  let chunksProcessed = 0;
  debug('started streaming JSONL adaptation', { workflowHints: options.workflowHints?.length ?? 0 });
  /** @param {string} line */
  const accept = (line) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let envelope;
    try { envelope = objectValue(JSON.parse(line), `gh-aw JSONL line ${lineNumber}`); } catch (error) {
      throw new TypeError(`gh-aw JSONL line ${lineNumber} must contain valid JSON`, { cause: error });
    }
    if (envelope.schema_version !== sourceSchemaVersion) {
      throw new TypeError(
        `Unsupported gh-aw JSONL schema version at line ${lineNumber}: ${String(envelope.schema_version)}`
      );
    }
    const kind = requiredString(envelope.kind, `gh-aw JSONL line ${lineNumber}.kind`);
    if (knownKinds.has(kind)) {
      accumulator.accept({ envelope, line: lineNumber });
      recordsIngested += 1;
    }
  };
  for await (const chunk of chunks) {
    chunksProcessed += 1;
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    bytesProcessed += bytes.byteLength;
    hasher?.update(bytes);
    pending += decoder.decode(bytes, { stream: true });
    let start = 0;
    let newline;
    while ((newline = pending.indexOf('\n', start)) !== -1) {
      accept(pending.slice(start, newline));
      start = newline + 1;
    }
    if (start > 0) pending = pending.slice(start);
    debug('adapted JSONL chunk', {
      chunksProcessed,
      chunkBytes: bytes.byteLength,
      bytesProcessed,
      linesProcessed: lineNumber,
      recordsIngested,
      pendingCharacters: pending.length
    });
    options.onProgress?.({ bytesProcessed, linesProcessed: lineNumber, recordsIngested });
  }
  pending += decoder.decode();
  if (pending) accept(pending);
  options.onProgress?.({ bytesProcessed, linesProcessed: lineNumber, recordsIngested });
  const result = {
    ...accumulator.finish(),
    payloadIdentity: options.payloadIdentity ?? hasher?.digest()
  };
  debug('completed streaming JSONL adaptation', {
    chunksProcessed,
    bytesProcessed,
    linesProcessed: lineNumber,
    recordsIngested
  });
  return result;
}

/**
 * @param {{ context?: unknown, workflowHints?: { owner: string, repository: string, name: string, path: string }[] }} options
 */
function createCachedGhAwJsonlAccumulator(options) {

  /**
   * @typedef {{
   *   line: number,
   *   observedAt: string,
   *   value: Record<string, unknown>,
   *   owner: string,
   *   name: string,
   *   fullName: string,
   *   workflowName: string,
   *   workflowPath?: string
   * }} CachedRun
   */

  /** @type {Map<string, CachedRun>} */
  const enrichedRuns = new Map();
  /** @type {{ envelope: Record<string, unknown>, line: number }[]} */
  const rateLimitEnvelopes = [];
  /** @type {Map<string, { value: Record<string, unknown>, line: number }[]>} */
  const safeOutputItemsByRun = new Map();
  /** @type {Map<string, Record<string, unknown>[]>} */
  const tokenEfficiencyObservationsByRun = new Map();
  /** @type {Map<string, Record<string, unknown>[]>} */
  const tokenEfficiencyLifecycleObservationsByRun = new Map();
  /** @type {Map<string, string>} */
  const latestRunByGithubId = new Map();
  /** @type {Map<string, CachedRun>} */
  const rawRuns = new Map();
  let records = 0;
  let agenticRunRecords = 0;
  let rawPayloadRecords = 0;
  let safeOutputItems = 0;
  /** @type {Map<string, Set<string>>} */
  const workflowPaths = new Map();
  for (const hint of options.workflowHints ?? []) {
    const coordinates = repositoryCoordinates(`${hint.owner}/${hint.repository}`);
    const lookup = `${coordinates.fullName.toLowerCase()}:${hint.name.toLowerCase()}`;
    const paths = workflowPaths.get(lookup) ?? new Set();
    paths.add(hint.path);
    workflowPaths.set(lookup, paths);
  }
  /** @param {{ envelope: Record<string, unknown>, line: number }} record */
  const accept = ({ envelope, line }) => {
    records += 1;
    if (envelope.kind === 'github_api_rate_limit') {
      rateLimitEnvelopes.push({ envelope, line });
    }
    if (envelope.kind === 'safe_output_item') {
      safeOutputItems += 1;
      const safeOutput = objectValue(envelope.safe_output, `gh-aw JSONL line ${line}.safe_output`);
      const githubRunId = identifier(
        safeOutput.run_id,
        `gh-aw JSONL line ${line}.safe_output.run_id`
      );
      const parentRunId = latestRunByGithubId.get(String(githubRunId));
      if (parentRunId) {
        const items = safeOutputItemsByRun.get(parentRunId) ?? [];
        items.push({ value: safeOutput, line });
        safeOutputItemsByRun.set(parentRunId, items);
      }
      return;
    }
    if (envelope.kind === 'token_efficiency_observation') {
      const observation = objectValue(
        envelope.observation,
        `gh-aw JSONL line ${line}.observation`
      );
      const optimizerRunId = identifier(
        observation.optimizerRunId,
        `gh-aw JSONL line ${line}.observation.optimizerRunId`
      );
      const optimizerRunAttempt = positiveInteger(
        observation.runAttempt ?? 1,
        `gh-aw JSONL line ${line}.observation.runAttempt`
      );
      const optimizerRunKey = runId(optimizerRunId, optimizerRunAttempt);
      const observations = tokenEfficiencyObservationsByRun.get(optimizerRunKey) ?? [];
      observations.push({ ...observation, __line: line });
      tokenEfficiencyObservationsByRun.set(optimizerRunKey, observations);
      return;
    }
    if (envelope.kind === 'token_efficiency_lifecycle_observation') {
      const observation = objectValue(
        envelope.observation,
        `gh-aw JSONL line ${line}.observation`
      );
      const optimizerRunId = identifier(
        observation.optimizerRunId,
        `gh-aw JSONL line ${line}.observation.optimizerRunId`
      );
      const optimizerRunAttempt = positiveInteger(
        observation.optimizerRunAttempt,
        `gh-aw JSONL line ${line}.observation.optimizerRunAttempt`
      );
      const optimizerRunKey = runId(optimizerRunId, optimizerRunAttempt);
      const observations = tokenEfficiencyLifecycleObservationsByRun.get(optimizerRunKey) ?? [];
      observations.push({ ...observation, __line: line });
      tokenEfficiencyLifecycleObservationsByRun.set(optimizerRunKey, observations);
      return;
    }
    if (envelope.kind === 'run' || envelope.kind === 'token_efficiency_run_context') {
      if (envelope.kind === 'run') agenticRunRecords += 1;
      const run = objectValue(envelope.run, `gh-aw JSONL line ${line}.run`);
      const organization = requiredString(run.organization, `gh-aw JSONL line ${line}.run.organization`);
      const coordinates = repositoryCoordinates(
        requiredString(run.repository, `gh-aw JSONL line ${line}.run.repository`),
        organization
      );
      const workflowName = requiredString(
        run.workflow_name,
        `gh-aw JSONL line ${line}.run.workflow_name`
      );
      const workflowPath = requiredString(
        run.workflow_path,
        `gh-aw JSONL line ${line}.run.workflow_path`
      );
      const githubRunId = identifier(run.run_id, `gh-aw JSONL line ${line}.run.run_id`);
      const attempt = positiveInteger(
        run.run_attempt ?? 1,
        `gh-aw JSONL line ${line}.run.run_attempt`
      );
      const id = runId(githubRunId, attempt);
      const observedAt = canonicalTimestamp(
        run.updated_at ?? run.created_at,
        `gh-aw JSONL line ${line}.run.updated_at`
      );
      const candidate = {
        line,
        observedAt,
        value: run,
        ...coordinates,
        workflowName,
        workflowPath
      };
      enrichedRuns.set(id, enrichedRuns.has(id)
        ? preferNewer(/** @type {CachedRun} */ (enrichedRuns.get(id)), candidate)
        : candidate);
      latestRunByGithubId.set(String(githubRunId), id);
      const lookup = `${coordinates.fullName.toLowerCase()}:${workflowName.toLowerCase()}`;
      const paths = workflowPaths.get(lookup) ?? new Set();
      paths.add(workflowSourcePath(workflowPath));
      workflowPaths.set(lookup, paths);
      return;
    }
    if (envelope.kind !== 'workflow_runs') return;
    const request = objectValue(envelope.request, `gh-aw JSONL line ${line}.request`);
    const coordinates = repositoryCoordinates(
      requiredString(request.repository, `gh-aw JSONL line ${line}.request.repository`)
    );
    if (!Array.isArray(envelope.payload)) {
      throw new TypeError(`gh-aw JSONL line ${line}.payload must be an array`);
    }
    for (const [payloadIndex, candidateValue] of envelope.payload.entries()) {
      rawPayloadRecords += 1;
      const run = objectValue(candidateValue, `gh-aw JSONL line ${line}.payload[${payloadIndex}]`);
      const githubRunId = identifier(
        run.databaseId,
        `gh-aw JSONL line ${line}.payload[${payloadIndex}].databaseId`
      );
      const attempt = positiveInteger(
        run.attempt ?? 1,
        `gh-aw JSONL line ${line}.payload[${payloadIndex}].attempt`
      );
      const workflowName = requiredString(
        run.workflowName,
        `gh-aw JSONL line ${line}.payload[${payloadIndex}].workflowName`
      );
      const observedAt = canonicalTimestamp(
        run.updatedAt ?? run.createdAt,
        `gh-aw JSONL line ${line}.payload[${payloadIndex}].updatedAt`
      );
      const id = runId(githubRunId, attempt);
      const candidate = {
        line,
        observedAt,
        value: run,
        ...coordinates,
        workflowName,
        workflowPath: undefined
      };
      rawRuns.set(id, rawRuns.has(id)
        ? preferNewer(/** @type {CachedRun} */ (rawRuns.get(id)), candidate)
        : candidate);
    }
  };

  const finish = () => {
    for (const run of rawRuns.values()) {
      const paths = workflowPaths.get(
        `${run.fullName.toLowerCase()}:${run.workflowName.toLowerCase()}`
      );
      run.workflowPath = paths?.size === 1 ? [...paths][0] : undefined;
    }
  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [];
  /** @type {Map<string, import('../model/schema.js').CanonicalObservation>} */
  const repositories = new Map();
  /** @type {Map<string, import('../model/schema.js').CanonicalObservation>} */
  const workflows = new Map();

  /** @param {CachedRun} candidate */
  const structuralIds = (candidate) => {
    const repositorySourceId = candidate.fullName.toLowerCase();
    const canonicalWorkflowPath = candidate.workflowPath
      ? workflowSourcePath(candidate.workflowPath)
      : undefined;
    const workflowCoordinate = canonicalWorkflowPath
      ? `${repositorySourceId}:path:${canonicalWorkflowPath}`
      : `${repositorySourceId}:name:${candidate.workflowName.toLowerCase()}`;
    const repository = repositoryCoordinateId(candidate.owner, candidate.name);
    const workflow = canonicalWorkflowPath
      ? workflowCoordinateId(candidate.owner, candidate.name, canonicalWorkflowPath)
      : sourceId('workflow', OBSERVATION_SOURCE, workflowCoordinate);
    repositories.set(repository, {
      kind: 'repository',
      source: OBSERVATION_SOURCE,
      sourceId: `repository:${repositorySourceId}`,
      observedAt: candidate.observedAt,
      data: {
        id: repository,
        owner: candidate.owner,
        name: candidate.name,
        fullName: candidate.fullName,
        visibility: 'unknown'
      }
    });
    workflows.set(workflow, {
      kind: 'workflow',
      source: OBSERVATION_SOURCE,
      sourceId: `workflow:${workflowCoordinate}`,
      observedAt: candidate.observedAt,
      data: {
        id: workflow,
        repositoryId: repository,
        name: candidate.workflowName,
        path: canonicalWorkflowPath,
        state: 'unknown'
      }
    });
    return { repository, workflow };
  };

  const runIds = new Set([...rawRuns.keys(), ...enrichedRuns.keys()]);
  for (const id of [...runIds].sort()) {
    const raw = rawRuns.get(id);
    const enriched = enrichedRuns.get(id);
    const structural = /** @type {CachedRun} */ (enriched ?? raw);
    const { repository, workflow } = structuralIds(structural);
    const rawValue = raw?.value ?? {};
    const enrichedValue = enriched?.value ?? {};
    const githubRunId = identifier(
      rawValue.databaseId ?? enrichedValue.run_id,
      `${id}.githubRunId`
    );
    const attempt = positiveInteger(
      rawValue.attempt ?? enrichedValue.run_attempt ?? 1,
      `${id}.attempt`
    );
    const metadata = runMetadata(enrichedValue);
    const aggregates = runAggregates(enrichedValue);
    const title = optionalString(rawValue.displayTitle)
      ?? optionalString(enrichedValue.display_title)
      ?? `Run ${githubRunId}`;
    const event = optionalString(rawValue.event)
      ?? optionalString(enrichedValue.event)
      ?? optionalString(enrichedValue.event_name)
      ?? 'unknown';
    const status = optionalString(rawValue.status)
      ?? optionalString(enrichedValue.status)
      ?? 'unknown';
    const updatedAt = optionalString(rawValue.updatedAt)
      ?? optionalString(enrichedValue.updated_at)
      ?? null;
    const observedAt = raw && enriched
      ? (Date.parse(raw.observedAt) >= Date.parse(enriched.observedAt) ? raw.observedAt : enriched.observedAt)
      : /** @type {CachedRun} */ (raw ?? enriched).observedAt;
    observations.push({
      kind: 'run',
      source: OBSERVATION_SOURCE,
      sourceId: `run:${githubRunId}:${attempt}`,
      observedAt,
      data: withoutUndefined({
        id,
        repositoryId: repository,
        workflowId: workflow,
        owner: structural.owner,
        repository: structural.name,
        repositoryFullName: structural.fullName,
        workflowPath: structural.workflowPath ? workflowSourcePath(structural.workflowPath) : undefined,
        githubRunId,
        attempt,
        number: finiteNumber(rawValue.number) ?? finiteNumber(enrichedValue.number),
        title,
        event,
        targetRepository: dispatchTargetRepository(title, event),
        status,
        conclusion: optionalString(rawValue.conclusion)
          ?? optionalString(enrichedValue.conclusion)
          ?? null,
        branch: optionalString(rawValue.headBranch) ?? optionalString(enrichedValue.branch),
        headSha: optionalString(rawValue.headSha) ?? optionalString(enrichedValue.head_sha),
        createdAt: optionalString(rawValue.createdAt)
          ?? optionalString(enrichedValue.created_at)
          ?? null,
        startedAt: optionalString(rawValue.startedAt)
          ?? optionalString(enrichedValue.started_at)
          ?? null,
        completedAt: status === 'completed' ? updatedAt : null,
        updatedAt,
        runLink: optionalString(rawValue.url) ?? optionalString(enrichedValue.url) ?? null,
        classification: optionalString(enrichedValue.classification),
        intentionalFailure: enrichedValue.intentional_failure,
        failureKind: optionalString(enrichedValue.failure_kind),
        duration: optionalString(enrichedValue.duration),
        actionMinutes: finiteNumber(enrichedValue.action_minutes),
        agentId: metadata.agentId ?? null,
        agentVersion: metadata.agentVersion ?? null,
        modelId: metadata.modelId ?? null,
        ...aggregates,
        ghAwVersion: metadata.ghAwVersion ?? null,
        engine: metadata.engine ?? 'unknown',
        engineId: metadata.engineId,
        engineVersion: metadata.engineVersion,
        requestedModel: metadata.requestedModel,
        resolvedModel: metadata.resolvedModel,
        agentRuntime: metadata.agentRuntime,
        firewallVersion: metadata.firewallVersion,
        gatewayVersion: metadata.gatewayVersion,
        aic: metadata.aicTotal,
        aicTotal: metadata.aicTotal,
        tokenUsage: metadata.tokenUsage,
        ambientContext: enrichedValue.ambient_context,
        workingSet: enrichedValue.working_set,
        behaviorFingerprint: enrichedValue.behavior_fingerprint,
        taskDomain: enrichedValue.task_domain,
        comparison: enrichedValue.comparison,
        agenticAssessments: enrichedValue.agentic_assessments,
        graders: enrichedValue.graders,
        context: enrichedValue.context,
        githubApiCalls: finiteNumber(enrichedValue.github_api_calls),
        safeItemsCount: finiteNumber(enrichedValue.safe_items_count),
        errorCount: finiteNumber(enrichedValue.error_count),
        logsPath: optionalString(enrichedValue.logs_path),
        auditPath: optionalString(enrichedValue.audit_path)
      })
    });
  }

  observations.unshift(...repositories.values(), ...workflows.values());

  for (const [id, enriched] of [...enrichedRuns.entries()].sort()) {
    const run = enriched.value;
    const awInfo = run.aw_info && typeof run.aw_info === 'object' && !Array.isArray(run.aw_info)
      ? /** @type {Record<string, unknown>} */ (run.aw_info)
      : {};
    const eventScopeId = `${id}:agentic`;
    const startedAt = timestamp(run.started_at ?? run.created_at) ?? enriched.observedAt;
    const completedAt = run.status === 'completed'
      ? timestamp(run.updated_at) ?? enriched.observedAt
      : null;
    let sourceSequence = enriched.line * 1000;
    /**
     * @param {string} type
     * @param {string | null} eventTimestamp
     * @param {string} summary
     * @param {string | undefined} status
     * @param {unknown} identity
     * @param {Record<string, unknown> & { source?: string, correlationId?: string }} [fields]
     */
    const emitEvent = (type, eventTimestamp, summary, status, identity = type, fields = {}) => {
      if (!eventTimestamp) return;
      const recordFields = {
        source: fields.source ?? 'gh-aw-logs',
        summary,
        ...fields
      };
      const kind = recordKind(type, recordFields);
      observations.push({
        kind,
        source: OBSERVATION_SOURCE,
        sourceId: `${eventScopeId}:${type}:${stableDigest(identity)}`,
        observedAt: enriched.observedAt,
        data: withoutUndefined({
          runId: id,
          timestamp: eventTimestamp,
          source: fields.source ?? 'gh-aw-logs',
          type,
          summary,
          status,
          correlationId: fields.correlationId,
          payloadRef: `gh-aw-logs-shards#L${enriched.line}`,
          sourceSequence,
          ...fields,
          ...specializedFields(type, recordFields, kind)
        })
      });
      sourceSequence += 1;
    };

    emitEvent(
      'workflow_run_started',
      startedAt,
      detail([optionalString(run.workflow_name) ?? '', optionalString(run.display_title) ?? '']),
      optionalString(run.status),
      { type: 'started', startedAt }
    );
    emitEvent(
      'agent.session',
      startedAt,
      detail([
        optionalString(run.engine) ?? optionalString(awInfo.engine_name) ?? '',
        optionalString(run.model) ?? optionalString(awInfo.model) ?? ''
      ]),
      optionalString(run.status),
      { type: 'agent-session', engine: run.engine_id, model: run.model },
      { source: 'agent' }
    );
    if (completedAt) {
      emitEvent(
        'workflow_run_completed',
        completedAt,
        optionalString(run.classification) ?? optionalString(run.conclusion) ?? 'completed',
        optionalString(run.conclusion) ?? optionalString(run.status),
        { type: 'completed', completedAt, conclusion: run.conclusion }
      );
    }
    if (run.conclusion === 'failure' || run.failure_kind !== undefined) {
      emitEvent(
        'workflow_run_failed',
        completedAt ?? enriched.observedAt,
        optionalString(run.failure_kind) ?? 'workflow run failed',
        'failure',
        { type: 'failure', failureKind: run.failure_kind, errorCount: run.error_count }
      );
    }
    if (run.token_usage_summary !== undefined || run.token_usage !== undefined || run.aic !== undefined) {
      const tokenSummary = run.token_usage_summary && typeof run.token_usage_summary === 'object'
        && !Array.isArray(run.token_usage_summary)
        ? /** @type {Record<string, unknown>} */ (run.token_usage_summary)
        : {};
      emitEvent(
        'workflow_run_usage',
        completedAt ?? enriched.observedAt,
        `AIC ${String(finiteNumber(tokenSummary.total_aic) ?? finiteNumber(run.aic) ?? 'unknown')}`,
        'observed',
        { type: 'usage', tokenUsage: run.token_usage_summary ?? run.token_usage, aic: run.aic }
      );
    }
    if (run.working_set !== undefined) {
      emitEvent(
        'workflow_run_working_set',
        completedAt ?? enriched.observedAt,
        'Working set measured',
        'observed',
        { type: 'working-set', value: run.working_set }
      );
    }
    if (run.behavior_fingerprint !== undefined || run.task_domain !== undefined) {
      const taskDomain = run.task_domain && typeof run.task_domain === 'object'
        && !Array.isArray(run.task_domain)
        ? /** @type {Record<string, unknown>} */ (run.task_domain)
        : {};
      emitEvent(
        'workflow_run_behavior',
        completedAt ?? enriched.observedAt,
        optionalString(taskDomain.label) ?? 'Behavior classified',
        'observed',
        { type: 'behavior', fingerprint: run.behavior_fingerprint, taskDomain: run.task_domain }
      );
    }
    if (Array.isArray(run.agentic_assessments)) {
      run.agentic_assessments.forEach((assessment, index) => {
        const record = assessment && typeof assessment === 'object' && !Array.isArray(assessment)
          ? /** @type {Record<string, unknown>} */ (assessment)
          : {};
        emitEvent(
          'workflow_run_assessment',
          completedAt ?? enriched.observedAt,
          optionalString(record.summary) ?? optionalString(record.kind) ?? `Assessment ${index + 1}`,
          optionalString(record.severity),
          { type: 'assessment', index, record }
        );
      });
    }
    const graders = run.graders && typeof run.graders === 'object' && !Array.isArray(run.graders)
      ? /** @type {Record<string, unknown>} */ (run.graders)
      : {};
    const graderResults = Array.isArray(graders.results)
      ? graders.results
      : [];
    graderResults.forEach((grader, index) => {
      const record = grader && typeof grader === 'object' && !Array.isArray(grader)
        ? /** @type {Record<string, unknown>} */ (grader)
        : {};
      emitEvent(
        'workflow_run_grader',
        completedAt ?? enriched.observedAt,
        optionalString(record.name) ?? optionalString(record.id) ?? `Grader ${index + 1}`,
        optionalString(record.status) ?? (record.passed === true ? 'passed' : record.passed === false ? 'failed' : undefined),
        { type: 'grader', index, record },
        {
          source: 'grader',
          grader: optionalString(record.id) ?? `grader-${index + 1}`,
          graderName: optionalString(record.name),
          graderSource: optionalString(record.source),
          value: finiteNumber(record.value),
          unit: optionalString(record.unit),
          direction: optionalString(record.direction),
          message: optionalString(record.message),
          error: optionalString(record.error),
          implementation: record.implementation,
          observation: record.observation,
          metrics: record.metrics,
          diagnostics: record.diagnostics,
          baselineValue: finiteNumber(record.baselineValue),
          deltaFromBaseline: finiteNumber(record.deltaFromBaseline)
        }
      );
    });
    const audit = run.audit && typeof run.audit === 'object' && !Array.isArray(run.audit)
      ? /** @type {Record<string, unknown>} */ (run.audit)
      : {};
    const explicitSafeOutputs = safeOutputItemsByRun.get(id) ?? [];
    const nestedSafeOutputs = Array.isArray(run.safe_outputs)
      ? run.safe_outputs
      : Array.isArray(audit.created_items) ? audit.created_items : [];
    const safeOutputs = explicitSafeOutputs.length > 0
      ? explicitSafeOutputs
      : nestedSafeOutputs.map((value) => ({ value, line: enriched.line }));
    for (const tokenObservation of tokenEfficiencyObservationsByRun.get(id) ?? []) {
      const observed = timestamp(tokenObservation.observedAt) ?? completedAt ?? enriched.observedAt;
      const targetRepo = requiredString(tokenObservation.targetRepo, 'token observation targetRepo').toLowerCase();
      if (!REPOSITORY_COORDINATE_PATTERN.test(targetRepo)) continue;
      const targetCoordinates = repositoryCoordinates(targetRepo);
      const targetWorkflowPath = requiredString(
        tokenObservation.workflowPath,
        'token observation workflowPath'
      );
      const opportunityId = requiredString(
        tokenObservation.opportunityId,
        'token observation opportunityId'
      );
      const interventionId = requiredString(
        tokenObservation.interventionId,
        'token observation interventionId'
      );
      emitEvent(
        'token_efficiency.opportunity',
        observed,
        optionalString(tokenObservation.opportunityKind) ?? 'Token-efficiency opportunity',
        optionalString(tokenObservation.evidenceState) ?? 'unavailable',
        { type: 'token-efficiency-opportunity', opportunityId },
        {
          source: 'token-optimizer-observation',
          targetRepo,
          targetOrganization: targetCoordinates.owner,
          targetRepository: targetCoordinates.name,
          targetWorkflowPath,
          opportunityId,
          opportunityKind: optionalString(tokenObservation.opportunityKind),
          assignmentRunId: optionalString(tokenObservation.assignmentRunId),
          experimentId: optionalString(tokenObservation.experimentId),
          evidenceWindowStart: optionalString(tokenObservation.evidenceWindowStart),
          evidenceWindowEnd: optionalString(tokenObservation.evidenceWindowEnd),
          evidenceState: optionalString(tokenObservation.evidenceState),
          evidenceConfidence: finiteNumber(tokenObservation.evidenceConfidence),
          costGrain: optionalString(tokenObservation.costGrain),
          evidenceProvenance: tokenObservation.evidenceProvenance,
          payloadRef: `gh-aw-logs-shards#L${String(tokenObservation.__line)}`
        }
      );
      emitEvent(
        'token_efficiency.intervention',
        observed,
        optionalString(tokenObservation.opportunityKind) ?? 'Token-efficiency intervention',
        optionalString(tokenObservation.interventionState) ?? 'proposed',
        { type: 'token-efficiency-intervention', interventionId },
        {
          source: 'token-optimizer-observation',
          targetRepo,
          targetOrganization: targetCoordinates.owner,
          targetRepository: targetCoordinates.name,
          targetWorkflowPath,
          opportunityId,
          interventionId,
          interventionState: optionalString(tokenObservation.interventionState),
          recommendationDisposition: optionalString(tokenObservation.recommendationDisposition),
          supersedesInterventionId: optionalString(tokenObservation.supersedesInterventionId),
          supersededByInterventionId: optionalString(tokenObservation.supersededByInterventionId),
          experimentId: optionalString(tokenObservation.experimentId),
          controlVariant: optionalString(tokenObservation.controlVariant),
          optimizedVariant: optionalString(tokenObservation.optimizedVariant),
          proposedSavingsAic: finiteNumber(tokenObservation.proposedSavingsAic),
          attributableRunIds: tokenObservation.attributableRunIds,
          payloadRef: `gh-aw-logs-shards#L${String(tokenObservation.__line)}`
        }
      );
      const supersedesInterventionId = optionalString(tokenObservation.supersedesInterventionId);
      if (supersedesInterventionId) {
        emitEvent(
          'token_efficiency.intervention',
          observed,
          'Token-efficiency intervention superseded',
          'rejected',
          {
            type: 'token-efficiency-intervention-superseded',
            interventionId: supersedesInterventionId,
            supersededByInterventionId: interventionId
          },
          {
            source: 'token-optimizer-observation',
            targetRepo,
            targetOrganization: targetCoordinates.owner,
            targetRepository: targetCoordinates.name,
            targetWorkflowPath,
            opportunityId,
            interventionId: supersedesInterventionId,
            interventionState: 'rejected',
            recommendationDisposition: 'superseded',
            supersededByInterventionId: interventionId,
            supersededAt: observed,
            evidenceState: 'complete',
            payloadRef: `gh-aw-logs-shards#L${String(tokenObservation.__line)}`
          }
        );
      }
    }
    for (const lifecycle of tokenEfficiencyLifecycleObservationsByRun.get(id) ?? []) {
      const observed = canonicalTimestamp(
        lifecycle.observedAt,
        'token lifecycle observedAt'
      );
      const targetRepo = requiredString(lifecycle.targetRepo, 'token lifecycle targetRepo').toLowerCase();
      if (!REPOSITORY_COORDINATE_PATTERN.test(targetRepo)) {
        throw new TypeError('token lifecycle targetRepo must be an owner/repository coordinate');
      }
      const targetCoordinates = repositoryCoordinates(targetRepo);
      const targetWorkflowPath = requiredString(
        lifecycle.workflowPath,
        'token lifecycle workflowPath'
      );
      const opportunityId = requiredString(
        lifecycle.opportunityId,
        'token lifecycle opportunityId'
      );
      const interventionId = requiredString(
        lifecycle.interventionId,
        'token lifecycle interventionId'
      );
      const lifecycleObservationId = requiredString(
        lifecycle.lifecycleObservationId,
        'token lifecycle lifecycleObservationId'
      );
      const previousInterventionState = enumValue(
        lifecycle.previousInterventionState,
        'token lifecycle previousInterventionState',
        ['proposed', 'accepted', 'running', 'verified', 'regressed', 'inconclusive', 'rejected']
      );
      const interventionState = enumValue(
        lifecycle.interventionState,
        'token lifecycle interventionState',
        ['proposed', 'accepted', 'running', 'verified', 'regressed', 'inconclusive', 'rejected']
      );
      const previousRecommendationDisposition = enumValue(
        lifecycle.previousRecommendationDisposition,
        'token lifecycle previousRecommendationDisposition',
        ['applied', 'superseded', 'outdated', 'duplicate', 'unapplied', 'failed-start', 'rejected']
      );
      const recommendationDisposition = enumValue(
        lifecycle.recommendationDisposition,
        'token lifecycle recommendationDisposition',
        ['applied', 'superseded', 'outdated', 'duplicate', 'unapplied', 'failed-start', 'rejected']
      );
      const evidenceState = enumValue(
        lifecycle.evidenceState,
        'token lifecycle evidenceState',
        ['complete', 'incomplete', 'unavailable']
      );
      emitEvent(
        'token_efficiency.intervention',
        observed,
        optionalString(lifecycle.missingReason) ?? 'Token-efficiency lifecycle updated',
        interventionState,
        { type: 'token-efficiency-lifecycle', lifecycleObservationId },
        {
          source: 'token-intervention-lifecycle',
          optimizerRunAttempt: positiveInteger(
            lifecycle.optimizerRunAttempt,
            'token lifecycle optimizerRunAttempt'
          ),
          optimizerWorkflowPath: requiredString(
            lifecycle.optimizerWorkflowPath,
            'token lifecycle optimizerWorkflowPath'
          ),
          optimizerWorkflowName: requiredString(
            lifecycle.optimizerWorkflowName,
            'token lifecycle optimizerWorkflowName'
          ),
          targetRepo,
          targetOrganization: targetCoordinates.owner,
          targetRepository: targetCoordinates.name,
          targetWorkflowPath,
          opportunityId,
          interventionId,
          experimentId: optionalString(lifecycle.experimentId),
          controlVariant: optionalString(lifecycle.controlVariant),
          optimizedVariant: optionalString(lifecycle.optimizedVariant),
          proposedSavingsAic: finiteNumber(lifecycle.proposedSavingsAic),
          supersedesInterventionId: optionalString(lifecycle.supersedesInterventionId),
          recommendationChurnCount: finiteNumber(lifecycle.recommendationChurnCount),
          recommendationChurnRate: finiteNumber(lifecycle.recommendationChurnRate),
          lifecycleObservationId,
          previousInterventionState,
          interventionState,
          previousRecommendationDisposition,
          recommendationDisposition,
          evidenceState,
          missingReason: optionalString(lifecycle.missingReason),
          safeOutputId: requiredString(lifecycle.safeOutputId, 'token lifecycle safeOutputId'),
          safeOutputUrl: requiredString(lifecycle.safeOutputUrl, 'token lifecycle safeOutputUrl'),
          implementationChangeId: optionalString(lifecycle.implementationChangeId),
          implementationPullRequestUrl: optionalString(lifecycle.implementationPullRequestUrl),
          implementationRunIds: optionalIdentifierArray(
            lifecycle.implementationRunIds,
            'token lifecycle implementationRunIds'
          ),
          acceptedAt: optionalTimestamp(lifecycle.acceptedAt, 'token lifecycle acceptedAt'),
          implementationStartedAt: optionalTimestamp(
            lifecycle.implementationStartedAt,
            'token lifecycle implementationStartedAt'
          ),
          implementationCompletedAt: optionalTimestamp(
            lifecycle.implementationCompletedAt,
            'token lifecycle implementationCompletedAt'
          ),
          rejectedAt: optionalTimestamp(lifecycle.rejectedAt, 'token lifecycle rejectedAt'),
          supersededAt: optionalTimestamp(lifecycle.supersededAt, 'token lifecycle supersededAt'),
          supersededByInterventionId: optionalString(lifecycle.supersededByInterventionId),
          claimRunId: identifier(lifecycle.claimRunId, 'token lifecycle claimRunId'),
          claimRunAttempt: positiveInteger(
            lifecycle.claimRunAttempt,
            'token lifecycle claimRunAttempt'
          ),
          actor: requiredString(lifecycle.actor, 'token lifecycle actor'),
          sourceProvenance: objectValue(
            lifecycle.sourceProvenance,
            'token lifecycle sourceProvenance'
          ),
          payloadRef: `gh-aw-logs-shards#L${String(lifecycle.__line)}`
        }
      );
    }
    const runMcpToolUsage = run.mcp_tool_usage && typeof run.mcp_tool_usage === 'object'
      && !Array.isArray(run.mcp_tool_usage)
      ? /** @type {Record<string, unknown>} */ (run.mcp_tool_usage)
      : {};
    const auditMcpToolUsage = audit.mcp_tool_usage && typeof audit.mcp_tool_usage === 'object'
      && !Array.isArray(audit.mcp_tool_usage)
      ? /** @type {Record<string, unknown>} */ (audit.mcp_tool_usage)
      : {};
    const mcpToolUsage = Array.isArray(runMcpToolUsage.tool_calls)
      && runMcpToolUsage.tool_calls.length > 0
      ? runMcpToolUsage
      : auditMcpToolUsage;
    const toolCalls = Array.isArray(mcpToolUsage.tool_calls) ? mcpToolUsage.tool_calls : [];
    toolCalls.forEach((toolCall, index) => {
      const record = toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)
        ? /** @type {Record<string, unknown>} */ (toolCall)
        : {};
      const eventTimestamp = timestamp(record.timestamp) ?? completedAt ?? enriched.observedAt;
      const correlationId = optionalString(record.tool_call_id) ?? `${id}:mcp:${index}`;
      const summary = detail([
        optionalString(record.server_name) ?? 'unknown',
        optionalString(record.tool_name) ?? 'unknown'
      ]);
      const status = optionalString(record.status) ?? 'unknown';
      emitEvent(
        'tool.call',
        eventTimestamp,
        summary,
        'started',
        { type: 'mcp-call', index, server: record.server_name, tool: record.tool_name },
        {
          source: 'mcp',
          correlationId,
          mcpServer: optionalString(record.server_name),
          mcpTool: optionalString(record.tool_name)
        }
      );
      emitEvent(
        status === 'success' ? 'tool.result' : 'tool.error',
        eventTimestamp,
        summary,
        status,
        { type: 'mcp-outcome', index, status },
        {
          source: 'mcp',
          correlationId,
          mcpServer: optionalString(record.server_name),
          mcpTool: optionalString(record.tool_name)
        }
      );
    });
    /**
     * @param {string} field
     * @param {string} type
     * @param {string} summaryField
     * @param {string} statusField
     */
    const emitAuditEvents = (field, type, summaryField, statusField) => {
      const entries = Array.isArray(audit[field]) ? audit[field] : [];
      entries.forEach((entry, index) => {
        const record = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? /** @type {Record<string, unknown>} */ (entry)
          : {};
        emitEvent(
          type,
          timestamp(record.timestamp) ?? completedAt ?? enriched.observedAt,
          optionalString(record[summaryField]) ?? type,
          optionalString(record[statusField]),
          { type, index, summary: record[summaryField], status: record[statusField] },
          { source: 'audit' }
        );
      });
    };
    emitAuditEvents('key_findings', 'audit.finding', 'title', 'severity');
    emitAuditEvents('observability_insights', 'audit.observability', 'title', 'severity');
    emitAuditEvents('recommendations', 'audit.recommendation', 'action', 'priority');
    emitAuditEvents('missing_tools', 'audit.missing_tool', 'tool', 'status');
    emitAuditEvents('missing_data', 'audit.missing_data', 'data_type', 'status');
    emitAuditEvents('noops', 'audit.noop', 'message', 'status');
    emitAuditEvents('mcp_failures', 'audit.mcp_failure', 'server_name', 'status');
    emitAuditEvents('skill_activations', 'audit.skill_activation', 'name', 'status');
    const firewallAnalysisValue = run.firewall_analysis ?? audit.firewall_analysis;
    const firewallAnalysis = firewallAnalysisValue && typeof firewallAnalysisValue === 'object'
      && !Array.isArray(firewallAnalysisValue)
      ? /** @type {Record<string, unknown>} */ (firewallAnalysisValue)
      : {};
    const requestsByDomain = firewallAnalysis.requests_by_domain
      && typeof firewallAnalysis.requests_by_domain === 'object'
      && !Array.isArray(firewallAnalysis.requests_by_domain)
      ? /** @type {Record<string, unknown>} */ (firewallAnalysis.requests_by_domain)
      : {};
    for (const [host, counts] of Object.entries(requestsByDomain)) {
      const domain = firewallDomain(host);
      if (!domain || !counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
      const record = /** @type {Record<string, unknown>} */ (counts);
      for (const [decision, field, type] of [
        ['allowed', 'allowed', 'net_allowed'],
        ['denied', 'blocked', 'net_blocked']
      ]) {
        const requestCount = finiteNumber(record[field]);
        if (!requestCount || requestCount < 0) continue;
        emitEvent(
          type,
          completedAt ?? enriched.observedAt,
          host,
          decision,
          { type: 'firewall', host, decision },
          { source: 'firewall', domain, decision, requestCount }
        );
      }
    }
    safeOutputs.forEach((safeOutput, index) => {
      const record = safeOutput.value && typeof safeOutput.value === 'object'
        && !Array.isArray(safeOutput.value)
        ? /** @type {Record<string, unknown>} */ (safeOutput.value)
        : {};
      emitEvent(
        'safe_output.created',
        timestamp(record.timestamp) ?? completedAt ?? enriched.observedAt,
        detail([
          optionalString(record.type) ?? 'safe output',
          optionalString(record.repo) ?? '',
          optionalString(record.number) ?? ''
        ]),
        'created',
        { type: 'safe-output', index, outputType: record.type, url: record.url },
        {
          source: 'safe-output',
          correlationId: optionalString(record.url ?? record.temporaryId),
          safeOutputType: optionalString(record.type),
          githubEntityType: safeOutputGithubEntityType(record),
          payloadRef: `gh-aw-logs-shards#L${safeOutput.line}`
        }
      );
    });
    if (run.safe_items_count !== undefined) {
      emitEvent(
        'workflow_run_safe_outputs',
        completedAt ?? enriched.observedAt,
        `${String(run.safe_items_count)} safe output items`,
        'observed',
        { type: 'safe-outputs', count: run.safe_items_count }
      );
    }
    if (run.comparison !== undefined) {
      const comparison = run.comparison && typeof run.comparison === 'object'
        && !Array.isArray(run.comparison)
        ? /** @type {Record<string, unknown>} */ (run.comparison)
        : {};
      emitEvent(
        'workflow_run_comparison',
        completedAt ?? enriched.observedAt,
        comparison.baseline_found === true ? 'Baseline comparison available' : 'No baseline comparison',
        comparison.baseline_found === true ? 'available' : 'unavailable',
        { type: 'comparison', value: run.comparison }
      );
    }
  }
  const unmatchedLifecycleRuns = [...tokenEfficiencyLifecycleObservationsByRun.keys()]
    .filter((id) => !runIds.has(id));
  if (unmatchedLifecycleRuns.length > 0) {
    throw new TypeError(
      `Token lifecycle observations require retained optimizer runs: ${unmatchedLifecycleRuns.join(', ')}`
    );
  }

  let mappedRateLimits = 0;
  if (rateLimitEnvelopes.length > 0 && options.context !== undefined) {
    const context = objectValue(options.context, 'gh-aw JSONL collection context');
    const observedAt = canonicalTimestamp(
      context.observedAt,
      'gh-aw JSONL collection context observedAt'
    );
    const contextRun = objectValue(context.run, 'gh-aw JSONL collection context run');
    const collectionRunId = runId(
      identifier(contextRun.githubRunId, 'gh-aw JSONL collection context run.githubRunId'),
      positiveInteger(contextRun.attempt, 'gh-aw JSONL collection context run.attempt')
    );
    if (!runIds.has(collectionRunId)) {
      const contextRepository = objectValue(
        context.repository,
        'gh-aw JSONL collection context repository'
      );
      const contextWorkflow = objectValue(
        context.workflow,
        'gh-aw JSONL collection context workflow'
      );
      const repositoryGithubId = identifier(
        contextRepository.githubId,
        'gh-aw JSONL collection context repository.githubId'
      );
      const workflowGithubId = identifier(
        contextWorkflow.githubId,
        'gh-aw JSONL collection context workflow.githubId'
      );
      const owner = requiredString(
        contextRepository.owner,
        'gh-aw JSONL collection context repository.owner'
      );
      const name = requiredString(
        contextRepository.name,
        'gh-aw JSONL collection context repository.name'
      );
      const repository = repositoryCoordinateId(owner, name);
      const contextWorkflowPath = requiredString(
        contextWorkflow.path,
        'gh-aw JSONL collection context workflow.path'
      );
      const workflow = workflowCoordinateId(owner, name, contextWorkflowPath);
      observations.push(
        {
          kind: 'repository',
          source: OBSERVATION_SOURCE,
          sourceId: `collection-repository:${repositoryGithubId}`,
          observedAt,
          data: {
            id: repository,
            githubId: repositoryGithubId,
            owner,
            name,
            fullName: `${owner}/${name}`,
            visibility: optionalString(contextRepository.visibility) ?? 'unknown'
          }
        },
        {
          kind: 'workflow',
          source: OBSERVATION_SOURCE,
          sourceId: `collection-workflow:${workflowGithubId}`,
          observedAt,
          data: {
            id: workflow,
            githubId: workflowGithubId,
            repositoryId: repository,
            name: requiredString(
              contextWorkflow.name,
              'gh-aw JSONL collection context workflow.name'
            ),
            path: workflowSourcePath(contextWorkflowPath),
            state: optionalString(contextWorkflow.state) ?? 'unknown'
          }
        },
        {
          kind: 'run',
          source: OBSERVATION_SOURCE,
          sourceId: `collection-run:${collectionRunId}`,
          observedAt,
          data: {
            githubRunId: identifier(
              contextRun.githubRunId,
              'gh-aw JSONL collection context run.githubRunId'
            ),
            attempt: positiveInteger(
              contextRun.attempt,
              'gh-aw JSONL collection context run.attempt'
            ),
            repositoryId: repository,
            workflowId: workflow,
            owner,
            repository: name,
            repositoryFullName: `${owner}/${name}`,
            workflowPath: requiredString(
              contextWorkflow.path,
              'gh-aw JSONL collection context workflow.path'
            ),
            event: optionalString(contextRun.event) ?? 'unknown',
            status: optionalString(contextRun.status) ?? 'unknown',
            conclusion: optionalString(contextRun.conclusion) ?? null,
            startedAt: optionalString(contextRun.startedAt) ?? null,
            completedAt: optionalString(contextRun.completedAt) ?? null
          }
        }
      );
      runIds.add(collectionRunId);
    }

    const eventScopeId = `${collectionRunId}:github-api-collection`;
    for (const { envelope, line } of rateLimitEnvelopes) {
      const rateLimit = objectValue(envelope.rate_limit, `gh-aw JSONL line ${line}.rate_limit`);
      const end = objectValue(rateLimit.end, `gh-aw JSONL line ${line}.rate_limit.end`);
      const remaining = finiteNumber(end.remaining);
      const limit = finiteNumber(end.limit);
      observations.push({
        kind: 'audit',
        source: OBSERVATION_SOURCE,
        sourceId: `${eventScopeId}:github_api_rate_limit:${line}`,
        observedAt,
        data: {
          runId: collectionRunId,
          timestamp: observedAt,
          source: 'github-api',
          type: 'github_api_rate_limit',
          summary: `${String(remaining ?? 'unknown')} of ${String(limit ?? 'unknown')} requests remaining`,
          status: remaining !== null && remaining > 0 ? 'available' : 'exhausted',
          correlationId: optionalString(rateLimit.host),
          payloadRef: `gh-aw-logs-shards#L${line}`,
          sourceSequence: line
        }
      });
      mappedRateLimits += 1;
    }
  }

  return {
    observations,
    records,
    rawPayloadRecords,
    rawRuns: rawRuns.size,
    agenticRunRecords,
    agenticRuns: enrichedRuns.size,
    duplicateRawRunObservations: rawPayloadRecords - rawRuns.size,
    duplicateAgenticRunObservations: agenticRunRecords - enrichedRuns.size,
    unenrichedRuns: runIds.size - enrichedRuns.size,
    recordsByKind: observations.reduce((counts, observation) => {
      if (observation.kind === 'domain') counts.domains += 1;
      if (observation.kind === 'tool') counts.tools += 1;
      if (observation.kind === 'audit') counts.audits += 1;
      if (observation.kind === 'issue') counts.issues += 1;
      return counts;
    }, { domains: 0, tools: 0, audits: 0, issues: 0 }),
    safeOutputItems,
    mappedSafeOutputItems: [...safeOutputItemsByRun.values()]
      .reduce((total, items) => total + items.length, 0),
    rateLimits: rateLimitEnvelopes.length,
    mappedRateLimits
  };
  };
  return { accept, finish };
}
