/**
 * Declarative composition primitives for agent marketplace views.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';
import { AGENT_MARKETPLACE_BODY_VALUES } from './route-body-specification.js';

const AGENT_MARKETPLACE_CONFIG = createElementCompositionConfig(AGENT_MARKETPLACE_BODY_VALUES, 'grid');

const AGENT_MARKETPLACE_COMPOSITIONS = /** @type {const} */ ({
  toolbar: {
    body: 'toolbar',
    rootClassName: 'agent-marketplace-toolbar-shell'
  },
  grid: {
    body: 'grid',
    rootClassName: 'agent-marketplace-grid-shell'
  }
});

/**
 * @typedef {'toolbar'|'grid'} AgentMarketplaceBody
 */

/**
 * @param {unknown} selected
 * @returns {{ body: AgentMarketplaceBody, rootClassName: string }}
 */
export function agentMarketplaceComposition(selected) {
  return selectElementComposition(AGENT_MARKETPLACE_COMPOSITIONS, AGENT_MARKETPLACE_CONFIG, selected);
}
