import { h } from '../dom.js';
import { render } from '../reactive.js';
import { formatCount } from './count-formatters.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope } from './factory-elements.js';
import { renderFactoryRhythm } from './factory-rhythm.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ usefulOutputs: () => number, deliveredRepositories: () => number }} HeaderMetrics */
/** @typedef {{ signal: AbortSignal }} HeaderScope */

/**
 * @param {SourceBindings} sources
 * @param {HeaderMetrics} metrics
 * @param {HeaderScope} scope
 */
export function renderFactoryHeader(sources, metrics, scope) {
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  render(heading, () => {
    const status = sources['overview-factory-status'];
    const pending = status.pending();
    const candidate = status.rows()[0]?.['factory-heading'];
    heading.classList.toggle('factory-heading-pending', pending);
    heading.toggleAttribute('aria-busy', pending);
    return pending
      ? ''
      : !status.unavailable() && typeof candidate === 'string' && candidate
      ? candidate
      : 'Your factory status is unavailable.';
  }, { signal: scope.signal });

  render(summary, () => {
    const pending = sources['overview-outcome-summary']?.pending() ?? false;
    const usefulOutputs = metrics.usefulOutputs();
    const deliveredRepositories = metrics.deliveredRepositories();
    summary.hidden = pending || usefulOutputs === 0;
    return !pending && usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : '';
  }, { signal: scope.signal });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, heading, summary),
    renderFactoryRhythm(sources['overview-rhythm'], scope)
  );
}

const HEADER_SOURCE_NAMES = [
  'overview-outcome-summary',
  'overview-factory-status',
  'overview-rhythm'
];

/**
 * Renders the JSON-selected factory header from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryHeaderElement(context) {
  const sources = bindFactorySources(context.sources, HEADER_SOURCE_NAMES, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const metrics = createFactoryMetrics(sources);
  const scope = createFactoryScope(metrics);
  const rendered = renderFactoryHeader(sources, metrics, scope);
  scope.bind(rendered);
  return rendered;
}
