/**
 * Backward-compatible entry point for the shared experiment decision surface.
 */

export {
  buildExperimentDecisionModel as buildModel,
  filterExperimentRows,
  initialExperimentFilters,
  renderExperimentDecisionEmptyState,
  renderExperimentDecisionSurface,
  renderExperimentDecisionSurfaceSection,
  renderExperimentFilters,
  syncExperimentDecisionDeepLink,
} from './experiment-decision-surface.js'
