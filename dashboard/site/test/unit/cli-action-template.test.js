import { describe, expect, it } from 'vitest';
import {
  cliActionTemplateFields,
  renderCliActionCommand
} from '../../src/cli-action-template.js';

describe('CLI action command templates', () => {
  it('lists unique template fields and renders a repository slug', () => {
    const command = 'gh aw update --repo {{repository}} --source {{repository}}';

    expect(cliActionTemplateFields(command)).toEqual(['repository']);
    expect(renderCliActionCommand(command, { repository: 'octo/example' }))
      .toBe('gh aw update --repo octo/example --source octo/example');
  });

  it.each([
    [{}, 'missing or invalid'],
    [{ repository: 'octo/example --force' }, 'not a safe command token'],
    [{ repository: 'octo' }, 'not a safe command token'],
    [{ repository: '-/example' }, 'not a safe command token']
  ])('rejects unsafe repository template values', (values, message) => {
    expect(() => renderCliActionCommand(
      'gh aw update --repo {{repository}}',
      values
    )).toThrow(message);
  });
});
