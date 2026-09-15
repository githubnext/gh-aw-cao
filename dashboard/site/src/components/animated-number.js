import { h } from '../dom.js';
import { render, state } from '../reactive.js';

/**
 * @param {{ animate?: boolean, signal?: AbortSignal }} [options]
 * @returns {{ element: HTMLElement, set: (value: { text: string, target?: number, href?: string }) => void }}
 */
export function createAnimatedNumber(options = {}) {
  const value = state(/** @type {{ text: string, target?: number, href?: string }} */ ({ text: '' }));
  const element = h('strong', {});

  render(element, () => {
    const next = value.get();
    const animated = options.animate === true && Number.isSafeInteger(next.target);
    const number = h('span', {
      className: animated ? 'metric-number-animated' : '',
      ...(animated ? { dataset: { key: next.target }, style: `--metric-number-target: ${next.target}` } : {})
    }, next.text);
    return next.href ? h('a', { href: next.href }, number) : number;
  }, { signal: options.signal });

  return {
    element,
    set(next) {
      value.set(next);
    }
  };
}
