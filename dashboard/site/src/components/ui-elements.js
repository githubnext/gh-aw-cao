/**
 * Registry for JSON-selected dashboard UI elements.
 */

import { renderCampaignRouteView } from './campaign-route-view.js';
import { renderOutcomeDetail } from './outcome-detail.js';
import { isOutcomeDetailSectionConfig, renderOutcomeDetailSection } from './outcome-detail-sections.js';
import { renderConfigurationView } from './configuration-view.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';
import { renderFactoryFloorElement } from './factory-floor.js';
import { renderFactoryHeaderElement } from './factory-header.js';
import { renderLinkButtonList } from './link-button-list.js';
import { renderCampaignProblemList } from './campaign-problem-list.js';
import { rowsFor } from './source-rows.js';

/**
 * @typedef {{
 *   pageId: string,
 *   title: string,
 *   description?: string,
 *   sourceNames: string[],
 *   sources: Record<string, import('../presenter.js').LogicalSourceInput>,
 *   contextDetails: string[],
 *   scope?: Record<string, unknown>,
 *   time?: Record<string, unknown>,
 *   routeParameter?: string,
 *   queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string }, viewMode?: 'chart'|'table'|'card' },
 *   titleLink?: Record<string, unknown>,
 *   element?: string,
 *   viewId?: string,
 *   viewIndex?: number,
 *   elementConfig?: { body?: string, sections?: string[], stations?: string[], section?: string, labels?: Record<string, unknown>, animate?: string, 'view-all-page'?: string, 'view-all-label'?: string, 'label-field'?: string, 'link-field'?: string, 'icon-field'?: string, 'fallback-icon'?: string, 'indicator-field'?: string, 'indicator-label-field'?: string, 'empty-message'?: string },
 *   headingTag: 'h3'|'h4'
 * }} ElementRenderContext
 */
export {};

/** @type {Map<string, (context: ElementRenderContext) => HTMLElement | null>} */
const ELEMENT_RENDERERS = new Map([
  ['campaign-route', renderCampaignRouteView],
  ['workflow-route-page', renderWorkflowRoutePage],
  ['outcome-detail', renderOutcomeDetail],
  ['outcome-detail-section', renderOutcomeDetailSectionElement],
  ['configuration-policy', renderConfigurationView],
  ['factory-header', renderFactoryHeaderElement],
  ['factory-floor', renderFactoryFloorElement],
  ['link-button-list', renderLinkButtonList],
  ['campaign-problem-list', renderCampaignProblemList]
]);

const ASYNC_SOURCE_ELEMENTS = new Set(['factory-header', 'factory-floor', 'link-button-list']);
const EMPTY_AWARE_ELEMENTS = new Set([
  'campaign-route',
  'workflow-route-page',
  'outcome-detail',
  'outcome-detail-section',
  'configuration-policy',
  'factory-header',
  'factory-floor',
  'link-button-list',
  'campaign-problem-list'
]);
const UNAVAILABLE_AWARE_ELEMENTS = new Set(['configuration-policy']);

/**
 * Reports whether an element loads its declared sources on its own.
 * @param {string} name
 */
export function elementLoadsSourcesAsync(name) {
  return ASYNC_SOURCE_ELEMENTS.has(name);
}

/**
 * @param {string} name
 * @param {ElementRenderContext} context
 * @returns {HTMLElement | null}
 */
export function renderUiElement(name, context) {
  return ELEMENT_RENDERERS.get(name)?.({ ...context, element: name }) ?? null;
}

/**
 * @param {string} name
 * @param {ElementRenderContext} context
 * @returns {Promise<HTMLElement | null>}
 */
export async function renderUiElementAsync(name, context) {
  return renderUiElement(name, context);
}

/** @param {string} name */
export function elementHandlesEmptyRows(name) {
  return EMPTY_AWARE_ELEMENTS.has(name);
}

/** @param {string} name */
export function elementHandlesUnavailableSource(name) {
  return UNAVAILABLE_AWARE_ELEMENTS.has(name);
}

/**
 * @param {ElementRenderContext} context
 * @returns {HTMLElement | null}
 */
function renderOutcomeDetailSectionElement(context) {
  const sectionConfig = isOutcomeDetailSectionConfig(context.elementConfig)
    ? context.elementConfig
    : null;
  if (!sectionConfig) return null;
  const outcomeId = typeof context.scope?.['safe-output'] === 'string'
    ? context.scope['safe-output'].trim()
    : '';
  const outcome = rowsFor(context.sources, 'outcomes')
    .find((row) => String(row['safe-output']) === outcomeId);
  return outcome ? renderOutcomeDetailSection(outcome, sectionConfig.body) : null;
}
