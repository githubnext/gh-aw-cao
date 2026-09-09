import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { actionsLog as log } from '../../activity/actions-log.mjs'
import {
  mergeOperationalValueRecords,
  operationalValueRunIdentity,
} from './operational-value-history.mjs'

function normalizeResult(selected, result) {
  const value =
    Number.isFinite(result.value) && result.value >= 0 && result.value <= 1
      ? result.value
      : null
  return {
    schemaVersion: 1,
    repository: selected.repository,
    workflowId: selected.workflowId,
    workflowPath: selected.workflowPath || null,
    runId: selected.runId,
    runAttempt: selected.run?.runAttempt || selected.runAttempt || 1,
    runUrl: `https://github.com/${selected.repository}/actions/runs/${selected.runId}`,
    status: result.status || 'unavailable',
    value,
    baselineValue: Number.isFinite(result.baselineValue)
      ? result.baselineValue
      : null,
    deltaFromBaseline: Number.isFinite(result.deltaFromBaseline)
      ? result.deltaFromBaseline
      : null,
    evaluatorDigest: result.implementation?.digest || null,
    observation: result.observation || null,
    observationSource: 'logs-json',
    diagnostics: result.diagnostics || {},
    error: result.error || null,
  }
}

function logsRunId(run) {
  return Number(run?.database_id ?? run?.run_id ?? run?.id)
}

function operationalValueResult(run) {
  const results = run?.graders?.results
  const matches = (Array.isArray(results) ? results : []).filter(
    (result) =>
      result.id === 'operational-value' &&
      result.source === 'operational-value',
  )
  return matches.length === 1 ? matches[0] : null
}

function definitionFromLogsResult(selected, result) {
  const definition =
    result.definition || result.implementation?.definition || {}
  return {
    repository: selected.repository,
    workflowId: selected.workflowId,
    workflowPath: selected.workflowPath,
    evaluatorDigest: result.implementation?.digest || null,
    operationalValue:
      definition.operationalValue || result.operationalValue || null,
    baseline: definition.baseline || result.baseline || null,
    diagnosticMetrics: Array.isArray(definition.diagnostics)
      ? definition.diagnostics
          .filter((series) => series && typeof series === 'object')
          .map((series) => series.metric)
          .filter(Boolean)
      : [],
  }
}

function mergeDefinitions(...definitionSets) {
  const definitions = new Map()
  for (const definition of definitionSets.flat()) {
    const key = `${definition.repository}:${definition.workflowId}:${definition.evaluatorDigest || 'unknown-evaluator'}`
    definitions.set(key, definition)
  }
  return [...definitions.values()]
}

export async function collectOperationalValues() {
  log.group`Collect operational-value observations`
  try {
    const inventoryPath = process.env.REPORT_DEPLOYED_WORKFLOWS
    const logsPath = process.env.REPORT_GH_AW_LOGS
    const outputPath = path.resolve(
      process.env.REPORT_OPERATIONAL_VALUES ||
        '_inventory/operational-values.json',
    )
    // Collection is incremental by default: fall back to the output path
    // itself as the cache so a missing REPORT_VALUE_CACHE cannot cause a
    // previously written snapshot to be silently discarded.
    const cachePath = process.env.REPORT_VALUE_CACHE
      ? path.resolve(process.env.REPORT_VALUE_CACHE)
      : outputPath
    if (!inventoryPath) throw new Error('REPORT_DEPLOYED_WORKFLOWS is required')
    if (!logsPath) throw new Error('REPORT_GH_AW_LOGS is required')

    const generatedAt = new Date().toISOString()
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
    // A missing/unreadable/malformed logs snapshot must not fail the whole
    // collector: an existing REPORT_VALUE_CACHE can still drive output
    // completeness for prior observations, so degrade to an empty snapshot.
    let logs = { runs: [] }
    try {
      const parsed = JSON.parse(await readFile(logsPath, 'utf8'))
      if (!Array.isArray(parsed.runs))
        throw new Error('unsupported gh-aw logs JSON')
      logs = parsed
    } catch (error) {
      log.warning`Treating gh-aw logs JSON at ${logsPath} as empty: ${error.message}`
    }
    log.info`Processing ${logs.runs.length} cached gh-aw log records from ${logsPath}; cache output=${cachePath || 'disabled'}`

    const selectedRuns = []
    const seen = new Set()
    for (const workflow of inventory.workflows || []) {
      if (workflow.operationalValue !== true) continue
      const workflowId = workflow.path
        ?.split('/')
        .at(-1)
        ?.replace(/\.lock\.yml$/, '')
      if (!workflowId) continue
      const runRecords = new Map(
        (workflow.runHealth?.runRecords || []).map((run) => [
          Number(run.runId),
          run,
        ]),
      )
      for (const runId of workflow.runHealth?.runIds || []) {
        const key = `${workflow.repository}:${runId}`
        if (seen.has(key)) continue
        seen.add(key)
        const run = runRecords.get(Number(runId)) || null
        selectedRuns.push({
          repository: workflow.repository,
          runId: Number(runId),
          workflowId,
          workflowPath: workflow.path,
          runAttempt: run?.runAttempt || 1,
          run,
        })
      }
    }

    let cachedRecords = []
    let cachedDefinitions = []
    if (cachePath) {
      try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'))
        if (cached.schemaVersion === 1 && Array.isArray(cached.records)) {
          cachedRecords = cached.records
          cachedDefinitions = Array.isArray(cached.definitions)
            ? cached.definitions
            : []
          log.info`Loaded ${cachedRecords.length} cached operational-value records from ${cachePath}`
        }
      } catch (error) {
        if (error.code === 'ENOENT')
          log.info`No operational-value cache found at ${cachePath}`
        else log.warning`Ignoring operational-value cache: ${error.message}`
      }
    }

    const runsById = new Map(
      logs.runs
        .map((run) => [logsRunId(run), run])
        .filter(([runId]) => Number.isFinite(runId)),
    )
    // Only skip re-processing a run when the cache already holds a non-placeholder
    // record for it (i.e. one with an evaluatorDigest). A prior "unavailable"
    // placeholder (no evaluatorDigest yet) must not block a later logs snapshot
    // from filling in the real observation for that same run.
    const cachedRunKeys = new Set(
      cachedRecords
        .filter((record) => record.evaluatorDigest)
        .map((record) => operationalValueRunIdentity(record))
        .filter(Boolean),
    )
    const currentRecords = []
    const currentDefinitions = []
    let missingRuns = 0
    for (const selected of selectedRuns) {
      if (cachedRunKeys.has(operationalValueRunIdentity(selected))) continue
      const run = runsById.get(selected.runId)
      const result = operationalValueResult(run)
      if (!result) {
        missingRuns += 1
        currentRecords.push({
          ...selected,
          schemaVersion: 1,
          runAttempt: selected.run?.runAttempt || 1,
          runUrl: `https://github.com/${selected.repository}/actions/runs/${selected.runId}`,
          status: 'unavailable',
          value: null,
          observationSource: 'logs-json',
          observation: null,
          reason: run
            ? 'operational-value result not found'
            : 'run not found in gh-aw logs JSON',
        })
        continue
      }
      currentRecords.push(normalizeResult(selected, result))
      currentDefinitions.push(definitionFromLogsResult(selected, result))
    }

    const records = mergeOperationalValueRecords(cachedRecords, currentRecords)
    const evidenceTimes = records
      .map((record) => record.observation?.evidenceAt || record.run?.createdAt)
      .filter(Boolean)
      .sort()
    const output = {
      schemaVersion: 1,
      generatedAt,
      window: {
        startAt: evidenceTimes[0] || inventory.runHealth?.windowStart || null,
        endAt: evidenceTimes.at(-1) || generatedAt,
      },
      complete: missingRuns === 0,
      collectionMode: 'logs-json',
      selectedRuns: selectedRuns.length,
      observedRuns: records.filter((record) => record.observation).length,
      matureRuns: records.filter((record) => record.observation?.mature).length,
      // Retained for compatibility with existing dashboard source consumers.
      regradedRuns: records.filter(
        (record) => record.observationSource === 'regrade',
      ).length,
      pendingRegrades: 0,
      regradeAvailable: false,
      reportsCollected: 0,
      reportsFailed: 0,
      definitions: mergeDefinitions(cachedDefinitions, currentDefinitions),
      records,
    }
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
    if (cachePath && cachePath !== outputPath) {
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, `${JSON.stringify(output, null, 2)}\n`)
      log.info`Updated operational-value cache at ${cachePath}`
    }
    log.info`Collected ${output.observedRuns} operational-value observations from ${output.selectedRuns} cached runs`
  } finally {
    log.endGroup()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  collectOperationalValues().catch((error) => {
    log.error`${error.stack || error.message || error}`
    process.exitCode = 1
  })
}
