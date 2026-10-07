/** @typedef {'explore' | 'propose' | 'operate'} ActionLevel */
/** @typedef {'prompt' | 'cli' | 'link'} ActionType */
/** @typedef {'explicit' | 'view'} ActionSource */

export const ACTION_LEVELS = /** @type {const} */ (['explore', 'propose', 'operate']);

const DEFAULT_ICONS = { explore: 'search', propose: 'git-pull-request', operate: 'zap' };
/** @type {Record<string, string>} */
const VERB_ICONS = {
  refresh: 'sync', synchronize: 'sync', retry: 'play', execute: 'play',
  delete: 'trash', inspect: 'search', investigate: 'search',
  propose: 'git-pull-request'
};

/**
 * @typedef {{ id: string, level: ActionLevel, type: ActionType, source: ActionSource,
 * label: string, icon: string, verb?: string, subject?: string, objective?: string,
 * acceptance?: string, context?: unknown, actionId?: string, command?: string,
 * intent?: string, presentation?: string }} Action
 */

/** @param {ActionLevel} level @param {string} [verb] */
export function actionIcon(level, verb) {
  return (verb && VERB_ICONS[verb.toLowerCase()]) || DEFAULT_ICONS[level];
}

/** @param {Action} action */
export function actionPresentation(action) {
  return {
    label: action.label || (action.level === 'explore' ? 'Investigate' : action.level === 'propose' ? 'Propose fix' : 'Operate'),
    icon: action.icon || actionIcon(action.level, action.verb),
    preview: action.level === 'propose',
    confirmation: action.level === 'operate'
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
  const level = declared.level ?? (type === 'cli' ? 'operate' : 'propose');
  const verb = declared.verb;
  return {
    ...declared, id, type, source, level, verb,
    label: declared.label ?? (level === 'explore' ? 'Investigate' : level === 'propose' ? 'Propose fix' : ''),
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
  return level === 'explore'
    ? `Read-only investigation. Do not modify repositories, create issues, patches, pull requests, change configuration, or perform operational side effects.\n\n${prompt}`
    : prompt;
}
