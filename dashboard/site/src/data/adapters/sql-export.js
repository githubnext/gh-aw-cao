import { jobId, repositoryId, runId, sourceId, workflowId } from '../model/ids.js'
import { canonicalTimestamp, ENTITY_KINDS, requiredString } from '../model/schema.js'

export const SQL_EXPORT_CONTRACT = 'gh-aw-cao.dashboard-sql-export'
export const SQL_EXPORT_VERSION = 1

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
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * Converts rows exported from the versioned CAO SQL interchange view. Database
 * owners map their schema to this contract before publishing the static JSON.
 *
 * @param {unknown} input
 * @returns {{ generation: string, observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function adaptSqlExport(input) {
  const document = objectValue(input, 'SQL export')
  if (document.contract !== SQL_EXPORT_CONTRACT) {
    throw new TypeError(`SQL export contract must be ${SQL_EXPORT_CONTRACT}`)
  }
  if (document.schema_version !== SQL_EXPORT_VERSION) {
    throw new TypeError(`Unsupported SQL export schema version: ${String(document.schema_version)}`)
  }
  const generation = requiredString(document.generation, 'SQL export generation')
  const exportedAt = canonicalTimestamp(document.exported_at, 'SQL export exported_at')
  const source = `sql:${requiredString(document.source, 'SQL export source')}`
  if (!Array.isArray(document.rows)) throw new TypeError('SQL export rows must be an array')

  /** @type {import('../model/schema.js').CanonicalObservation[]} */
  const observations = []
  for (const [index, candidate] of document.rows.entries()) {
    const row = objectValue(candidate, `SQL export row ${index}`)
    const kind = requiredString(row.entity_kind, `SQL export row ${index}.entity_kind`)
    if (!ENTITY_KINDS.includes(/** @type {import('../model/schema.js').EntityKind} */ (kind))) {
      throw new TypeError(`Unsupported SQL export entity kind: ${kind}`)
    }
    const sourceRecordId = requiredString(row.source_id, `SQL export row ${index}.source_id`)
    const observedAt = canonicalTimestamp(row.observed_at ?? exportedAt, `SQL export row ${index}.observed_at`)
    /** @type {Record<string, unknown>} */
    let data

    switch (kind) {
      case 'repository': {
        const owner = requiredString(row.repository_owner, 'repository_owner')
        const name = requiredString(row.repository_name, 'repository_name')
        data = {
          githubId: identifier(row.github_repository_id, 'github_repository_id'),
          owner,
          name,
          fullName: `${owner}/${name}`,
          visibility: optionalString(row.repository_visibility) ?? 'unknown',
        }
        break
      }
      case 'workflow':
        data = {
          githubId: identifier(row.github_workflow_id, 'github_workflow_id'),
          repositoryId: repositoryId(identifier(row.github_repository_id, 'github_repository_id')),
          name: requiredString(row.workflow_name, 'workflow_name'),
          path: requiredString(row.workflow_path, 'workflow_path'),
          state: optionalString(row.workflow_state) ?? 'unknown',
        }
        break
      case 'run': {
        const githubRunId = identifier(row.github_run_id, 'github_run_id')
        const attempt = positiveInteger(row.run_attempt, 'run_attempt')
        data = {
          githubRunId,
          attempt,
          repositoryId: repositoryId(identifier(row.github_repository_id, 'github_repository_id')),
          workflowId: workflowId(identifier(row.github_workflow_id, 'github_workflow_id')),
          event: optionalString(row.run_event) ?? 'unknown',
          status: optionalString(row.run_status) ?? 'unknown',
          conclusion: optionalString(row.run_conclusion) ?? null,
          createdAt: optionalString(row.run_created_at) ?? null,
          startedAt: optionalString(row.run_started_at) ?? null,
          completedAt: optionalString(row.run_completed_at) ?? null,
          headSha: optionalString(row.run_head_sha) ?? null,
          headBranch: optionalString(row.run_head_branch) ?? null,
        }
        break
      }
      case 'job':
        data = {
          githubJobId: identifier(row.github_job_id, 'github_job_id'),
          runId: runId(identifier(row.github_run_id, 'github_run_id'), positiveInteger(row.run_attempt, 'run_attempt')),
          name: requiredString(row.job_name, 'job_name'),
          status: optionalString(row.job_status) ?? 'unknown',
          conclusion: optionalString(row.job_conclusion) ?? null,
          startedAt: optionalString(row.job_started_at) ?? null,
          completedAt: optionalString(row.job_completed_at) ?? null,
        }
        break
      case 'session': {
        const sessionId = sourceId('session', source, sourceRecordId)
        data = {
          id: sessionId,
          runId: runId(identifier(row.github_run_id, 'github_run_id'), positiveInteger(row.run_attempt, 'run_attempt')),
          jobId: row.github_job_id === undefined || row.github_job_id === null ? undefined : jobId(identifier(row.github_job_id, 'github_job_id')),
          kind: requiredString(row.session_kind, 'session_kind'),
          status: optionalString(row.session_status) ?? 'unknown',
          startedAt: optionalString(row.session_started_at) ?? null,
          completedAt: optionalString(row.session_completed_at) ?? null,
        }
        break
      }
      case 'event':
        if (
          row.source_sequence !== undefined &&
          row.source_sequence !== null &&
          (!Number.isInteger(Number(row.source_sequence)) || Number(row.source_sequence) < 0)
        ) {
          throw new TypeError('source_sequence must be a non-negative integer')
        }
        data = {
          sessionId: sourceId('session', source, requiredString(row.session_source_id, 'session_source_id')),
          timestamp: canonicalTimestamp(row.event_timestamp ?? observedAt, 'event_timestamp'),
          source: requiredString(row.event_source, 'event_source'),
          type: requiredString(row.event_type, 'event_type'),
          summary: optionalString(row.event_summary),
          correlationId: optionalString(row.correlation_id),
          payloadRef: optionalString(row.payload_ref),
          sourceSequence: row.source_sequence === undefined || row.source_sequence === null ? undefined : Number(row.source_sequence),
        }
        break
      default:
        throw new TypeError(`Unsupported SQL export entity kind: ${kind}`)
    }

    observations.push({
      kind: /** @type {import('../model/schema.js').EntityKind} */ (kind),
      source,
      sourceId: sourceRecordId,
      observedAt,
      data,
    })
  }

  return { generation, observations }
}
