/**
 * Reusable GitHub Primer status and mode badges.
 */

import { h } from '../dom.js';
import { createDebug } from '../debug.js';
import { stringOrFallback } from '../view-formatters.js';

const debugBadge = createDebug('badge');

/**
 * Renders the shared `status <statusClass>` badge markup used by every
 * status-flavored badge in this module.
 * @param {string} statusClass one of the `status-*` class suffixes
 * @param {string} text visible badge label
 * @returns {HTMLElement}
 */
function renderStatusSpan(statusClass, text) {
  return h('span', { className: `status ${statusClass}` }, text);
}

/**
 * @param {unknown} status
 * @returns {HTMLElement}
 */
export function renderStatusBadge(status) {
  const text = stringOrFallback(status, 'unknown');
  const normalized = text.toLowerCase();
  let statusClass = 'status-muted';

  if (['success', 'completed', 'active', 'true', 'fresh', 'available', 'complete', 'accepted', 'healthy', 'trusted', 'matured', 'closed', 'merged', 'resolved', 'no failures observed', 'outcomes observed', 'up-to-date', 'current'].includes(normalized)) {
    statusClass = 'status-success';
  } else if (['in-progress', 'running', 'queued', 'requested', 'waiting', 'pending', 'review', 'partial', 'stale', 'degraded', 'attention', 'warning', 'action-required', 'interim', 'open', 'published', 'approval required', 'disabled workflows', 'update-available', 'update available', 'upgrade recommended'].includes(normalized)) {
    statusClass = 'status-attention';
  } else if (['failure', 'failed', 'rejected', 'danger', 'unavailable', 'insufficient', 'critical', 'timed-out', 'startup-failure', 'needs attention'].includes(normalized)) {
    statusClass = 'status-danger';
  } else {
    debugBadge({ event: 'status-unmatched', normalized, statusClass });
  }

  return renderStatusSpan(statusClass, text);
}

/**
 * @param {unknown} status
 * @returns {HTMLElement}
 */
export function renderGraderStatusBadge(status) {
  const text = stringOrFallback(status, 'unavailable');
  const normalized = text.toLowerCase();
  const statusClass = normalized === 'pass'
    ? 'status-success'
    : ['fail', 'error'].includes(normalized) ? 'status-danger' : 'status-attention';
  if (normalized !== 'pass' && normalized !== 'fail' && normalized !== 'error') {
    debugBadge({ event: 'grader-status-unmatched', normalized, statusClass });
  }
  return renderStatusSpan(statusClass, text);
}

/**
 * Computes the shared `mode-badge` class name suffix for a rollout mode
 * label. Used both by the standalone mode badge and by inline per-repository
 * mode indicators that render their own markup around the same class.
 * @param {string} normalizedMode lowercased mode label
 * @returns {string}
 */
export function modeBadgeClassName(normalizedMode) {
  return normalizedMode === 'live' ? 'mode-live' : normalizedMode === 'review' ? 'mode-review' : '';
}

/**
 * @param {unknown} mode
 * @returns {HTMLElement}
 */
export function renderModeBadge(mode) {
  const text = stringOrFallback(mode, 'unknown');
  const normalized = text.toLowerCase();
  const modeClass = modeBadgeClassName(normalized);
  if (!modeClass) debugBadge({ event: 'mode-unmatched', normalized });

  return h('span', { className: `mode-badge ${modeClass}`.trim() }, text);
}

/**
 * @param {unknown} active
 * @returns {HTMLElement}
 */
export function renderActiveStateBadge(active) {
  const raw = String(active);
  const isActive = raw === 'true' || raw === 'active';
  const statusClass = isActive ? 'status-success' : 'status-muted';
  const text = raw === 'true' ? 'Active' : raw === 'false' ? 'Inactive' : raw;

  return renderStatusSpan(statusClass, text);
}
