import { createDebug } from './debug.js';

const TEMPLATE_TOKEN_PATTERN = /\{\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}\}/g;
const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.:/-]*$/;

const debugCliActionTemplate = createDebug('cli-action-template');

/** @param {string} command */
export function cliActionTemplateFields(command) {
  return [...new Set([...command.matchAll(TEMPLATE_TOKEN_PATTERN)].map((match) => match[1]))];
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} values
 */
export function renderCliActionCommand(command, values = {}) {
  let fieldCount = 0;
  const rendered = command.replace(TEMPLATE_TOKEN_PATTERN, (_match, field) => {
    fieldCount += 1;
    const value = values[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      debugCliActionTemplate({ event: 'render-rejected', field, reason: 'missing-or-invalid' });
      throw new Error(`CLI action template value "${field}" is missing or invalid.`);
    }
    const pattern = field === 'repository' ? REPOSITORY_SLUG_PATTERN : SAFE_TOKEN_PATTERN;
    if (!pattern.test(value)) {
      debugCliActionTemplate({ event: 'render-rejected', field, reason: 'unsafe-token' });
      throw new Error(`CLI action template value "${field}" is not a safe command token.`);
    }
    return value;
  });
  debugCliActionTemplate({ event: 'render-completed', fieldCount });
  return rendered;
}
