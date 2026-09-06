/**
 * Declarative agent-marketplace view composition primitives.
 */

import { agentMarketplaceCompositionForBody, defaultAgentMarketplaceComposition } from './agent-marketplace-primitives.js';

/**
 * @param {{ body?: unknown, sections?: unknown } | undefined} config
 * @returns {Array<ReturnType<typeof agentMarketplaceCompositionForBody>>}
 */
export function agentMarketplaceComposition(config) {
  if (Array.isArray(config?.sections)) {
    const sections = config.sections
      .filter((section) => section === 'toolbar' || section === 'tiles')
      .map((section) => agentMarketplaceCompositionForBody(section));
    return sections.length > 0 ? sections : defaultAgentMarketplaceComposition();
  }
  return [agentMarketplaceCompositionForBody(config?.body)];
}
