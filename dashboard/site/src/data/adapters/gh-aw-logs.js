import {
  jobId,
  repositoryCoordinateId,
  runId,
  sourceId,
  workflowCoordinateId,
  workflowSourcePath
} from '../model/ids.js';
import { canonicalTimestamp, requiredString } from '../model/schema.js';
import cachedJsonlExpression from '../ingest/expressions/gh-aw-logs-v2.json' with { type: 'json' };

const OBSERVATION_SOURCE = 'gh-aw-logs';

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
    agentId: optionalString(run.agent_id ?? run.agent ?? run.engine_id ?? awInfo.engine_id),
    agentVersion: optionalString(run.agent_version ?? run.engine_version ?? awInfo.version),
    modelId: optionalString(run.model_id ?? run.resolved_model ?? run.model ?? awInfo.model ?? dominantModel),
    ghAwVersion: optionalString(run.gh_aw_version ?? run.ghAwVersion ?? run.cli_version ?? run.version ?? awInfo.cli_version),
    engine: optionalString(run.engine ?? awInfo.engine_name),
    engineId: optionalString(run.engine_id ?? awInfo.engine_id),
    engineVersion: optionalString(run.engine_version ?? awInfo.version),
    requestedModel: optionalString(run.requested_model ?? run.requestedModel ?? run.model ?? awInfo.model),
    resolvedModel: optionalString(run.resolved_model ?? run.resolvedModel ?? run.model_resolved ?? run.model ?? awInfo.model ?? dominantModel),
    agentRuntime: optionalString(run.agent_runtime ?? awInfo.agent_runtime),
    firewallVersion: optionalString(run.firewall_version ?? awInfo.firewall_version ?? awInfo.awf_version),
    gatewayVersion: optionalString(run.gateway_version ?? awInfo.awmg_version),
    aicTotal,
    tokenUsage
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
 * @param {string} sessionId
 * @param {string} filePath
 * @param {number} line
 * @param {string} eventTimestamp
 * @param {string} eventSource
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 */
function eventObservation(sessionId, filePath, line, eventTimestamp, eventSource, type, fields = {}) {
  return {
    kind: /** @type {const} */ ('event'),
    source: OBSERVATION_SOURCE,
    sourceId: `${sessionId}:${filePath}:${line}`,
    observedAt: eventTimestamp,
    data: {
      sessionId,
      timestamp: eventTimestamp,
      source: eventSource,
      type,
      payloadRef: `${filePath}#L${line}`,
      sourceSequence: line,
      ...fields
    }
  };
}

/** @param {string} sessionId @param {{ path: string, content: string }} file */
function agentEvents(sessionId, file) {
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
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_turn', {
          summary: `turn ${turn}`
        })];
      case 'assistant.message':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'assistant_message')];
      case 'reasoning':
      case 'assistant.reasoning':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'reasoning')];
      case 'tool.execution_start':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_tool_start', {
          summary: detail([text(data.mcpServerName), text(data.toolName)]),
          correlationId: optionalString(data.toolCallId)
        })];
      case 'tool.execution_complete':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_tool_done', {
          summary: detail([text(data.mcpServerName), text(data.toolName)]),
          status: data.success === true ? 'success' : 'error',
          correlationId: optionalString(data.toolCallId)
        })];
      default:
        return [];
    }
  });
}

/** @param {string} sessionId @param {{ path: string, content: string }} file @param {boolean} rpc */
function gatewayEvents(sessionId, file, rpc) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.timestamp);
    if (!eventTimestamp) return [];
    if (rpc) {
      if (value.type === 'DIFC_FILTERED') {
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
          summary: detail([text(value.server_id), text(value.tool_name)]),
          status: optionalString(value.reason)
        })];
      }
      if (value.type === 'REQUEST' && value.direction === 'OUT') {
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
          summary: optionalString(value.method)
        })];
      }
      return [];
    }
    if (value.type === 'DIFC_FILTERED') {
      return [eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
        summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
        status: optionalString(value.reason)
      })];
    }
    if (value.type === 'GUARD_POLICY_BLOCKED') {
      return [eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'guard_blocked', {
        summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
        status: optionalString(value.reason)
      })];
    }
    if (value.event === 'tool_call') {
      return [eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
        summary: detail([text(value.server_name), text(value.tool_name)]),
        status: value.error ? 'error' : optionalString(value.status),
        correlationId: optionalString(value.tool_call_id)
      })];
    }
    return [];
  });
}

/** @param {string} sessionId @param {{ path: string, content: string }} file */
function firewallEvents(sessionId, file) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.ts);
    const host = text(value.host ?? value.domain);
    const domain = firewallDomain(host);
    if (!eventTimestamp || !domain || value.url === 'error:transaction-end-before-headers') return [];
    const decision = text(value.decision ?? value.squid_request_status);
    const status = Number(value.status ?? value.http_status);
    const blocked = /denied|blocked|reject/i.test(decision)
      || (Number.isFinite(status) && status >= 400 && status < 600);
    return [eventObservation(sessionId, file.path, line, eventTimestamp, 'firewall', blocked ? 'net_blocked' : 'net_allowed', {
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
 * unified timeline vocabulary for one canonical Session.
 *
 * @param {unknown} input
 * @param {string} sessionId
 * @returns {import('../model/schema.js').CanonicalObservation[]}
 */
export function adaptGhAwTimelineFiles(input, sessionId) {
  const canonicalSessionId = requiredString(sessionId, 'gh-aw logs sessionId');
  const files = logFiles(input);
  const gateway = files.find((file) => /(^|\/)gateway\.jsonl$/.test(file.path));
  const rpc = gateway ? undefined : files.find((file) => /(^|\/)rpc-messages\.jsonl$/.test(file.path));
  return [
    ...(gateway ? gatewayEvents(canonicalSessionId, gateway, false) : rpc ? gatewayEvents(canonicalSessionId, rpc, true) : []),
    ...files.filter((file) => /firewall.*\/audit\.jsonl$/.test(file.path)).flatMap((file) => firewallEvents(canonicalSessionId, file)),
    ...files.filter((file) => /copilot-session-state\/[^/]+\/events\.jsonl$/.test(file.path)).flatMap((file) => agentEvents(canonicalSessionId, file))
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
  const job = document.job === undefined || document.job === null ? null : objectValue(document.job, 'gh-aw logs job');

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
  const sessionSourceId = `${canonicalRunId}:unified`;
  const canonicalSessionId = sourceId('session', OBSERVATION_SOURCE, sessionSourceId);
  const events = adaptGhAwTimelineFiles(document.files, canonicalSessionId);

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
  if (job) {
    const githubJobId = identifier(job.githubJobId, 'job.githubJobId');
    observations.push({
      kind: 'job', source: OBSERVATION_SOURCE, sourceId: `job:${githubJobId}`, observedAt,
      data: {
        githubJobId,
        runId: canonicalRunId,
        name: requiredString(job.name, 'job.name'),
        status: optionalString(job.status) ?? 'unknown',
        conclusion: optionalString(job.conclusion) ?? null,
        startedAt: optionalString(job.startedAt) ?? null,
        completedAt: optionalString(job.completedAt) ?? null
      }
    });
  }
  if (events.length > 0) {
    const orderedTimestamps = events.map((event) => String(event.data.timestamp)).sort();
    observations.push({
      kind: 'session', source: OBSERVATION_SOURCE, sourceId: sessionSourceId, observedAt,
      data: {
        id: canonicalSessionId,
        runId: canonicalRunId,
        jobId: job ? jobId(identifier(job.githubJobId, 'job.githubJobId')) : undefined,
        kind: 'unified-operational-log',
        status: optionalString(run.status) ?? 'unknown',
        startedAt: orderedTimestamps[0],
        completedAt: run.status === 'completed' ? orderedTimestamps.at(-1) : null
      }
    });
    observations.push(...events);
  }
  return { observations };
}

/**
 * @param {string} content
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
 *   sessions: number,
 *   events: number,
 *   rateLimits: number,
 *   mappedRateLimits: number
 * }}
 */
export function adaptCachedGhAwJsonl(content, options = {}) {
  if (typeof content !== 'string') throw new TypeError('gh-aw JSONL must be a string');
  if (cachedJsonlExpression.contract !== 'gh-aw-cao.jsonl-ingestion'
    || cachedJsonlExpression.version !== 1) {
    throw new TypeError('Unsupported cached gh-aw ingestion expression');
  }
  const sourceSchemaVersion = cachedJsonlExpression.sourceSchemaVersion;
  const knownKinds = new Set(Object.keys(cachedJsonlExpression.variants));
  /** @type {{ envelope: Record<string, unknown>, line: number }[]} */
  const envelopes = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let envelope;
    try { envelope = objectValue(JSON.parse(line), `gh-aw JSONL line ${index + 1}`); } catch (error) {
      throw new TypeError(`gh-aw JSONL line ${index + 1} must contain valid JSON`, { cause: error });
    }
    if (envelope.schema_version !== sourceSchemaVersion) {
      throw new TypeError(
        `Unsupported gh-aw JSONL schema version at line ${index + 1}: ${String(envelope.schema_version)}`
      );
    }
    const kind = requiredString(envelope.kind, `gh-aw JSONL line ${index + 1}.kind`);
    if (!knownKinds.has(kind)) {
      throw new TypeError(`Unsupported gh-aw JSONL kind at line ${index + 1}: ${kind}`);
    }
    envelopes.push({ envelope, line: index + 1 });
  }

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
  let agenticRunRecords = 0;
  /** @type {Map<string, Set<string>>} */
  const workflowPaths = new Map();
  for (const hint of options.workflowHints ?? []) {
    const coordinates = repositoryCoordinates(`${hint.owner}/${hint.repository}`);
    const lookup = `${coordinates.fullName.toLowerCase()}:${hint.name.toLowerCase()}`;
    const paths = workflowPaths.get(lookup) ?? new Set();
    paths.add(hint.path);
    workflowPaths.set(lookup, paths);
  }
  for (const { envelope, line } of envelopes) {
    if (envelope.kind !== 'run') continue;
    agenticRunRecords += 1;
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
    const lookup = `${coordinates.fullName.toLowerCase()}:${workflowName.toLowerCase()}`;
    const paths = workflowPaths.get(lookup) ?? new Set();
    paths.add(workflowSourcePath(workflowPath));
    workflowPaths.set(lookup, paths);
  }

  /** @type {Map<string, CachedRun>} */
  const rawRuns = new Map();
  let rawPayloadRecords = 0;
  for (const { envelope, line } of envelopes) {
    if (envelope.kind !== 'workflow_runs') continue;
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
      const paths = workflowPaths.get(
        `${coordinates.fullName.toLowerCase()}:${workflowName.toLowerCase()}`
      );
      const workflowPath = paths?.size === 1 ? [...paths][0] : undefined;
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
        workflowPath
      };
      rawRuns.set(id, rawRuns.has(id)
        ? preferNewer(/** @type {CachedRun} */ (rawRuns.get(id)), candidate)
        : candidate);
    }
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
        title: optionalString(rawValue.displayTitle)
          ?? optionalString(enrichedValue.display_title)
          ?? `Run ${githubRunId}`,
        event: optionalString(rawValue.event)
          ?? optionalString(enrichedValue.event)
          ?? optionalString(enrichedValue.event_name)
          ?? 'unknown',
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
    if (Array.isArray(enrichedValue.job_details)) {
      for (const [jobIndex, candidate] of enrichedValue.job_details.entries()) {
        const job = objectValue(candidate, `${id}.job_details[${jobIndex}]`);
        const githubJobId = identifier(job.id, `${id}.job_details[${jobIndex}].id`);
        const startedAt = timestamp(job.started_at) ?? timestamp(job.created_at);
        const completedAt = timestamp(job.completed_at);
        observations.push({
          kind: 'job',
          source: OBSERVATION_SOURCE,
          sourceId: `job:${githubJobId}`,
          observedAt: completedAt ?? startedAt ?? observedAt,
          data: {
            githubJobId,
            runId: id,
            name: requiredString(job.name, `${id}.job_details[${jobIndex}].name`),
            status: optionalString(job.status) ?? 'unknown',
            conclusion: optionalString(job.conclusion) ?? null,
            startedAt,
            completedAt,
            durationSeconds: startedAt && completedAt
              ? Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
              : null,
            runner: 'unknown',
            runnerName: 'unknown',
            runnerGroup: 'unknown'
          }
        });
      }
    }
  }

  observations.unshift(...repositories.values(), ...workflows.values());

  let derivedEvents = 0;
  for (const [id, enriched] of [...enrichedRuns.entries()].sort()) {
    const run = enriched.value;
    const awInfo = run.aw_info && typeof run.aw_info === 'object' && !Array.isArray(run.aw_info)
      ? /** @type {Record<string, unknown>} */ (run.aw_info)
      : {};
    const sessionSourceId = `${id}:agentic`;
    const sessionId = sourceId('session', OBSERVATION_SOURCE, sessionSourceId);
    const startedAt = timestamp(run.started_at ?? run.created_at) ?? enriched.observedAt;
    const completedAt = run.status === 'completed'
      ? timestamp(run.updated_at) ?? enriched.observedAt
      : null;
    observations.push({
      kind: 'session',
      source: OBSERVATION_SOURCE,
      sourceId: sessionSourceId,
      observedAt: enriched.observedAt,
      data: {
        id: sessionId,
        runId: id,
        kind: 'unified-operational-log',
        status: optionalString(run.status) ?? 'unknown',
        startedAt,
        completedAt
      }
    });

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
      observations.push({
        kind: 'event',
        source: OBSERVATION_SOURCE,
        sourceId: `${sessionSourceId}:${type}:${stableDigest(identity)}`,
        observedAt: enriched.observedAt,
        data: withoutUndefined({
          sessionId,
          timestamp: eventTimestamp,
          source: fields.source ?? 'gh-aw-logs',
          type,
          summary,
          status,
          correlationId: fields.correlationId,
          payloadRef: `gh-aw-logs.jsonl#L${enriched.line}`,
          sourceSequence,
          ...fields
        })
      });
      sourceSequence += 1;
      derivedEvents += 1;
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
        { type: 'grader', index, record }
      );
    });
    const mcpToolUsage = run.mcp_tool_usage && typeof run.mcp_tool_usage === 'object'
      && !Array.isArray(run.mcp_tool_usage)
      ? /** @type {Record<string, unknown>} */ (run.mcp_tool_usage)
      : {};
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
        { source: 'mcp', correlationId }
      );
      emitEvent(
        status === 'success' ? 'tool.result' : 'tool.error',
        eventTimestamp,
        summary,
        status,
        { type: 'mcp-outcome', index, status },
        { source: 'mcp', correlationId }
      );
    });
    const audit = run.audit && typeof run.audit === 'object' && !Array.isArray(run.audit)
      ? /** @type {Record<string, unknown>} */ (run.audit)
      : {};
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
    const firewallAnalysis = audit.firewall_analysis && typeof audit.firewall_analysis === 'object'
      && !Array.isArray(audit.firewall_analysis)
      ? /** @type {Record<string, unknown>} */ (audit.firewall_analysis)
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
    const safeOutputs = Array.isArray(run.safe_outputs)
      ? run.safe_outputs
      : Array.isArray(audit.created_items) ? audit.created_items : [];
    safeOutputs.forEach((safeOutput, index) => {
      const record = safeOutput && typeof safeOutput === 'object' && !Array.isArray(safeOutput)
        ? /** @type {Record<string, unknown>} */ (safeOutput)
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
          correlationId: optionalString(record.url ?? record.temporaryId)
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

  const rateLimitEnvelopes = envelopes.filter(({ envelope }) =>
    envelope.kind === 'github_api_rate_limit'
  );
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

    const sessionSourceId = `${collectionRunId}:github-api-collection`;
    const sessionId = sourceId('session', OBSERVATION_SOURCE, sessionSourceId);
    observations.push({
      kind: 'session',
      source: OBSERVATION_SOURCE,
      sourceId: sessionSourceId,
      observedAt,
      data: {
        id: sessionId,
        runId: collectionRunId,
        kind: 'unified-operational-log',
        status: optionalString(contextRun.status) ?? 'unknown',
        startedAt: optionalString(contextRun.startedAt) ?? observedAt,
        completedAt: optionalString(contextRun.completedAt) ?? observedAt
      }
    });
    for (const { envelope, line } of rateLimitEnvelopes) {
      const rateLimit = objectValue(envelope.rate_limit, `gh-aw JSONL line ${line}.rate_limit`);
      const end = objectValue(rateLimit.end, `gh-aw JSONL line ${line}.rate_limit.end`);
      const remaining = finiteNumber(end.remaining);
      const limit = finiteNumber(end.limit);
      observations.push({
        kind: 'event',
        source: OBSERVATION_SOURCE,
        sourceId: `${sessionSourceId}:github_api_rate_limit:${line}`,
        observedAt,
        data: {
          sessionId,
          timestamp: observedAt,
          source: 'github-api',
          type: 'github_api_rate_limit',
          summary: `${String(remaining ?? 'unknown')} of ${String(limit ?? 'unknown')} requests remaining`,
          status: remaining !== null && remaining > 0 ? 'available' : 'exhausted',
          correlationId: optionalString(rateLimit.host),
          payloadRef: `gh-aw-logs.jsonl#L${line}`,
          sourceSequence: line
        }
      });
      mappedRateLimits += 1;
    }
  }

  return {
    observations,
    records: envelopes.length,
    rawPayloadRecords,
    rawRuns: rawRuns.size,
    agenticRunRecords,
    agenticRuns: enrichedRuns.size,
    duplicateRawRunObservations: rawPayloadRecords - rawRuns.size,
    duplicateAgenticRunObservations: agenticRunRecords - enrichedRuns.size,
    unenrichedRuns: runIds.size - enrichedRuns.size,
    sessions: enrichedRuns.size + (mappedRateLimits > 0 ? 1 : 0),
    events: derivedEvents + mappedRateLimits,
    rateLimits: rateLimitEnvelopes.length,
    mappedRateLimits
  };
}