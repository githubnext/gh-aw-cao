import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  return { ...(await import('../../src/prompt-wizard.js')), output };
}

const configuration = {
  intro: 'SECRET-INTRO',
  prompt: { label: 'Prompt', instructions: 'SECRET-INSTRUCTIONS' },
  steps: [{ id: 'one', title: 'One', fields: [{ id: 'purpose', label: 'Purpose', control: 'text', required: true }] }]
};

describe('prompt wizard debug logging', () => {
  it('is silent by default and when another category is selected', async () => {
    for (const search of ['', '?debug=auth']) {
      const { parsePromptWizard, output } = await load(search);
      parsePromptWizard(configuration);
      expect(output.debug).not.toHaveBeenCalled();
    }
  });

  it('emits scalar metadata under src:prompt-wizard without user text', async () => {
    const { parsePromptWizard, buildWizardPrompt, output } = await load('?debug=src:prompt-wizard');
    const wizard = parsePromptWizard(configuration);
    buildWizardPrompt(wizard, { purpose: 'SECRET-ANSWER' });
    expect(output.debug).toHaveBeenNthCalledWith(1, '[cao:src:prompt-wizard]', { event: 'parsed', steps: 1, fields: 1, provenance: false });
    const [, built] = output.debug.mock.calls[1];
    expect(built).toMatchObject({ event: 'prompt-built', sections: 1, overLimit: false });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/SECRET/);
  });
});
