import { h } from '../dom.js';
import { effect, render } from '../reactive.js';
import { browserFirstLoad } from '../browser-first-load.js';
import { renderFactoryElement } from './factory-elements.js';
import { renderFactoryRhythm } from './factory-rhythm.js';
import { createDebug } from '../debug.js';

/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ signal: AbortSignal }} HeaderScope */

const debugFactoryHeader = createDebug('factory-header');

/**
 * @param {SourceBindings} sources
 * @param {HeaderScope} scope
 * @param {Record<string, string>} roleNames
 * @param {boolean} [showFirstLoad]
 */
export function renderFactoryHeader(sources, scope, roleNames, showFirstLoad = false) {
  debugFactoryHeader({
    event: 'composed',
    presentationSource: roleNames.presentation,
    rhythmSource: roleNames.rhythm
  });
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p');
  const firstLoadStatus = () => showFirstLoad ? browserFirstLoad.get().status : 'inactive';

  render(heading, () => {
    const presentation = sources[roleNames.presentation];
    const initialStatus = firstLoadStatus();
    const pending = initialStatus === 'inactive' && presentation.pending();
    const unavailable = presentation.unavailable();
    const candidate = presentation.rows()[0]?.heading;
    const hasHeading = !pending && !unavailable && typeof candidate === 'string' && Boolean(candidate);
    heading.classList.toggle('factory-heading-pending', pending);
    if (pending || initialStatus === 'loading') heading.setAttribute('aria-busy', 'true');
    else heading.removeAttribute('aria-busy');
    if (!pending) debugFactoryHeader({ event: 'heading-settled', unavailable, hasHeading });
    return initialStatus === 'loading'
      ? 'Your dashboard is taking shape.'
      : initialStatus === 'failed'
      ? 'Your dashboard import is incomplete.'
      : pending
      ? ''
      : hasHeading
      ? candidate
      : 'Your campaign status is unavailable.';
  }, { signal: scope.signal });

  render(summary, () => {
    const presentation = sources[roleNames.presentation];
    const initialStatus = firstLoadStatus();
    const pending = presentation.pending();
    const candidate = presentation.rows()[0]?.summary;
    const text = initialStatus === 'loading'
      ? 'We are preparing the first activity snapshot in this browser. Campaign status will appear when the import is complete.'
      : initialStatus === 'failed'
      ? 'Campaign status is not available yet.'
      : typeof candidate === 'string' ? candidate : '';
    summary.hidden = initialStatus === 'inactive' && (pending || !text);
    if (!pending) debugFactoryHeader({ event: 'summary-settled', hasSummary: Boolean(text) });
    return initialStatus === 'inactive' && pending ? '' : text;
  }, { signal: scope.signal });

  const rhythm = renderFactoryRhythm(sources[roleNames.rhythm], scope);
  const header = h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, heading, summary),
    rhythm
  );
  effect(() => {
    const initialStatus = firstLoadStatus();
    rhythm.hidden = initialStatus !== 'inactive';
    header.classList.toggle('factory-intro-importing', initialStatus !== 'inactive');
  }, { signal: scope.signal });
  return header;
}

/**
 * Default role-to-source-name bindings for the overview page. A view may
 * override any entry through `config.sources` to bind the same element to
 * differently named sources.
 * @type {Record<string, string>}
 */
export const HEADER_DEFAULT_SOURCES = {
  presentation: 'overview-header-presentation',
  rhythm: 'overview-rhythm'
};

/**
 * Renders the JSON-selected factory header from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryHeaderElement(context) {
  return renderFactoryElement(
    context,
    HEADER_DEFAULT_SOURCES,
    (roleNames) => Object.values(roleNames),
    (sources, scope, roleNames) => renderFactoryHeader(
      sources, scope, roleNames, context.elementConfig?.['browser-first-load'] === true
    )
  );
}
