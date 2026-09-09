/**
 * Declarative experiment view composition primitives.
 */

import { isExperimentViewSection } from './experiment-view-sections.js'
import { defaultExperimentsViewComposition, experimentsViewCompositionForBody } from './experiments-view-primitives.js'

/**
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {Array<ReturnType<typeof experimentsViewCompositionForBody>>}
 */
export function experimentsViewComposition(config) {
  if (Array.isArray(config?.sections)) {
    const sections = config.sections.filter(isExperimentViewSection).map((section) => experimentsViewCompositionForBody(section))
    return sections.length > 0 ? sections : defaultExperimentsViewComposition()
  }
  return [experimentsViewCompositionForBody(config?.body)]
}
