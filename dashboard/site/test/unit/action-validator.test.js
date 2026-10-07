import { describe, expect, it } from 'vitest';
import {
  isReadOnlyCliAction,
  parseCliActionTokens,
  validateActionLevel,
  validWorkflowDispatchArguments
} from '../../src/action-validator.js';
import { ERROR_CODES } from '../../src/specification.js';

describe('action validation helpers', () => {
  it('preserves quoted, escaped, and empty command arguments', () => {
    expect(parseCliActionTokens('gh workflow run ci.yml -f "name=two words" --ref main'))
      .toEqual(['gh', 'workflow', 'run', 'ci.yml', '-f', 'name=two words', '--ref', 'main']);
    expect(parseCliActionTokens("gh aw logs '' escaped\\ space 'literal\\value'"))
      .toEqual(['gh', 'aw', 'logs', '', 'escaped space', 'literal\\value']);
    expect(parseCliActionTokens('')).toEqual([]);
    expect(parseCliActionTokens('gh aw logs "unterminated')).toBeNull();
    expect(parseCliActionTokens('gh aw logs trailing\\')).toBeNull();
  });

  it('validates workflow dispatch arguments without allowing unknown or incomplete options', () => {
    expect(validWorkflowDispatchArguments([
      'ci.yml', '--repo', 'owner/repo', '--ref', 'main', '-f', 'name=two words'
    ])).toBe(true);
    expect(validWorkflowDispatchArguments([
      'ci.yml', '--repo={{repository}}', '--ref=main', '--raw-field=mode=review'
    ])).toBe(true);
    for (const args of [
      [], ['--repo', 'owner/repo'], ['ci.yml', '--repo'], ['ci.yml', '--repo=invalid'],
      ['ci.yml', '--ref'], ['ci.yml', '--ref='], ['ci.yml', '-f', 'invalid'],
      ['ci.yml', '--raw-field=invalid'], ['ci.yml', '--unknown']
    ]) {
      expect(validWorkflowDispatchArguments(args)).toBe(false);
    }
  });

  it('keeps read-only commands restricted to the existing allowlist without extra arguments', () => {
    for (const command of [
      'gh aw status', 'gh aw list', 'gh aw logs', 'gh aw version', './cao.sh status',
      './cao.sh query recent-runs', './cao.sh query-info recent-runs', './cao.sh prompt recent-runs'
    ]) {
      expect(isReadOnlyCliAction({ command })).toBe(true);
      expect(isReadOnlyCliAction({ command, arguments: [{}] })).toBe(false);
    }
    for (const command of [
      'gh aw run ci', 'gh aw status --extra', './cao.sh add campaign',
      './cao.sh query invalid/name', './cao.sh query recent-runs extra', 'gh aw logs "'
    ]) {
      expect(isReadOnlyCliAction({ command })).toBe(false);
    }
    expect(isReadOnlyCliAction({})).toBe(false);
  });

  it('preserves structured errors for invalid and UI-only execution levels', () => {
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const errors = [];
    for (const level of [undefined, 'explore', 'propose', 'operate']) {
      validateActionLevel(level, '$.level', errors);
    }
    expect(errors).toEqual([]);
    validateActionLevel('invalid', '$.level', errors);
    validateActionLevel('ui', '$.prompt-level', errors);
    expect(errors).toEqual([
      {
        code: ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        message: 'action level must be ui, explore, propose, or operate.',
        path: '$.level'
      },
      {
        code: ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        message: 'The ui level is reserved for native dashboard and account-session controls; prompts, CLI commands, and external links cannot use it.',
        path: '$.prompt-level'
      }
    ]);
  });
});
