/**
 * Shared declarative agent-marketplace view composition primitives.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';

/** @typedef {'toolbar'|'tiles'} AgentMarketplaceBody */

export const AGENT_MARKETPLACE_BODY_VALUES = /** @type {const} */ (['toolbar', 'tiles']);

const AGENT_MARKETPLACE_CONFIG = createElementCompositionConfig(
  AGENT_MARKETPLACE_BODY_VALUES,
  /** @type {AgentMarketplaceBody} */ ('tiles')
);

/**
 * @typedef {{
 *   key: AgentMarketplaceBody,
 *   className: string
 * }} AgentMarketplaceComposition
 */

const AGENT_MARKETPLACE_COMPOSITIONS = /** @type {Readonly<Record<AgentMarketplaceBody, AgentMarketplaceComposition>>} */ ({
  toolbar: { key: 'toolbar', className: 'agent-marketplace-toolbar' },
  tiles: { key: 'tiles', className: 'agent-marketplace-grid' }
});

/**
 * @param {unknown} body
 * @returns {AgentMarketplaceComposition}
 */
export function agentMarketplaceCompositionForBody(body) {
  return selectElementComposition(AGENT_MARKETPLACE_COMPOSITIONS, AGENT_MARKETPLACE_CONFIG, body);
}

/**
 * @returns {AgentMarketplaceComposition[]}
 */
export function defaultAgentMarketplaceComposition() {
  return AGENT_MARKETPLACE_BODY_VALUES.map((body) => agentMarketplaceCompositionForBody(body));
}
