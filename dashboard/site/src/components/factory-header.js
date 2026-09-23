import { h } from '../dom.js';
import { render } from '../reactive.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope, resolveFactorySourceNames } from './factory-elements.js';
import { renderFactoryRhythm } from './factory-rhythm.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ campaignHealth: () => number }} HeaderMetrics */
/** @typedef {{ signal: AbortSignal }} HeaderScope */

/**
 * @param {SourceBindings} sources
 * @param {HeaderMetrics} metrics
 * @param {HeaderScope} scope
 * @param {Record<string, string>} roleNames
 */
export function renderFactoryHeader(sources, metrics, scope, roleNames) {
  const heading = h('h2', { id: 'agent-factory-heading' });

  render(heading, () => {
    const status = sources[roleNames.status];
    const pending = status.pending();
    const candidate = status.rows()[0]?.['factory-heading'];
    const healthSourcePending = sources[roleNames['healthy-campaigns']]?.pending() ?? true;
    const campaignHealth = metrics.campaignHealth();
    heading.classList.toggle('factory-heading-pending', pending);
    heading.toggleAttribute('aria-busy', pending);
    return pending
      ? ''
      : !healthSourcePending && campaignHealth > 0 && campaignHealth < 0.66
      ? 'Your campaigns need attention.'
      : !status.unavailable() && typeof candidate === 'string' && candidate
      ? candidate
      : 'Your campaign status is unavailable.';
  }, { signal: scope.signal });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, heading),
    renderFactoryRhythm(sources[roleNames.rhythm], scope)
  );
}

/**
 * Default role-to-source-name bindings for the overview page. A view may
 * override any entry through `config.sources` to bind the same element to
 * differently named sources.
 * @type {Record<string, string>}
 */
export const HEADER_DEFAULT_SOURCES = {
  status: 'overview-factory-status',
  campaigns: 'database-campaign-count',
  'healthy-campaigns': 'overview-healthy-campaign-count',
  rhythm: 'overview-rhythm'
};

/**
 * Renders the JSON-selected factory header from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryHeaderElement(context) {
  const roleNames = resolveFactorySourceNames(HEADER_DEFAULT_SOURCES, context.elementConfig);
  const sources = bindFactorySources(context.sources, Object.values(roleNames), {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const metrics = createFactoryMetrics(sources, roleNames);
  const scope = createFactoryScope(metrics);
  const rendered = renderFactoryHeader(sources, metrics, scope, roleNames);
  scope.bind(rendered);
  return rendered;
}
