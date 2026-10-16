import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const queue = vi.hoisted(() => ({
  available: vi.fn(), get: vi.fn(), attach: vi.fn(), cancel: vi.fn(), retry: vi.fn()
}));
vi.mock('../../src/data-processor.js', () => ({
  cliQueueAvailable: queue.available, requestCliQueue: queue.get,
  attachCliCommand: queue.attach, cancelCliCommand: queue.cancel, retryCliCommand: queue.retry
}));
vi.mock('../../src/components/cli-terminal-runtime.js', () => ({
  mountTerminal: (/** @type {HTMLElement} */ root) => ({
    write: (/** @type {string} */ text) => { root.textContent += text; },
    reset: () => { root.textContent = ''; }
  })
}));
import { renderCommandTerminal } from '../../src/components/command-terminal.js';

const context = /** @type {import('../../src/components/ui-elements.js').ElementRenderContext} */ ({
  pageId: 'command', title: 'Output', sourceNames: [], sources: {}, contextDetails: [],
  headingTag: 'h3', routeParameters: { command: 'persistent-1' }
});

beforeEach(() => {
  vi.resetAllMocks();
  window.location.hash = 'page-command?command=persistent-1';
});

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
});

describe('persistent command terminal', () => {
  it('opens an accessible modal and closes back to Commands without cancelling', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'running' });
    queue.attach.mockImplementation(() => new Promise(() => {}));
    const root = renderCommandTerminal(context);
    document.body.append(root);
    const dialog = /** @type {HTMLDialogElement} */ (root.querySelector('dialog'));
    await vi.waitFor(() => expect(dialog.open).toBe(true));
    expect(dialog.getAttribute('aria-label')).toBe('Command console log');
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledOnce());
    const signal = queue.attach.mock.calls[0][2];
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBe(false);
    expect(window.location.hash).toBe('#page-commands');
    expect(signal.aborted).toBe(true);
    expect(queue.cancel).not.toHaveBeenCalled();
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it('renders a missing-selection state without fetching a command', () => {
    queue.available.mockReturnValue(true);
    const root = renderCommandTerminal({ ...context, routeParameters: {} });
    document.body.append(root);
    expect(root.textContent).toContain('Select a command');
    expect(queue.get).not.toHaveBeenCalled();
  });

  it('reconnects by replacing the attachment and ignores stale output', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'running' });
    queue.attach.mockImplementation(() => new Promise(() => {}));
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledOnce());
    const [, staleOutput, signal] = queue.attach.mock.calls[0];
    /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect output')).click();
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    staleOutput({ data: 'stale output' });
    queue.attach.mock.calls[1][1]({ data: 'new output' });
    expect(root.querySelector('.cli-action-terminal')?.textContent).toBe('new output');
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it('retries explicitly once and navigates to the new durable command', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'failed' });
    queue.attach.mockResolvedValue({ command: { id: 'persistent-1', status: 'failed' }, result: {} });
    queue.retry.mockResolvedValue({ id: 'persistent-2', status: 'queued' });
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledOnce());
    const retry = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-confirm'));
    expect(retry.hidden).toBe(false);
    retry.click();
    retry.click();
    await vi.waitFor(() => expect(window.location.hash).toBe('#page-command?command=persistent-2'));
    expect(queue.retry).toHaveBeenCalledExactlyOnceWith('persistent-1', expect.any(AbortSignal));
    expect(queue.attach).toHaveBeenCalledOnce();
  });

  it('preserves retry errors without navigating or rerunning a command', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'timed-out' });
    queue.attach.mockResolvedValue({ command: { id: 'persistent-1', status: 'timed-out' }, result: {} });
    queue.retry.mockRejectedValue(new Error('Retry not authorized.'));
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalledOnce());
    const retry = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-confirm'));
    retry.click();
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    expect(window.location.hash).toBe('#page-command?command=persistent-1');
    expect(queue.attach).toHaveBeenCalledOnce();
  });
  it('renders an honest unavailable state without worker requests', () => {
    queue.available.mockReturnValue(false);
    const root = renderCommandTerminal(context);
    document.body.append(root);
    expect(root.textContent).toContain('authorized local admin or canvas');
    expect(queue.get).not.toHaveBeenCalled();
    expect(queue.attach).not.toHaveBeenCalled();
  });

  it('replays persistent output and reveals retry only for a failed command', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'failed' });
    queue.attach.mockImplementation(async (_id, output) => {
      output({ data: 'Retained output' });
      return { command: { id: 'persistent-1', status: 'failed' }, result: { ok: false, error: 'Exit 1' } };
    });
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(root.querySelector('.cli-action-terminal')?.textContent).toContain('Retained output'));
    expect(root.querySelector('output')?.textContent).toBe('persistent-1 · failed');
    expect(/** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-confirm')).hidden).toBe(false);
    expect(/** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-cancel')).hidden).toBe(true);
  });

  it('aborts the browser attachment on detachment without cancelling server work', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'running' });
    queue.attach.mockImplementation((_id, _output, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Detached', 'AbortError')), { once: true });
    }));
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalled());
    const signal = queue.attach.mock.calls[0][2];
    root.remove();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(queue.cancel).not.toHaveBeenCalled();
  });

  it('cancels only on the explicit cancellation control', async () => {
    queue.available.mockReturnValue(true);
    queue.get.mockResolvedValue({ id: 'persistent-1', status: 'running' });
    queue.cancel.mockResolvedValue({ id: 'persistent-1', status: 'canceled' });
    const root = renderCommandTerminal(context);
    document.body.append(root);
    await vi.waitFor(() => expect(queue.attach).toHaveBeenCalled());
    /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-cancel')).click();
    await vi.waitFor(() => expect(queue.cancel).toHaveBeenCalledWith('persistent-1', expect.any(AbortSignal)));
    expect(root.querySelector('output')?.textContent).toContain('canceled');
  });
});
