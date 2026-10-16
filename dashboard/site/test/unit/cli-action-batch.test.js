// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ enqueue: vi.fn(), attach: vi.fn(), cancel: vi.fn() }));
vi.mock('../../src/data-processor.js', () => ({
  cliQueueAvailable: () => true,
  enqueueCliCommand: queue.enqueue, attachCliCommand: queue.attach, cancelCliCommand: queue.cancel
}));
vi.mock('../../src/components/cli-terminal-runtime.js', () => ({
  mountTerminal: (/** @type {HTMLElement} */ root) => ({
    write: (/** @type {string} */ text) => { root.textContent += text; }, reset() {}
  })
}));
import { renderDeclaredCliAction, setDeclaredCliActions } from '../../src/components/cli-actions.js';

const rows = [{ repository: 'octo/first' }, { repository: 'other/second' }];

beforeEach(() => {
  queue.enqueue.mockReset().mockImplementation(async ({ values }) => ({ id: values.repository }));
  queue.attach.mockReset();
  queue.cancel.mockReset().mockResolvedValue({});
  setDeclaredCliActions([{
    id: 'upgrade', label: 'Upgrade all', icon: 'download', placement: 'view',
    command: 'gh aw upgrade --repo {{repository}}',
    arguments: [{ id: 'pr', label: 'Create pull request', flag: '--create-pull-request', type: 'boolean', default: true }]
  }], { templateValues: { repository: 'acme/control' } });
});
afterEach(() => { document.body.replaceChildren(); setDeclaredCliActions([]); window.location.hash = ''; });

/** @param {typeof rows} targets @param {boolean} [available] */
function control(targets, available = true) {
  const root = renderDeclaredCliAction('upgrade', {}, { rows: targets, fields: ['repository'], available });
  if (!root) throw new Error('Missing batch action');
  document.body.append(root);
  const trigger = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-trigger'));
  return { root, trigger };
}

it('queues every explicit target on activation and navigates without previewing or attaching', async () => {
  const { root, trigger } = control(rows);
  expect(queue.enqueue).not.toHaveBeenCalled();
  trigger.click();
  await vi.waitFor(() => expect(window.location.hash).toBe('#page-commands'));
  expect(queue.enqueue.mock.calls.map(([payload]) => payload.values)).toEqual(rows);
  expect(queue.enqueue.mock.calls.map(([payload]) => payload.arguments)).toEqual([{ pr: true }, { pr: true }]);
  expect(new Set(queue.enqueue.mock.calls.map(([payload]) => payload.idempotencyKey)).size).toBe(2);
  expect(root.querySelector('dialog')?.open).toBe(false);
  expect(queue.attach).not.toHaveBeenCalled();
});

it.each([
  { targets: [], available: true },
  { targets: rows, available: false },
  { targets: [{ repository: 'octo/first' }, { repository: 'unsafe/repo;echo' }], available: true }
])('rejects empty, incomplete, or unsafe batches without a control-repository fallback', async ({ targets, available }) => {
  const { root, trigger } = control(targets, available);
  expect(trigger.disabled).toBe(true);
  expect(root.querySelector('.cli-action-command')?.textContent).not.toContain('acme/control');
  trigger.click();
  await Promise.resolve();
  expect(queue.enqueue).not.toHaveBeenCalled();
});

it('waits for every admission and prevents double activation while enqueueing', async () => {
  /** @type {((value: { id: string }) => void) | undefined} */
  let admit;
  queue.enqueue.mockImplementation(({ values }) => values.repository === 'octo/first'
    ? Promise.resolve({ id: 'octo/first' })
    : new Promise((resolve) => { admit = resolve; }));
  const { trigger } = control(rows);
  trigger.click();
  trigger.click();
  await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledTimes(2));
  expect(trigger.disabled).toBe(true);
  expect(window.location.hash).toBe('');
  admit?.({ id: 'other/second' });
  await vi.waitFor(() => expect(window.location.hash).toBe('#page-commands'));
  expect(queue.cancel).not.toHaveBeenCalled();
  expect(queue.attach).not.toHaveBeenCalled();
});

it('shows partial admission failures and still navigates to admitted commands', async () => {
  queue.enqueue.mockRejectedValueOnce(new Error('Admission denied'));
  const { trigger } = control(rows);
  trigger.click();
  await vi.waitFor(() => expect(window.location.hash).toBe('#page-commands'));
  expect(document.body.textContent).toContain('1 commands queued; 1 could not be queued.');
});

it('keeps failed admissions on the current page and allows retry', async () => {
  queue.enqueue.mockRejectedValue(new Error('Admission denied'));
  const { trigger } = control(rows);
  trigger.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('0 commands queued; 2 could not be queued.'));
  expect(window.location.hash).toBe('');
  expect(trigger.disabled).toBe(false);
});

it('binds campaign updates to separate scoped CLI commands', async () => {
  setDeclaredCliActions([{
    id: 'update', label: 'Update all', icon: 'sync', placement: 'view',
    command: './cao.sh update --campaign {{campaign}}'
  }]);
  const targets = [{ campaign: 'activity' }, { campaign: 'dependabot' }];
  const root = renderDeclaredCliAction('update', {}, { rows: targets, fields: ['campaign'], available: true });
  if (!root) throw new Error('Missing campaign action');
  document.body.append(root);
  /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-trigger')).click();
  await vi.waitFor(() => expect(window.location.hash).toBe('#page-commands'));
  expect(queue.enqueue.mock.calls.map(([payload]) => payload.values)).toEqual(targets);
});
