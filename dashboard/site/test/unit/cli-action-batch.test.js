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
const complete = { result: { ok: true, exitCode: 0 }, command: { status: 'completed' } };

beforeEach(() => {
  queue.enqueue.mockReset().mockImplementation(async ({ values }) => ({ id: values.repository }));
  queue.attach.mockReset().mockResolvedValue(complete);
  queue.cancel.mockReset().mockResolvedValue({});
  setDeclaredCliActions([{
    id: 'upgrade', label: 'Upgrade all', icon: 'download', placement: 'view',
    command: 'gh aw upgrade --repo {{repository}}',
    arguments: [{ id: 'pr', label: 'Create pull request', flag: '--create-pull-request', type: 'boolean', default: true }]
  }], { templateValues: { repository: 'acme/control' } });
});
afterEach(() => { document.body.replaceChildren(); setDeclaredCliActions([]); });

/** @param {typeof rows} targets @param {boolean} [available] */
function control(targets, available = true) {
  const root = renderDeclaredCliAction('upgrade', {}, { rows: targets, fields: ['repository'], available });
  if (!root) throw new Error('Missing batch action');
  document.body.append(root);
  root.querySelector('.cli-action-trigger')?.dispatchEvent(new MouseEvent('click'));
  const confirm = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-confirm'));
  return { root, confirm };
}

it('previews all explicit targets and queues every invocation only after approval', async () => {
  const { root, confirm } = control(rows);
  expect(root.querySelector('.cli-action-command')?.textContent).toBe(
    'gh aw upgrade --repo octo/first --create-pull-request\ngh aw upgrade --repo other/second --create-pull-request');
  expect(queue.enqueue).not.toHaveBeenCalled();
  confirm.click();
  await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledTimes(2));
  expect(queue.enqueue.mock.calls.map(([payload]) => payload.values)).toEqual(rows);
  expect(queue.enqueue.mock.calls.map(([payload]) => payload.arguments)).toEqual([{ pr: true }, { pr: true }]);
  await vi.waitFor(() => expect(root.querySelector('dialog')?.open).toBe(false));
});

it.each([
  { targets: [], available: true },
  { targets: rows, available: false },
  { targets: [{ repository: 'octo/first' }, { repository: 'unsafe/repo;echo' }], available: true }
])('rejects empty, incomplete, or unsafe batches without a control-repository fallback', async ({ targets, available }) => {
  const { root, confirm } = control(targets, available);
  expect(confirm.disabled).toBe(true);
  expect(root.querySelector('.cli-action-command')?.textContent).not.toContain('acme/control');
  confirm.click();
  await Promise.resolve();
  expect(queue.enqueue).not.toHaveBeenCalled();
});

it('queues all targets before waiting for command completion and cancels every admitted command', async () => {
  /** @type {Array<(value: typeof complete) => void>} */
  const finish = [];
  queue.attach.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const { root, confirm } = control(rows);
  confirm.click();
  await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledTimes(2));
  const cancel = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-cancel:not(.cli-action-detach)'));
  cancel.click();
  await vi.waitFor(() => expect(queue.cancel.mock.calls.map(([id]) => id)).toEqual(['octo/first', 'other/second']));
  for (const resolve of finish) resolve(complete);
  await vi.waitFor(() => expect(root.querySelector('dialog')?.open).toBe(false));
});

it('cancels a target whose enqueue response arrives after batch cancellation', async () => {
  /** @type {((value: { id: string }) => void) | undefined} */
  let admit;
  /** @type {Array<(value: typeof complete) => void>} */
  const finish = [];
  queue.enqueue.mockImplementation(({ values }) => values.repository === 'octo/first'
    ? Promise.resolve({ id: 'octo/first' })
    : new Promise((resolve) => { admit = resolve; }));
  queue.attach.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const { root, confirm } = control(rows);
  confirm.click();
  await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledTimes(1));
  /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-cancel:not(.cli-action-detach)')).click();
  await vi.waitFor(() => expect(queue.cancel).toHaveBeenCalledWith('octo/first', expect.anything()));
  admit?.({ id: 'other/second' });
  await vi.waitFor(() => expect(queue.cancel).toHaveBeenCalledWith('other/second', expect.anything()));
  await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledTimes(2));
  for (const resolve of finish) resolve(complete);
  await vi.waitFor(() => expect(root.querySelector('dialog')?.open).toBe(false));
});
