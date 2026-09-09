import { jobId, repositoryId, runId, sourceId, workflowId } from '../model/ids.js'
import { canonicalTimestamp, requiredString } from '../model/schema.js'

const OBSERVATION_SOURCE = 'gh-aw-logs'

/** @param {unknown} value @param {string} field */
function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} value @param {string} field */
function identifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(`${field} is required`)
  }
  return String(value).trim()
}

/** @param {unknown} value @param {string} field */
function positiveInteger(value, field) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${field} must be a positive integer`)
  return number
}

/** @param {unknown} value */
function optionalString(value) {
  return value === undefined || value === null || value === '' ? undefined : String(value)
}

/** @param {string} content @param {string} filePath */
function parseJsonl(content, filePath) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return []
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new TypeError(`${filePath}:${index + 1} must contain valid JSON`, {
        cause: error,
      })
    }
    return [
      {
        value: objectValue(value, `${filePath}:${index + 1}`),
        line: index + 1,
      },
    ]
  })
}

/** @param {unknown} value */
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString()
  }
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

/** @param {unknown} value */
function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** @param {string[]} parts */
function detail(parts) {
  return parts.filter(Boolean).join('/')
}

/** @param {unknown} input */
function logFiles(input) {
  if (!Array.isArray(input)) throw new TypeError('gh-aw logs files must be an array')
  return input.map((candidate, index) => {
    const file = objectValue(candidate, `gh-aw logs file ${index}`)
    const content = file.content
    if (typeof content !== 'string') throw new TypeError(`gh-aw logs file ${index}.content must be a string`)
    return {
      path: requiredString(file.path, `gh-aw logs file ${index}.path`).replaceAll('\\', '/'),
      content,
    }
  })
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
      ...fields,
    },
  }
}

/** @param {string} sessionId @param {{ path: string, content: string }} file */
function agentEvents(sessionId, file) {
  let turn = 0
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.timestamp)
    if (!eventTimestamp) return []
    const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? /** @type {Record<string, unknown>} */ (value.data) : {}
    switch (value.type) {
      case 'user.message':
        turn += 1
        return [
          eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_turn', {
            summary: `turn ${turn}`,
          }),
        ]
      case 'assistant.message':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'assistant_message')]
      case 'reasoning':
      case 'assistant.reasoning':
        return [eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'reasoning')]
      case 'tool.execution_start':
        return [
          eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_tool_start', {
            summary: detail([text(data.mcpServerName), text(data.toolName)]),
            correlationId: optionalString(data.toolCallId),
          }),
        ]
      case 'tool.execution_complete':
        return [
          eventObservation(sessionId, file.path, line, eventTimestamp, 'agent', 'agent_tool_done', {
            summary: detail([text(data.mcpServerName), text(data.toolName)]),
            status: data.success === true ? 'success' : 'error',
            correlationId: optionalString(data.toolCallId),
          }),
        ]
      default:
        return []
    }
  })
}

/** @param {string} sessionId @param {{ path: string, content: string }} file @param {boolean} rpc */
function gatewayEvents(sessionId, file, rpc) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.timestamp)
    if (!eventTimestamp) return []
    if (rpc) {
      if (value.type === 'DIFC_FILTERED') {
        return [
          eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
            summary: detail([text(value.server_id), text(value.tool_name)]),
            status: optionalString(value.reason),
          }),
        ]
      }
      if (value.type === 'REQUEST' && value.direction === 'OUT') {
        return [
          eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
            summary: optionalString(value.method),
          }),
        ]
      }
      return []
    }
    if (value.type === 'DIFC_FILTERED') {
      return [
        eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'difc_filtered', {
          summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
          status: optionalString(value.reason),
        }),
      ]
    }
    if (value.type === 'GUARD_POLICY_BLOCKED') {
      return [
        eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'guard_blocked', {
          summary: detail([text(value.server_id ?? value.server_name), text(value.tool_name)]),
          status: optionalString(value.reason),
        }),
      ]
    }
    if (value.event === 'tool_call') {
      return [
        eventObservation(sessionId, file.path, line, eventTimestamp, 'gateway', 'tool_call', {
          summary: detail([text(value.server_name), text(value.tool_name)]),
          status: value.error ? 'error' : optionalString(value.status),
          correlationId: optionalString(value.tool_call_id),
        }),
      ]
    }
    return []
  })
}

/** @param {string} sessionId @param {{ path: string, content: string }} file */
function firewallEvents(sessionId, file) {
  return parseJsonl(file.content, file.path).flatMap(({ value, line }) => {
    const eventTimestamp = timestamp(value.ts)
    const host = text(value.host ?? value.domain)
    if (!eventTimestamp || !host || host === '-' || value.url === 'error:transaction-end-before-headers') return []
    const decision = text(value.decision ?? value.squid_request_status)
    const status = Number(value.status ?? value.http_status)
    const blocked = /denied|blocked|reject/i.test(decision) || (Number.isFinite(status) && status >= 400 && status < 600)
    return [
      eventObservation(sessionId, file.path, line, eventTimestamp, 'firewall', blocked ? 'net_blocked' : 'net_allowed', {
        summary: [host, text(value.method)].filter(Boolean).join(' '),
        status: Number.isFinite(status) && status > 0 ? String(status) : blocked ? 'blocked' : 'allowed',
      }),
    ]
  })
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
  const canonicalSessionId = requiredString(sessionId, 'gh-aw logs sessionId')
  const files = logFiles(input)
  const gateway = files.find((file) => /(^|\/)gateway\.jsonl$/.test(file.path))
  const rpc = gateway ? undefined : files.find((file) => /(^|\/)rpc-messages\.jsonl$/.test(file.path))
  return [
    ...(gateway ? gatewayEvents(canonicalSessionId, gateway, false) : rpc ? gatewayEvents(canonicalSessionId, rpc, true) : []),
    ...files.filter((file) => /firewall.*\/audit\.jsonl$/.test(file.path)).flatMap((file) => firewallEvents(canonicalSessionId, file)),
    ...files.filter((file) => /copilot-session-state\/[^/]+\/events\.jsonl$/.test(file.path)).flatMap((file) => agentEvents(canonicalSessionId, file)),
  ]
}

/**
 * Converts raw gh-aw run artifact files into a complete canonical observation
 * graph. The input carries GitHub identity context; Event data remains sourced
 * from gh-aw's agent, gateway, and firewall JSONL files.
 *
 * @param {unknown} input
 * @returns {{ generation: string, observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptGhAwLogs(input) {
  const document = objectValue(input, 'gh-aw logs input')
  const generation = requiredString(document.generation, 'gh-aw logs generation')
  const observedAt = canonicalTimestamp(document.observedAt, 'gh-aw logs observedAt')
  const repository = objectValue(document.repository, 'gh-aw logs repository')
  const workflow = objectValue(document.workflow, 'gh-aw logs workflow')
  const run = objectValue(document.run, 'gh-aw logs run')
  const job = document.job === undefined || document.job === null ? null : objectValue(document.job, 'gh-aw logs job')

  const repositoryGithubId = identifier(repository.githubId, 'repository.githubId')
  const workflowGithubId = identifier(workflow.githubId, 'workflow.githubId')
  const githubRunId = identifier(run.githubRunId, 'run.githubRunId')
  const attempt = positiveInteger(run.attempt, 'run.attempt')
  const canonicalRunId = runId(githubRunId, attempt)
  const sessionSourceId = `${canonicalRunId}:unified`
  const canonicalSessionId = sourceId('session', OBSERVATION_SOURCE, sessionSourceId)
  const events = adaptGhAwTimelineFiles(document.files, canonicalSessionId)

  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = [
    {
      kind: 'repository',
      source: OBSERVATION_SOURCE,
      sourceId: `repository:${repositoryGithubId}`,
      observedAt,
      data: {
        githubId: repositoryGithubId,
        owner: requiredString(repository.owner, 'repository.owner'),
        name: requiredString(repository.name, 'repository.name'),
        fullName: `${requiredString(repository.owner, 'repository.owner')}/${requiredString(repository.name, 'repository.name')}`,
        visibility: optionalString(repository.visibility) ?? 'unknown',
      },
    },
    {
      kind: 'workflow',
      source: OBSERVATION_SOURCE,
      sourceId: `workflow:${workflowGithubId}`,
      observedAt,
      data: {
        githubId: workflowGithubId,
        repositoryId: repositoryId(repositoryGithubId),
        name: requiredString(workflow.name, 'workflow.name'),
        path: requiredString(workflow.path, 'workflow.path'),
        state: optionalString(workflow.state) ?? 'unknown',
      },
    },
    {
      kind: 'run',
      source: OBSERVATION_SOURCE,
      sourceId: `run:${githubRunId}:${attempt}`,
      observedAt,
      data: {
        githubRunId,
        attempt,
        repositoryId: repositoryId(repositoryGithubId),
        workflowId: workflowId(workflowGithubId),
        event: optionalString(run.event) ?? 'unknown',
        status: optionalString(run.status) ?? 'unknown',
        conclusion: optionalString(run.conclusion) ?? null,
        createdAt: optionalString(run.createdAt) ?? null,
        startedAt: optionalString(run.startedAt) ?? null,
        completedAt: optionalString(run.completedAt) ?? null,
      },
    },
  ]
  if (job) {
    const githubJobId = identifier(job.githubJobId, 'job.githubJobId')
    observations.push({
      kind: 'job',
      source: OBSERVATION_SOURCE,
      sourceId: `job:${githubJobId}`,
      observedAt,
      data: {
        githubJobId,
        runId: canonicalRunId,
        name: requiredString(job.name, 'job.name'),
        status: optionalString(job.status) ?? 'unknown',
        conclusion: optionalString(job.conclusion) ?? null,
        startedAt: optionalString(job.startedAt) ?? null,
        completedAt: optionalString(job.completedAt) ?? null,
      },
    })
  }
  if (events.length > 0) {
    const orderedTimestamps = events.map((event) => String(event.data.timestamp)).sort()
    observations.push({
      kind: 'session',
      source: OBSERVATION_SOURCE,
      sourceId: sessionSourceId,
      observedAt,
      data: {
        id: canonicalSessionId,
        runId: canonicalRunId,
        jobId: job ? jobId(identifier(job.githubJobId, 'job.githubJobId')) : undefined,
        kind: 'unified-operational-log',
        status: optionalString(run.status) ?? 'unknown',
        startedAt: orderedTimestamps[0],
        completedAt: run.status === 'completed' ? orderedTimestamps.at(-1) : null,
      },
    })
    observations.push(...events)
  }
  return { generation, observations }
}
