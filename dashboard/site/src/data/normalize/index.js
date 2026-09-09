import { jobId, repositoryId, runId, sourceId, workflowId } from '../model/ids.js'
import { canonicalTimestamp, requiredString } from '../model/schema.js'

/** @type {Record<import('../model/schema.js').EntityKind, keyof import('../model/schema.js').CanonicalBatch>} */
const COLLECTIONS = {
  repository: 'repositories',
  workflow: 'workflows',
  run: 'runs',
  job: 'jobs',
  session: 'sessions',
  event: 'events',
  'work-item': 'workItems',
  finding: 'findings',
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requiredIdentifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(`${field} is required`)
  }
  return value
}

/** @param {Record<string, unknown>} value */
function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}

/** @param {import('../model/schema.js').CanonicalObservation} observation */
function identityFor(observation) {
  const data = observation.data
  if (typeof data.id === 'string' && data.id.trim()) return data.id.trim()
  switch (observation.kind) {
    case 'repository':
      return repositoryId(requiredIdentifier(data.githubId, 'repository.githubId'))
    case 'workflow':
      return workflowId(requiredIdentifier(data.githubId, 'workflow.githubId'))
    case 'run':
      return runId(requiredIdentifier(data.githubRunId, 'run.githubRunId'), requiredIdentifier(data.attempt, 'run.attempt'))
    case 'job':
      return jobId(requiredIdentifier(data.githubJobId, 'job.githubJobId'))
    case 'session':
    case 'event':
    case 'work-item':
    case 'finding':
      return sourceId(observation.kind, observation.source, observation.sourceId)
  }
}

/**
 * Sorts from least to most authoritative so deterministic enrichment applies
 * the winning observation last.
 *
 * @param {import('../model/schema.js').CanonicalObservation} left
 * @param {import('../model/schema.js').CanonicalObservation} right
 * @param {Record<string, number>} precedence
 */
function compareObservations(left, right, precedence) {
  return (
    (precedence[left.source] ?? 0) - (precedence[right.source] ?? 0) ||
    Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
    left.source.localeCompare(right.source) ||
    left.sourceId.localeCompare(right.sourceId) ||
    JSON.stringify(left.data).localeCompare(JSON.stringify(right.data))
  )
}

/**
 * @param {Record<string, unknown>[]} events
 * @returns {Record<string, unknown>[]}
 */
function orderEvents(events) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const bySession = new Map()
  for (const event of events) {
    const sessionId = requiredString(event.sessionId, 'event.sessionId')
    const sessionEvents = bySession.get(sessionId) ?? []
    sessionEvents.push(event)
    bySession.set(sessionId, sessionEvents)
  }
  return [...bySession.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, sessionEvents]) =>
      sessionEvents
        .sort((left, right) => {
          const sameSource = left.source === right.source
          const leftSequence = Number(left.sourceSequence)
          const rightSequence = Number(right.sourceSequence)
          if (sameSource && Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) {
            const difference = leftSequence - rightSequence
            if (difference) return difference
          }
          return String(left.timestamp).localeCompare(String(right.timestamp)) || String(left.id).localeCompare(String(right.id))
        })
        .map((event, sequence) => ({ ...event, sequence })),
    )
}

/**
 * Purely converts source-neutral observations into deterministic canonical
 * entities. Persistence is intentionally a separate boundary.
 *
 * @param {import('../model/schema.js').CanonicalObservation[]} observations
 * @param {{ generation: string, sourcePrecedence?: Record<string, number> }} options
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
export function normalize(observations, options) {
  const generation = requiredString(options?.generation, 'generation')
  const sourcePrecedence = options.sourcePrecedence ?? {}
  /** @type {Record<keyof import('../model/schema.js').CanonicalBatch, Map<string, Record<string, unknown>>>} */
  const entities = {
    repositories: new Map(),
    workflows: new Map(),
    runs: new Map(),
    jobs: new Map(),
    sessions: new Map(),
    events: new Map(),
    workItems: new Map(),
    findings: new Map(),
  }

  const sorted = [...observations].sort((left, right) => compareObservations(left, right, sourcePrecedence))
  for (const observation of sorted) {
    const collection = COLLECTIONS[observation.kind]
    if (!collection) throw new TypeError(`Unsupported observation kind: ${observation.kind}`)
    const observedAt = canonicalTimestamp(observation.observedAt, 'observation.observedAt')
    const id = identityFor(observation)
    const current = entities[collection].get(id) ?? {}
    entities[collection].set(id, {
      ...current,
      ...withoutUndefined(observation.data),
      id,
      observedAt,
      generation,
      provenance: {
        source: observation.source,
        sourceId: observation.sourceId,
        observedAt,
      },
    })
  }

  const batch = /** @type {import('../model/schema.js').CanonicalBatch} */ (
    Object.fromEntries(
      Object.entries(entities).map(([collection, records]) => [
        collection,
        [...records.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      ]),
    )
  )
  batch.events = orderEvents(batch.events)
  return batch
}
