/**
 * Campaign route composition registry shared by declarative route views.
 */

import { titleCase } from './count-formatters.js';
import { createRouteBodyConfig } from './route-body-config.js';
import {
  CAMPAIGN_ROUTE_ALIASES,
  CAMPAIGN_ROUTE_BODY_VALUES,
  CAMPAIGN_ROUTE_DEFAULT_BODY,
  CAMPAIGN_ROUTE_VARIANT_VALUES
} from './route-body-specification.js';
import { renderCampaignMemory } from './campaign-memory.js';
import { createDebug } from '../debug.js';

const debugCampaignRouteComposition = createDebug('campaign-route-composition');

/**
 * @typedef {'overview'|'workflows'|'runs'|'issues'|'repositories'|'insights'|'problems'|'reports'|'memory'|'dispatches'} CampaignRouteBody
 */

/**
 * @typedef {'overview'|'workflows'|'runs'|'issues'|'repositories'|'insights'|'problems'|'reports'|'memory'} CampaignRouteTab
 */

/**
 * @typedef {{
 *   rootClassName: string,
 *   selectMessage: string,
 *   description: string,
 *   currentTab: CampaignRouteTab,
 *   bodyRenderer: CampaignRouteBodyRenderer | undefined
 * }} CampaignRouteComposition
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   campaignId: string,
 *   campaignName: string,
 *   workflows: Array<Record<string, unknown>>
 * }) => HTMLElement | null} CampaignRouteBodyRenderer
 */

/** @type {Readonly<Record<CampaignRouteTab, CampaignRouteComposition>>} */
const CAMPAIGN_ROUTE_COMPOSITIONS = {
  overview: {
    rootClassName: 'campaign-detail',
    selectMessage: 'Select a campaign to view its overview.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'overview',
    bodyRenderer: undefined
  },
  workflows: {
    rootClassName: 'campaign-workflows',
    selectMessage: 'Select a campaign to view its workflows.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'workflows',
    bodyRenderer: undefined
  },
  issues: {
    rootClassName: 'campaign-issues',
    selectMessage: 'Select a campaign to view its generated issues.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'issues',
    bodyRenderer: undefined
  },
  runs: {
    rootClassName: 'campaign-runs',
    selectMessage: 'Select a campaign to view its workflow runs.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'runs',
    bodyRenderer: undefined
  },
  repositories: {
    rootClassName: 'campaign-repositories',
    selectMessage: 'Select a campaign to view its repositories.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'repositories',
    bodyRenderer: undefined
  },
  insights: {
    rootClassName: 'campaign-insights',
    selectMessage: 'Select a campaign to view its operational value.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'insights',
    bodyRenderer: undefined
  },
  problems: {
    rootClassName: 'campaign-problems',
    selectMessage: 'Select a campaign to view its current problems.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'problems',
    bodyRenderer: undefined
  },
  reports: {
    rootClassName: 'campaign-reports',
    selectMessage: 'Select a campaign to view its reports.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'reports',
    bodyRenderer: undefined
  },
  memory: {
    rootClassName: 'campaign-memory',
    selectMessage: 'Select a campaign to browse its repository memory.',
    description: 'Repository memory published for the {campaignName} campaign.',
    currentTab: 'memory',
    bodyRenderer: ({ campaignId, campaignName }) => renderCampaignMemory({ campaignId, campaignName })
  }
};

export const CAMPAIGN_ROUTE_BODY_CONFIG = createRouteBodyConfig(
  /** @type {readonly CampaignRouteTab[]} */ (CAMPAIGN_ROUTE_BODY_VALUES.filter((body) => !Object.hasOwn(CAMPAIGN_ROUTE_ALIASES, body))),
  /** @type {CampaignRouteTab} */ (CAMPAIGN_ROUTE_DEFAULT_BODY)
);

/**
 * @param {unknown} body
 * @returns {CampaignRouteComposition}
 */
export function campaignRouteComposition(body) {
  const selected = typeof body === 'string' && Object.hasOwn(CAMPAIGN_ROUTE_ALIASES, body)
    ? CAMPAIGN_ROUTE_ALIASES[/** @type {keyof typeof CAMPAIGN_ROUTE_ALIASES} */ (body)]
    : body;
  const resolved = /** @type {CampaignRouteComposition} */ (CAMPAIGN_ROUTE_BODY_CONFIG.composition(CAMPAIGN_ROUTE_COMPOSITIONS, selected));
  debugCampaignRouteComposition({
    event: 'composition-resolved',
    tab: resolved.currentTab,
    fellBackToDefault: resolved.currentTab !== selected
  });
  return resolved;
}

/**
 * @param {unknown} body
 * @returns {CampaignRouteBody}
 */
export function campaignRouteVariant(body) {
  const selected = typeof body === 'string' && Object.hasOwn(CAMPAIGN_ROUTE_ALIASES, body)
    ? CAMPAIGN_ROUTE_ALIASES[/** @type {keyof typeof CAMPAIGN_ROUTE_ALIASES} */ (body)]
    : body;
  return CAMPAIGN_ROUTE_BODY_CONFIG.body(selected);
}

/**
 * @param {unknown} body
 * @returns {body is CampaignRouteBody}
 */
export function isCampaignRouteVariant(body) {
  return typeof body === 'string' && CAMPAIGN_ROUTE_VARIANT_VALUES.includes(/** @type {CampaignRouteBody} */ (body));
}

/**
 * @param {string} campaignId
 * @param {Array<Record<string, unknown>>} workflows
 */
export function campaignNameForRoute(campaignId, workflows) {
  return String(workflows.find((workflow) => typeof workflow['campaign-name'] === 'string')?.['campaign-name'] ?? titleCase(campaignId));
}

/**
 * @param {unknown} value
 */
export function normalizeCampaignRoute(value) {
  if (typeof value !== 'string') return '';
  const campaignId = value.trim();
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(campaignId);
  if (!valid && campaignId) {
    debugCampaignRouteComposition({ event: 'route-rejected', length: campaignId.length });
  }
  return valid ? campaignId : '';
}
