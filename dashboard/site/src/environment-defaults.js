import { parseDocument } from 'yaml';
import { createDebug } from './debug.js';

const debugDefaults = createDebug('src:environment-defaults');

export const environmentDefaultsFile = 'cao-governance.yml';

/** Recognize only the managed-file CLI transport, never arbitrary filesystem paths.
 * @param {string} command
 */
export function environmentDefaultsCommand(command) {
  const result = parseCommand(command);
  debugDefaults({ event: 'command', recognized: result !== null, operation: result?.operation, scope: result?.scope });
  return result;
}

/** @param {string} command */
function parseCommand(command) {
  const tokens = command.split(' ');
  if (tokens[0] !== 'gh' || tokens[1] !== 'aw' || tokens[2] !== 'env'
    || !['get', 'update'].includes(tokens[3]) || tokens[4] !== environmentDefaultsFile) return null;
  const operation = tokens[3];
  /** @type {Record<string, string>} */
  const options = {};
  for (let i = 5; i < tokens.length; i += 1) {
    const flag = tokens[i];
    if (Object.hasOwn(options, flag)) return null;
    if (operation === 'update' && ['--yes', '--dry-run'].includes(flag)) options[flag] = 'true';
    else if (['--scope', '--repo', '--org', '--enterprise', '--visibility'].includes(flag)
      && tokens[i + 1] && !tokens[i + 1].startsWith('-')) options[flag] = tokens[++i];
    else return null;
  }
  const scope = options['--scope'];
  const targetFlag = scope === 'repo' ? '--repo' : scope === 'org' ? '--org' : scope === 'ent' ? '--enterprise' : '';
  if (!targetFlag || !options[targetFlag]
    || ['--repo', '--org', '--enterprise'].some((flag) => flag !== targetFlag && options[flag])) return null;
  const targetPattern = scope === 'repo'
    ? /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
    : /^[A-Za-z0-9][A-Za-z0-9-]*$/;
  const template = /^\{\{[a-z][a-z0-9-]*\}\}$/;
  if (!targetPattern.test(options[targetFlag]) && !template.test(options[targetFlag])) return null;
  if (operation === 'get' && (options['--visibility'] || options['--yes'] || options['--dry-run'])) return null;
  if (operation === 'update' && !options['--yes']) return null;
  if (options['--visibility'] && (scope === 'repo'
    || !['all', 'private'].includes(options['--visibility']) && options['--visibility'] !== '{{visibility}}')) return null;
  return { operation, scope };
}

/** @param {string} reason @param {string} message */
function rejectDefaults(reason, message) {
  debugDefaults({ event: 'parse-rejected', reason });
  return new Error(message);
}

/** Validate the flat, non-secret gh-aw defaults document without duplicating its evolving key registry.
 * @param {string} text
 * @returns {Record<string, string | null>}
 */
export function parseEnvironmentDefaults(text) {
  if (!text.trim() || text.length > 100_000) throw rejectDefaults('size', 'Defaults YAML must contain 1 to 100,000 characters.');
  const document = parseDocument(text);
  if (document.errors.length) throw rejectDefaults('yaml', 'Defaults must be valid YAML with unique keys.');
  const values = document.toJS({ maxAliasCount: 0 });
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length
    || Object.entries(values).some(([key, value]) =>
      !/^default_[a-z][a-z0-9_]*$/.test(key) || value !== null && typeof value !== 'string')) {
    throw rejectDefaults('shape', 'Use a flat mapping of default_ keys to quoted strings or null. Do not include secrets.');
  }
  debugDefaults({ event: 'parsed', keys: Object.keys(values).length });
  return values;
}
