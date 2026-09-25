/**
 * Registry for JSON-selected dashboard UI elements.
 */

import { renderCampaignRouteView } from './campaign-route-view.js';
import { text as stringValue } from './count-formatters.js';
import { renderConfigurationView } from './configuration-view.js';
import { renderEntityRoute } from './entity-route.js';
import { renderFactoryFloorElement } from './factory-floor.js';
import { renderFactoryHeaderElement } from './factory-header.js';
import { renderLinkButtonList } from './link-button-list.js';
import { renderMeasureHistory } from './measure-history.js';
import { renderOutcomeDetail } from './outcome-detail.js';
import { isOutcomeDetailSectionConfig, renderOutcomeDetailSection } from './outcome-detail-sections.js';
import { renderProblemDetail } from './problem-detail.js';
import { rowsFor as rowsForSource } from './source-rows.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';

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
 *   elementConfig?: { body?: string, sections?: string[], stations?: string[], section?: string, labels?: Record<string, unknown>, animate?: string, 'view-all-page'?: string, 'view-all-label'?: string, 'label-field'?: string, 'link-field'?: string, 'icon-field'?: string, 'fallback-icon'?: string, 'indicator-field'?: string, 'indicator-label-field'?: string, 'empty-message'?: string, 'measure-source'?: 'operational-value'|'operational-grader' },
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
  ['problem-detail', renderProblemDetail],
  ['configuration-policy', renderConfigurationView],
  ['entity-route', renderEntityRoute],
  ['measure-history', renderMeasureHistory],
  ['factory-header', renderFactoryHeaderElement],
  ['factory-floor', renderFactoryFloorElement],
  ['link-button-list', renderLinkButtonList]
]);

/** Elements that load declared sources independently of the active page subscription. */
const ASYNC_SOURCE_ELEMENTS = new Set(['factory-header', 'factory-floor', 'link-button-list']);

/**
 * Reports whether an element loads its declared sources on its own.
 * @param {string} name
 * @returns {boolean}
 */
export function elementLoadsSourcesAsync(name) {
  return ASYNC_SOURCE_ELEMENTS.has(name);
}

const EMPTY_AWARE_ELEMENTS = new Set([
  'campaign-route',
  'workflow-route-page',
  'outcome-detail',
  'outcome-detail-section',
  'problem-detail',
  'configuration-policy',
  'entity-route',
  'measure-history',
  'factory-header',
  'factory-floor',
  'link-button-list'
]);
const UNAVAILABLE_AWARE_ELEMENTS = new Set(['configuration-policy']);

/**
 * Builds a lazy element renderer that dynamically imports a module on first
 * use and delegates rendering to it, avoiding an eagerly bundled dependency
 * for elements that are not always present on a page.
 * @template {Record<string, unknown>} Module
 * @param {() => Promise<Module>} importModule
 * @param {(module: Module, context: ElementRenderContext) => HTMLElement | null} render
 * @returns {(context: ElementRenderContext) => Promise<HTMLElement | null>}
 */
function lazyElementRenderer(importModule, render) {
  return async (context) => render(await importModule(), context);
}

/** @type {Map<string, (context: ElementRenderContext) => Promise<HTMLElement | null>>} */
const LAZY_ELEMENT_RENDERERS = new Map([
  ['campaign-route-lazy', lazyElementRenderer(
    () => import('./campaign-route-view.js'),
    ({ renderCampaignRouteView }, context) => renderCampaignRouteView(context)
  )],
  ['workflow-route-page-lazy', lazyElementRenderer(
    () => import('./workflow-route-page.js'),
    ({ renderWorkflowRoutePage }, context) => renderWorkflowRoutePage(context)
  )]
]);

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
  const lazyRenderer = LAZY_ELEMENT_RENDERERS.get(`${name}-lazy`);
  if (lazyRenderer) return lazyRenderer({ ...context, element: name });
  return renderUiElement(name, context);
}

/**
 * @param {ElementRenderContext} context
 * @returns {HTMLElement | null}
 */
function renderOutcomeDetailSectionElement(context) {
  const outcomes = rowsFor(context, 'outcomes');
  const sectionConfig = isOutcomeDetailSectionConfig(context.elementConfig)
    ? context.elementConfig
    : null;
  if (!sectionConfig) return null;
  const outcomeId = stringValue(context.scope?.['safe-output']);
  const outcome = outcomes.find((row) => String(row['safe-output']) === outcomeId);
  return outcome ? renderOutcomeDetailSection(outcome, sectionConfig.body) : null;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function elementHandlesEmptyRows(name) {
  return EMPTY_AWARE_ELEMENTS.has(name);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function elementHandlesUnavailableSource(name) {
  return UNAVAILABLE_AWARE_ELEMENTS.has(name);
}

/**
 * @param {ElementRenderContext} context
 * @param {string} sourceName
 */
function rowsFor(context, sourceName) {
  return rowsForSource(context.sources, sourceName);
}
