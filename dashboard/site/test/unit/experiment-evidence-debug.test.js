import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
  vi.resetModules();
  window.history.replaceState(null, '', `/${search}`);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const module = await import('../../src/data/adapters/experiment-evidence.js');
  return { module, debug };
}

describe('experiment evidence debug logging', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('is silent by default', async () => {
    const { module, debug } = await load('');
    module.parseExperimentAssignments('{"a":"secret-variant"}', 'assignments.json');
    expect(debug).not.toHaveBeenCalled();
  });

  it('logs counts and statuses under the filename category without values', async () => {
    const { module, debug } = await load('?debug=experiment-evidence');
    module.parseExperimentAssignments('{"secret-name":"secret-variant"}', 'p/assignments.json');
    expect(() => module.parseExperimentAssignments('{secret', 'p/assignments.json')).toThrow(TypeError);
    module.experimentAssignmentArtifact([{ path: 'assignments.json', content: 'x' }]);
    expect(debug.mock.calls).toEqual([
      ['[cao:experiment-evidence]', { event: 'assignments-parse', status: 'ok', count: 1 }],
      ['[cao:experiment-evidence]', { event: 'assignments-parse', status: 'invalid-json', error: 'SyntaxError' }],
      ['[cao:experiment-evidence]', { event: 'artifact-select', files: 1, candidates: 1 }]
    ]);
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/secret|assignments\.json/);
  });

  it('is excluded by other categories', async () => {
    const { module, debug } = await load('?debug=data');
    module.experimentAssignmentArtifact([]);
    expect(debug).not.toHaveBeenCalled();
  });
});
