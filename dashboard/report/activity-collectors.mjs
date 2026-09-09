import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectAicUsage } from './aic-usage.mjs'
import { collectOperationalValues } from './operational-values.mjs'
import { writeDashboardRecords } from './records.mjs'
import { setActionsGlobals } from '../../activity/actions-context.mjs'
import { actionsLog as log } from '../../activity/actions-log.mjs'

let recordTelemetry

async function telemetry(phase, name, outcome) {
  const script = process.env.GITHUB_TELEMETRY
  if (!script) return
  try {
    if (!recordTelemetry) {
      const telemetryModule = await import(
        pathToFileURL(path.resolve(script)).href
      )
      if (typeof telemetryModule.recordGithubTelemetry !== 'function') {
        throw new Error(
          'GitHub telemetry module does not export recordGithubTelemetry',
        )
      }
      recordTelemetry = telemetryModule.recordGithubTelemetry
    }
    await recordTelemetry({
      phase,
      operation: name,
      ...(outcome === undefined ? {} : { outcome }),
    })
  } catch {
    // Telemetry must not affect collection.
  }
}

export async function collectActivity() {
  let failed = false
  const collectors = [
    ['aic-usage', collectAicUsage],
    ['operational-values', collectOperationalValues],
    ['dashboard-records', writeDashboardRecords],
  ]
  log.info`Running ${collectors.length} activity collectors: ${collectors.map(([name]) => name).join(', ')}`
  for (const [name, collector] of collectors) {
    log.info`Starting ${name} collector`
    await telemetry('before', `collect-${name}`)
    const started = Date.now()
    try {
      await collector()
      await telemetry('after', `collect-${name}`, 'success')
      log.info`Finished ${name} collector in ${Date.now() - started}ms`
    } catch (error) {
      failed = true
      await telemetry('after', `collect-${name}`, 'failure')
      log.error`${name} collection failed after ${Date.now() - started}ms: ${error.stack || error.message || error}`
    }
  }
  log.info`Activity collection complete; ${failed ? 'one or more collectors failed' : 'all collectors succeeded'}`
  if (failed) throw new Error('One or more activity collectors failed')
}

export async function main(actions = {}) {
  setActionsGlobals(actions)
  await collectActivity()
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`
    process.exitCode = 1
  })
}
