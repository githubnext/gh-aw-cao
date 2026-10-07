import { createDebug } from './debug.js';

/** @typedef {'ui' | 'explore' | 'propose' | 'operate'} ActionLevel */
/** @typedef {'ui' | 'prompt' | 'cli' | 'link'} ActionType */
/** @typedef {'explicit' | 'view'} ActionSource */

export const ACTION_LEVELS = /** @type {const} */ (['ui', 'explore', 'propose', 'operate']);

const debugActionModel = createDebug('action-model');

const DEFAULT_ICONS = { ui: 'device-desktop', explore: 'search', propose: 'git-pull-request', operate: 'zap' };
const DEFAULT_LABELS = { ui: 'UI action', explore: 'Investigate', propose: 'Propose fix', operate: 'Operate' };
/** @type {Record<string, string>} */
const VERB_ICONS = {
  refresh: 'sync', synchronize: 'sync', retry: 'play', execute: 'play',
  clear: 'trash', reset: 'trash', logout: 'sign-out', 'switch-account': 'people',
  delete: 'trash', inspect: 'search', investigate: 'search',
  propose: 'git-pull-request'
};

/**
 * @typedef {{ id: string, level: ActionLevel, type: ActionType, source: ActionSource,
 * label: string, icon: string, verb?: string, subject?: string, objective?: string,
 * acceptance?: string, context?: unknown, viewTitle?: string, actionId?: string, command?: string,
 * intent?: string, presentation?: string, confirmation?: boolean }} Action
 */

/** @param {ActionLevel} level @param {ActionType} type */
export function assertActionLevel(level, type) {
  const unknownLevel = !ACTION_LEVELS.includes(level);
  const uiMismatch = !unknownLevel && (level === 'ui') !== (type === 'ui');
  if (unknownLevel || uiMismatch) {
    debugActionModel({
      operation: 'assert-action-level',
      status: 'rejected',
      reason: unknownLevel ? 'unknown-level' : 'ui-reserved',
      type
    });
  }
  if (unknownLevel) throw new TypeError(`Unknown action level: ${level}`);
  if (uiMismatch) throw new TypeError('The ui level is reserved for native dashboard and account-session controls.');
}

/** @param {ActionLevel} level @param {string} [verb] */
export function actionIcon(level, verb) {
  return (verb && VERB_ICONS[verb.toLowerCase()]) || DEFAULT_ICONS[level];
}

/** @param {Action} action */
export function actionPresentation(action) {
  assertActionLevel(action.level, action.type);
  return {
    label: action.label || DEFAULT_LABELS[action.level],
    icon: action.icon || actionIcon(action.level, action.verb),
    preview: action.level === 'propose',
    confirmation: action.level === 'operate' || action.level === 'ui' && action.confirmation === true
  };
}

/**
 * Legacy CLI and row actions without level retain their prior approval/preview behavior.
 * @param {Record<string, any>} declared
 * @param {{ type: ActionType, id: string, source?: ActionSource }} options
 * @returns {Action}
 */
export function normalizeAction(declared, { type, id, source = 'explicit' }) {
  /** @type {ActionLevel} */
  const level = declared.level ?? (type === 'ui' ? 'ui' : type === 'cli' ? 'operate' : type === 'link' ? 'explore' : 'propose');
  assertActionLevel(level, type);
  const verb = declared.verb;
  debugActionModel({ operation: 'normalize-action', type, level, source, explicit: declared.level !== undefined });
  return {
    ...declared, id, type, source, level, verb,
    label: declared.label ?? (level === 'operate' ? '' : DEFAULT_LABELS[level]),
    icon: declared.icon ?? actionIcon(level, verb)
  };
}

/** @param {Record<string, any>} view @param {{subject: string, objective: string, acceptance: string}} semantics @returns {Action} */
export function normalizeViewAction(view, semantics) {
  return normalizeAction({
    ...semantics,
    level: view['prompt-level'] ?? 'propose',
    actionId: view.id ?? 'view',
    context: view.data
  }, { id: `${view.id ?? 'view'}-prompt`, type: 'prompt', source: 'view' });
}

/** @param {string} prompt @param {ActionLevel} level */
export function constrainPrompt(prompt, level) {
  assertActionLevel(level, 'prompt');
  debugActionModel({ operation: 'constrain-prompt', level });
  return level === 'explore'
    ? `Read-only investigation. Do not modify repositories, create issues, patches, pull requests, change configuration, or perform operational side effects.\n\n${prompt}`
    : level === 'propose'
      ? `Proposal only. Create changes through normal repository or change-management mechanisms; do not perform direct operational mutations.\n\n${prompt}`
      : prompt;
}
