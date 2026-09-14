const TEMPLATE_TOKEN_PATTERN = /\{\{([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}\}/g;
const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.:/-]*$/;

/** @param {string} command */
export function cliActionTemplateFields(command) {
  return [...new Set([...command.matchAll(TEMPLATE_TOKEN_PATTERN)].map((match) => match[1]))];
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} values
 */
export function renderCliActionCommand(command, values = {}) {
  return command.replace(TEMPLATE_TOKEN_PATTERN, (_match, field) => {
    const value = values[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      throw new Error(`CLI action template value "${field}" is missing or invalid.`);
    }
    const pattern = field === 'repository' ? REPOSITORY_SLUG_PATTERN : SAFE_TOKEN_PATTERN;
    if (!pattern.test(value)) {
      throw new Error(`CLI action template value "${field}" is not a safe command token.`);
    }
    return value;
  });
}
