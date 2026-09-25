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
import { renderMeasureHistory } from './measure-history.js';

const CAMPAIGN_OPERATIONAL_VALUE_SOURCES = [
  'campaign-operational-value-primary-series',
  'campaign-operational-value-rollup-series',
  'campaign-operational-value-run-days',
  'campaign-operational-value-repository-run-days',
  'campaign-operational-value-evidence-state'
];

/**
 * @typedef {'overview'|'workflows'|'runs'|'issues'|'repositories'|'insights'|'problems'|'reports'|'dispatches'} CampaignRouteBody
 */

/**
 * @typedef {'overview'|'workflows'|'runs'|'issues'|'repositories'|'insights'|'problems'|'reports'} CampaignRouteTab
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
    selectMessage: 'Select a campaign to view its audit insights.',
    description: 'Operational activity for the {campaignName} campaign.',
    currentTab: 'insights',
    bodyRenderer: ({ context }) => renderMeasureHistory({
      ...context,
      title: 'Repository operational value',
      sourceNames: CAMPAIGN_OPERATIONAL_VALUE_SOURCES,
      elementConfig: {
        ...context.elementConfig,
        'measure-source': 'operational-value',
        'empty-message': 'No repository operational-value observations have been published for this campaign yet.'
      }
    })
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
  return /** @type {CampaignRouteComposition} */ (CAMPAIGN_ROUTE_BODY_CONFIG.composition(CAMPAIGN_ROUTE_COMPOSITIONS, selected));
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

/** @param {Array<Record<string, unknown>>} workflows */
export function campaignModeForRoute(workflows) {
  const targetModes = workflows.flatMap((workflow) => {
    const repository = [workflow.organization, workflow.repository].filter(Boolean).join('/').toLowerCase();
    return (Array.isArray(workflow['campaign-targets']) ? workflow['campaign-targets'] : [])
      .filter((target) => String(target?.repository ?? '').toLowerCase() === repository)
      .map((target) => String(target?.mode ?? '').toLowerCase());
  });
  if (targetModes.includes('live')) return 'live';
  if (targetModes.includes('review')) return 'review';
  const orchestrator = workflows.find((workflow) => workflow['workflow-role'] === 'orchestrator');
  const mode = String(orchestrator?.['rollout-mode'] ?? workflows[0]?.['rollout-mode'] ?? '');
  return mode === 'review' || mode === 'live' ? mode : '';
}

/**
 * @param {unknown} value
 */
export function normalizeCampaignRoute(value) {
  if (typeof value !== 'string') return '';
  const campaignId = value.trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(campaignId) ? campaignId : '';
}
