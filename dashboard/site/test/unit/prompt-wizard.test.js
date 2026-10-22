import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
const queue = vi.hoisted(() => ({ enqueue: vi.fn(), attach: vi.fn() }));
vi.mock('../../src/data-processor.js', () => ({
  cliQueueAvailable: () => Reflect.get(globalThis, '__CLI_QUEUE__') === true,
  enqueueCliCommand: queue.enqueue, attachCliCommand: queue.attach, subscribeCanonicalDashboardView: vi.fn()
}));
import { authoritativeDashboard, authoritativeDashboardSource } from '../authoritative-dashboard.js';
import contract from '../fixtures/wizard-contract.json' with { type: 'json' };
import { parsePromptWizard, initialWizardValues, wizardDesign, buildWizardPrompt } from '../../src/prompt-wizard.js';
import { renderPromptWizard } from '../../src/components/prompt-wizard.js';
import { setDeclaredCliActions } from '../../src/components/cli-actions.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { processDataRequest } from '../../src/data-worker.js';

const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page);
const view = page.views[0];
const wizard = parsePromptWizard(view.config.wizard);
/** @returns {import('../../src/prompt-wizard.js').WizardValues} */
function completeValues() {
  return { ...initialWizardValues(wizard), name: 'issue-helper', purpose: 'Triage issues.', success: 'Never close an issue.', scope: 'Only the triggering issue.' };
}
function mount() {
  const root = renderPromptWizard({
    pageId: page.id, viewId: view.id, title: view.title, sourceNames: [], sources: {},
    contextDetails: [], elementConfig: view.config, headingTag: 'h2'
  });
  document.body.append(root);
  return root;
}
/** @param {HTMLElement} root @param {string} label */
function button(root, label) {
  const button = [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === label || button.getAttribute('aria-label') === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}
/** @param {HTMLElement} root @param {string} label @param {string} value */
function input(root, label, value) {
  const field = [...root.querySelectorAll('label')].find((node) => node.textContent === `${label} (required)`);
  const control = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ (root.querySelector(`#${field?.htmlFor}`));
  if (!control) throw new Error(`Missing input: ${label}`);
  control.value = value;
  control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return control;
}
/** @param {HTMLElement} root */
function fillGoal(root) {
  input(root, 'Workflow or campaign name', 'issue-helper');
  input(root, 'What should the agent do?', 'Triage issues.');
  input(root, 'Intent and acceptance criteria', 'Never close issues.');
  button(root, 'Next').click();
}
/** @param {HTMLElement} root */
function review(root) {
  fillGoal(root);
  input(root, 'Per-run scope and limits', 'Only the triggering issue.');
  button(root, 'Review design').click();
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('__CLI_QUEUE__', true);
  vi.stubGlobal('indexedDB', new IDBFactory());
  queue.enqueue.mockReset().mockResolvedValue({ id: 'generation-command' });
  queue.attach.mockReset().mockResolvedValue({ command: { status: 'completed' }, result: { ok: true } });
  setDeclaredCliActions(authoritativeDashboard.dashboard['cli-actions']);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  setDeclaredCliActions([]);
});

describe('declarative wizard contract', () => {
  it('registers a navigable, source-free JSON page with pinned mined patterns and the standard prompt button', async () => {
    expect(validateDashboardDocument(authoritativeDashboardSource).errors).toEqual([]);
    expect(page).toMatchObject({ id: contract.page, kind: 'custom', views: [{
      id: contract.view, element: contract.element, data: { sources: contract.sources }, prompt: 'none'
    }] });
    expect(authoritativeDashboard.dashboard.navigation[0].pages).toContain(contract.page);
    expect(wizard.steps.map((step) => step.id)).toEqual(contract.steps);
    expect(wizard.steps.flatMap((step) => step.fields.map((field) => field.id))).toEqual(contract.fields);
    expect(wizard.provenance).toMatchObject({ repository: contract.upstream, revision: contract.revision });
    expect(wizard.provenance?.license).toContain('Copyright (c) 2026 GitHub Next');
    expect(wizard.steps[0].fields.find((field) => field.id === 'pattern')?.options).toHaveLength(contract['pattern-count'] + 1);
    expect(wizard.prompt.label).toBe(contract['prompt-label']);
    expect(wizard.prompt).not.toHaveProperty('action');
    const copyOnly = {
      'language-version': '0.1.0',
      dashboard: { id: 'wizard-only', title: 'Wizard only', pages: [page] }
    };
    expect(validateDashboardDocument(JSON.stringify(copyOnly)).ok).toBe(true);
    const compiled = compileDashboardViewPayloadQueries(page, page.id);
    expect(compiled.queries).toEqual([]);
    const result = await processDataRequest({
      operation: 'query-canonical-dashboard', sourceNames: [], pageId: page.id,
      context: { pages: [page], queries: compiled.queries }
    });
    expect(result).toEqual({});
  });

  it.each([
    (/** @type {any} */ doc) => { doc.dashboard.pages.find((/** @type {any} */ page) => page.id === contract.page).views[0].config.wizard.prompt.action = 'upgrade-repository'; },
    (/** @type {any} */ doc) => { doc.dashboard.pages.find((/** @type {any} */ page) => page.id === contract.page).views[0].data.sources = ['runs']; },
    (/** @type {any} */ doc) => { delete doc.dashboard.pages.find((/** @type {any} */ page) => page.id === contract.page).views[0].config; }
  ])('rejects command bindings or data queries on the prompt wizard', (change) => {
    const document = structuredClone(authoritativeDashboard);
    change(document);
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(false);
  });

  it('preserves explicit choices and bounds Campaign generation without elevating mined recommendations', () => {
    const values = { ...completeValues(), artifact: 'campaign', targets: 'acme/one\nacme/two', pattern: 'issue-triage', outputs: ['add-comment'] };
    const prompt = buildWizardPrompt(wizard, values);
    expect(prompt).toContain('Proposal only.');
    expect(prompt).toContain('aw.yml');
    expect(prompt).toContain('default to review mode');
    expect(prompt).toContain('Explicit selections override recommendations.');
    expect(prompt).toContain('"targets"');
    expect(prompt).toContain('"recommended_triggers"');
    expect(prompt).toContain('"success_rate": 0.57');
    expect(prompt).toContain(contract.revision);
    expect(prompt).toContain('gh aw compile');
    expect(prompt).toContain('draft pull request');
    expect(prompt).not.toContain('MIT License');
    expect(values.outputs).toEqual(['add-comment']);
    expect(wizardDesign(wizard, { ...values, artifact: 'workflow' })).not.toHaveProperty('targets');
  });

  it('rejects missing, forged, duplicate and oversized answers instead of generating a partial prompt', () => {
    const changes = /** @type {import('../../src/prompt-wizard.js').WizardValues[]} */ ([
      { purpose: '' }, { name: 'bad name' }, { pattern: 'not-a-pattern' }, { outputs: ['not-an-output'] },
      { outputs: ['add-comment', 'add-comment'] }, { artifact: 'campaign', targets: '' },
      { artifact: 'campaign', targets: 'acme/*' },
      { purpose: 'x'.repeat(6001) }, { triggers: 'issues' }
    ]);
    for (const changed of changes) expect(() => buildWizardPrompt(wizard, { ...completeValues(), ...changed })).toThrow();
  });

  it('fails closed on malformed and unknown declarative configuration', () => {
    for (const change of [
      (/** @type {any} */ value) => { value.extra = 'unknown'; },
      (/** @type {any} */ value) => { value.steps[0].fields[1].id = 'artifact'; },
      (/** @type {any} */ value) => { value.steps[0].fields[1].control = 'script'; },
      (/** @type {any} */ value) => { value.steps[0].fields[1]['max-length'] = -1; },
      (/** @type {any} */ value) => { value.steps[0].fields[1].when = { field: 'missing', equals: 'x' }; },
      (/** @type {any} */ value) => { value.steps[0].fields[0].default = 'missing'; },
      (/** @type {any} */ value) => { value.steps[0].fields[0].options[0].callback = 'script'; },
      (/** @type {any} */ value) => { value.provenance.revision = 'main'; }
    ]) {
      const invalid = structuredClone(wizard);
      change(invalid);
      expect(() => parsePromptWizard(invalid)).toThrow();
    }
  });
});

describe('wizard interaction and lifecycle', () => {
  it.each(['workflow', 'campaign'])('uses the standard prompt button for %s even when command execution is available', async (artifact) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root = mount();
    button(root, 'Next').click();
    expect(root.textContent).toContain('Workflow or campaign name is required.');
    expect(document.activeElement?.getAttribute('id')).toMatch(/-name$/);
    input(root, 'What do you want to generate?', artifact);
    fillGoal(root);
    input(root, 'Per-run scope and limits', 'Only the triggering issue.');
    if (artifact === 'campaign') input(root, 'Campaign target repositories', 'acme/one');
    button(root, 'Review design').click();
    expect(root.querySelector('.prompt-wizard-review')?.hasAttribute('hidden')).toBe(false);
    expect(queue.enqueue).not.toHaveBeenCalled();
    const promptButton = button(root, contract['prompt-label']);
    expect(promptButton.getAttribute('data-intent-presentation')).toBe(contract.presentation);
    expect(promptButton.getAttribute('data-action-level')).toBe('propose');
    promptButton.click();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('.table-intent-preview')?.textContent).toContain('Triage issues.');
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(root.querySelector('.cli-action-output')).toBeNull();
    expect(root.textContent).not.toContain('Start agent task');
    button(root, 'Copy prompt').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('Triage issues.');
    expect(writeText.mock.calls[0][0]).toContain(`"value": "${artifact}"`);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(queue.attach).not.toHaveBeenCalled();
    button(root, 'Close prompt preview').click();
    button(root, 'Back').click();
    expect(root.querySelector('[id$="-scope"]')).toHaveProperty('value', 'Only the triggering issue.');
    button(root, 'Back').click();
    expect(root.querySelector('[id$="-purpose"]')).toHaveProperty('value', 'Triage issues.');
  });

  it('requires explicit Campaign targets and never auto-selects recommended outputs or capabilities', () => {
    const root = mount();
    input(root, 'What do you want to generate?', 'campaign');
    input(root, 'Starting pattern', 'issue-triage');
    fillGoal(root);
    input(root, 'Per-run scope and limits', 'One dispatched target per worker.');
    button(root, 'Review design').click();
    expect(root.textContent).toContain('Campaign target repositories is required.');
    expect(root.querySelectorAll('.prompt-wizard-options input:checked')).toHaveLength(1);
    input(root, 'Campaign target repositories', 'acme/one');
    button(root, 'Review design').click();
    button(root, contract['prompt-label']).click();
    expect(root.querySelector('.table-intent-preview')?.textContent).toContain('acme/one');
  });

  it('provides copy-only handoff when execution is unavailable and treats input as text', async () => {
    vi.stubGlobal('__CLI_QUEUE__', false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root = mount();
    fillGoal(root);
    input(root, 'Per-run scope and limits', '<img src=x onerror=alert(1)> $(touch /tmp/not-run)');
    button(root, 'Review design').click();
    button(root, contract['prompt-label']).click();
    expect(root.querySelector('img')).toBeNull();
    button(root, 'Copy prompt').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('$(touch /tmp/not-run)');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('reports copy failure and stops detached prompt interaction', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable.'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root = mount();
    review(root);
    button(root, contract['prompt-label']).click();
    button(root, 'Copy prompt').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Could not copy prompt.'));
    root.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    button(root, 'Back').click();
    button(root, contract['prompt-label']).click();
    expect(root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('ignores in-flight clipboard completion after detachment without queuing a command', async () => {
    /** @type {((value: unknown) => void) | undefined} */
    let finish;
    const writeText = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root = mount();
    review(root);
    button(root, contract['prompt-label']).click();
    button(root, 'Copy prompt').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    root.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.textContent).not.toContain('Prompt copied.');
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
