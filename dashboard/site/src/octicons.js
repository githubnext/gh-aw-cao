/**
 * GitHub Octicon and brand elements.
 */

import { h } from './dom.js';
import { OCTICON_SPRITE } from './octicon-sprite.js';
import octiconNames from './octicon-names.json' with { type: 'json' };
import { createFactoryScope } from './components/factory-elements.js';
import { createDebug, diagnosticErrorName } from './debug.js';

const debugOcticons = createDebug('octicons');

/** @param {string} content */
function parseSymbols(content) {
  const sprite = new DOMParser().parseFromString(content, 'image/svg+xml');
  if (sprite.querySelector('parsererror')) throw new Error('The Octicon sprite is invalid.');
  const symbols = new Map([...sprite.querySelectorAll('symbol')].map((symbol) => [
    symbol.id.replace(/^octicon-/, ''),
    symbol
  ]));
  debugOcticons({ event: 'sprite-parsed', symbolCount: symbols.size });
  return symbols;
}

/**
 * @param {{ sprite: string, names: string[], loadSprite: () => Promise<string>, onError: (error: unknown) => void }} options
 */
export function createOcticonRenderer({ sprite, names, loadSprite, onError }) {
  /** @type {Map<string, Element> | undefined} */
  let symbols;
  /** @type {Promise<Map<string, Element>> | undefined} */
  let loading;
  const supported = new Set(names);
  /** @param {string} name @param {string} [className] @returns {SVGElement} */
  return (name, className = '') => {
    if (name !== 'issue') symbols ??= parseSymbols(sprite);
    const resolved = symbols?.get(name);
    let glyphs;
    if (name === 'issue') {
      glyphs = [h('path', {
        d: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm-.75-9.25a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0ZM8 9.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'
      })];
    } else {
      const symbol = resolved ?? symbols?.get('question');
      if (!symbol) throw new Error('The fallback Octicon is missing.');
      if (!resolved && !supported.has(name)) debugOcticons({ event: 'fallback-used', requestedName: name });
      glyphs = [...symbol.childNodes].map((node) => document.importNode(node, true));
    }
    const rendered = /** @type {SVGElement} */ (/** @type {unknown} */ (h(
      'svg',
      {
        className: `octicon octicon-${name}${className ? ` ${className}` : ''}`,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false'
      },
      ...glyphs
    )));
    if (!resolved && name !== 'issue' && supported.has(name)) {
      const lifetime = new AbortController();
      const scope = createFactoryScope({ signal: lifetime.signal });
      scope.bind(rendered);
      rendered.dataset.iconState = 'loading';
      loading ??= loadSprite().then((content) => {
        const complete = parseSymbols(content);
        if ([...supported].some((name) => !complete.has(name))) throw new Error('The Octicon sprite is incomplete.');
        symbols = complete;
        return complete;
      }).catch((error) => {
        onError(error);
        throw error;
      });
      void loading.then((complete) => {
        if (scope.signal.aborted) return;
        const symbol = complete.get(name);
        if (!symbol) throw new Error('The requested Octicon is missing.');
        rendered.replaceChildren(...[...symbol.childNodes].map((node) => rendered.ownerDocument.importNode(node, true)));
        rendered.dataset.iconState = 'available';
      }, () => {
        if (!scope.signal.aborted) rendered.dataset.iconState = 'unavailable';
      }).finally(() => lifetime.abort());
    }
    return rendered;
  };
}

export const octicon = createOcticonRenderer({
  sprite: OCTICON_SPRITE,
  names: octiconNames,
  loadSprite: async () => {
    const response = await fetch(new URL(/* @vite-ignore */ './octicons.svg', import.meta.url), { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Octicon sprite request failed: HTTP ${response.status}.`);
    return response.text();
  },
  onError: (error) => {
    debugOcticons({ event: 'sprite-load-failed', errorName: diagnosticErrorName(error) });
    void import('./notification-service.js').then(({ publishNotification }) => {
      publishNotification({ message: 'Some dashboard icons could not be loaded. Reload to retry.', tone: 'warning' });
    }, (error) => {
      console.error('Dashboard icon notification failed.', { errorName: diagnosticErrorName(error) });
    });
  }
});

/**
 * @returns {SVGElement}
 */
export function agenticWorkflowMark() {
  return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
    'svg',
    {
      className: 'sidebar-brand-mark',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      focusable: 'false'
    },
    h('path', {
      d: 'M1 3a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H7v4.063C7 16.355 7.644 17 8.438 17H12.5v-2.5a2 2 0 0 1 2-2H21a2 2 0 0 1 2 2V21a2 2 0 0 1-2 2h-6.5a2 2 0 0 1-2-2v-2.5H8.437A2.939 2.939 0 0 1 5.5 15.562V11.5H3a2 2 0 0 1-2-2Zm2-.5a.5.5 0 0 0-.5.5v6.5a.5.5 0 0 0 .5.5h6.5a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5Zm11.5 11.5a.5.5 0 0 0-.5.5V21a.5.5 0 0 0 .5.5H21a.5.5 0 0 0 .5-.5v-6.5a.5.5 0 0 0-.5-.5Z',
      fill: 'currentColor'
    }),
    h('path', {
      d: 'm17.143 3.15c.083-.222.406-.222.49 0l.58 1.545c.18.48.565.855 1.049 1.023l1.584.566c.228.081.228.396 0 .477l-1.584.566a1.763 1.719 0 0 0-1.05 1.023l-.58 1.545c-.083.223-.406.223-.489 0l-.58-1.545a1.763 1.719 0 0 0-1.049-1.023l-1.584-.566c-.228-.081-.228-.396 0-.477l1.584-.566a1.763 1.719 0 0 0 1.05-1.023Z',
      fill: 'var(--purple)',
      stroke: 'var(--purple)',
      'stroke-width': '.717'
    })
  )));
}
