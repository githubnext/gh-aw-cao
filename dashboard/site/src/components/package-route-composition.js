/**
 * Package route composition registry shared by declarative route views.
 */

import { h } from '../dom.js'
import { titleCase } from './count-formatters.js'
import { createRouteBodyConfig } from './route-body-config.js'
import { PACKAGE_ROUTE_BODY_VALUES, PACKAGE_ROUTE_VARIANT_VALUES } from './route-body-specification.js'
import { renderPackageReadme } from './package-readme.js'
import { renderWorkflowValueReport } from './workflow-runtime.js'

/**
 * @typedef {'insights'|'workflows'|'dispatches'|'reports'} PackageRouteBody
 */

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: PackageRouteBody,
 *   bodyRenderer: PackageRouteBodyRenderer | undefined
 * }} PackageRouteComposition
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   packageId: string,
 *   packageName: string,
 *   workflows: Array<Record<string, unknown>>
 * }) => HTMLElement | null} PackageRouteBodyRenderer
 */

/** @type {Readonly<Record<PackageRouteBody, PackageRouteComposition>>} */
const PACKAGE_ROUTE_COMPOSITIONS = {
  insights: {
    rootClassName: 'package-insights',
    selectMessage: 'Select a package to view its operational value.',
    description: 'Operational value attained by workers in the {packageName} package.',
    currentTab: 'insights',
    bodyRenderer: ({ context, workflows }) => {
      const workers = workflows.filter((workflow) => workflow['workflow-role'] !== 'orchestrator')
      return h(
        'div',
        { className: 'package-insights-content' },
        ...workers.map((workflow) => renderWorkflowValueReport(context, workflow)),
        workers.length === 0 ? h('p', { className: 'value-details-unavailable' }, 'No worker workflows are configured for this package.') : null,
      )
    },
  },
  workflows: {
    rootClassName: 'package-detail',
    selectMessage: 'Select a package to view its workflows.',
    description: 'Orchestrator and worker workflows in the {packageName} package.',
    currentTab: 'workflows',
    bodyRenderer: ({ packageId, packageName, workflows }) => renderPackageReadme({ packageId, packageName, workflows }),
  },
  dispatches: {
    rootClassName: 'package-dispatches',
    selectMessage: 'Select a package to view its dispatches.',
    description: 'Workflow dispatch runs for the {packageName} package.',
    currentTab: 'dispatches',
    bodyRenderer: undefined,
  },
  reports: {
    rootClassName: 'package-reports',
    selectMessage: 'Select a package to view its reports.',
    description: 'Durable reports produced by the {packageName} package.',
    currentTab: 'reports',
    bodyRenderer: undefined,
  },
}

export const PACKAGE_ROUTE_BODY_CONFIG = createRouteBodyConfig(
  /** @type {readonly PackageRouteBody[]} */ (PACKAGE_ROUTE_BODY_VALUES),
  /** @type {PackageRouteBody} */ ('workflows'),
)

/**
 * @param {unknown} body
 * @returns {PackageRouteComposition}
 */
export function packageRouteComposition(body) {
  return /** @type {PackageRouteComposition} */ (PACKAGE_ROUTE_BODY_CONFIG.composition(PACKAGE_ROUTE_COMPOSITIONS, body))
}

/**
 * @param {unknown} body
 * @returns {PackageRouteBody}
 */
export function packageRouteVariant(body) {
  return PACKAGE_ROUTE_BODY_CONFIG.body(body)
}

/**
 * @param {unknown} body
 * @returns {body is PackageRouteBody}
 */
export function isPackageRouteVariant(body) {
  return typeof body === 'string' && PACKAGE_ROUTE_VARIANT_VALUES.includes(/** @type {PackageRouteBody} */ (body))
}

/**
 * @param {string} packageId
 * @param {Array<Record<string, unknown>>} workflows
 */
export function packageNameForRoute(packageId, workflows) {
  return String(workflows.find((workflow) => typeof workflow['package-name'] === 'string')?.['package-name'] ?? titleCase(packageId))
}

/** @param {Array<Record<string, unknown>>} workflows */
export function packageModeForRoute(workflows) {
  const targetModes = workflows.flatMap((workflow) => {
    const repository = [workflow.organization, workflow.repository].filter(Boolean).join('/').toLowerCase()
    return (Array.isArray(workflow['package-targets']) ? workflow['package-targets'] : [])
      .filter((target) => String(target?.repository ?? '').toLowerCase() === repository)
      .map((target) => String(target?.mode ?? '').toLowerCase())
  })
  if (targetModes.includes('live')) return 'live'
  if (targetModes.includes('review')) return 'review'
  const orchestrator = workflows.find((workflow) => workflow['workflow-role'] === 'orchestrator')
  const mode = String(orchestrator?.['rollout-mode'] ?? workflows[0]?.['rollout-mode'] ?? '')
  return mode === 'review' || mode === 'live' ? mode : ''
}

/**
 * @param {unknown} value
 */
export function normalizePackageRoute(value) {
  if (typeof value !== 'string') return ''
  const packageId = value.trim()
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(packageId) ? packageId : ''
}
