/**
 * Resolves the Octicon and tone that present an entity card's observed status,
 * driven by JSON configuration so run, job, and session status vocabularies stay
 * data-driven rather than hardcoded in renderers.
 */

import { createDebug } from '../debug.js';
import cardStatusIcons from './card-status-icons.json' with { type: 'json' };

const debugCardStatus = createDebug('card-status');

/**
 * @param {unknown} value observed status or conclusion value
 * @returns {{ icon: string, tone: string, text: string } | null} resolved
 * presentation, or null when no status value was observed
 */
export function resolveCardStatus(value) {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[\s_]+/g, '-');
  const matched = normalized in cardStatusIcons.values;
  const resolved = matched
    ? cardStatusIcons.values[/** @type {keyof typeof cardStatusIcons.values} */ (normalized)]
    : cardStatusIcons.default;
  debugCardStatus({ event: 'resolved', normalized, matched, tone: resolved.tone });
  return { icon: resolved.icon, tone: resolved.tone, text };
}
