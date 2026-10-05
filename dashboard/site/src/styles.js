/**
 * GitHub Primer CSS tokens and element styles cloned from CAO dashboard.
 */

import { createDebug } from './debug.js';
import { notificationStyles } from './styles-notifications.js';
import { primerStyles } from './styles-primer.js';

const debug = createDebug('styles');

/**
 * Minifies a CSS string while preserving the contents of double-quoted
 * strings (e.g. `content: "Segoe UI"`, font-family lists) untouched. Strips
 * comments, collapses whitespace runs, and removes whitespace around
 * structural punctuation to reduce the bytes shipped in the inlined
 * `<style>` element (Lighthouse "Minify CSS" / "Reduce unused CSS" audits).
 * @param {string} css
 * @returns {string}
 */
function minifyCss(css) {
  const startedAt = Date.now();
  /** @type {string[]} */
  const strings = [];
  const masked = css.replace(/"[^"]*"/g, (match) => {
    strings.push(match);
    return `@@CSS_STR_${strings.length - 1}@@`;
  });
  const minified = masked
    .replace(/\/\*[^]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ *([{};]) */g, '$1')
    .replace(/: /g, ':')
    .replace(/;}/g, '}')
    .trim();
  const result = minified.replace(/@@CSS_STR_(\d+)@@/g, (_match, index) => strings[Number(index)]);
  debug({
    event: 'minified',
    inputLength: css.length,
    outputLength: result.length,
    durationMs: Date.now() - startedAt
  });
  return result;
}

/**
 * CSS injected for toast-style dashboard notifications, minified to reduce
 * the bytes shipped in the inlined `<style>` element.
 * @returns {string}
 */
export function notificationStylesheet() {
  return minifyCss(notificationStyles);
}

/**
 * GitHub Primer CSS tokens and element styles, minified to reduce the bytes
 * shipped in the inlined `<style>` element (Lighthouse "Minify CSS" audit).
 * @returns {string}
 */
export function primerStylesheet() {
  return minifyCss(primerStyles);
}

export const getPrimerStyles = primerStylesheet;
