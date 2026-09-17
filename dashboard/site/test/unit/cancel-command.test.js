import { beforeEach, describe, expect, it, vi } from 'vitest';
import { offerCancelCommand } from '../../src/cancel-command.js';

describe('dashboard cancel command', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  it('stays hidden while the computation completes promptly', () => {
    const cancel = vi.fn(() => 0);
    const command = offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(4000);
    expect(document.querySelector('.dashboard-notification')).toBeNull();

    command.complete();
    vi.advanceTimersByTime(5000);
    expect(document.querySelector('.dashboard-notification')).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('offers cancellation as a persistent notification once work runs long', () => {
    const cancel = vi.fn(() => 1);
    offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    const notification = /** @type {HTMLElement} */ (document.querySelector('.dashboard-notification'));
    expect(notification.textContent).toContain('taking longer than expected');

    /** @type {HTMLButtonElement} */ (notification.querySelector('.dashboard-notification-action')).click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(notification.textContent).toBe('Cancelling…');
  });

  it('cancels from the keyboard only while the command is offered', () => {
    const cancel = vi.fn(() => 1);
    offerCancelCommand(document, { delay: 5000, cancel });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops listening and dismisses the notification when work finishes', () => {
    const cancel = vi.fn(() => 1);
    const command = offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    command.complete();
    vi.advanceTimersByTime(180);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancel).not.toHaveBeenCalled();
    expect(document.querySelector('.dashboard-notification')).toBeNull();
  });

  it('stays silent by default and logs only scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=cancel-command', output })
      };
    });
    vi.resetModules();
    const { offerCancelCommand: offerCancelCommandWithDebug } = await import('../../src/cancel-command.js');

    const cancel = vi.fn(() => 42);
    const command = offerCancelCommandWithDebug(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    expect(output.debug).toHaveBeenCalledWith('[cao:cancel-command]', { event: 'offered', delayMs: 5000 });

    /** @type {HTMLButtonElement} */ (document.querySelector('.dashboard-notification-action')).click();
    expect(output.debug).toHaveBeenCalledWith('[cao:cancel-command]', { event: 'cancel-requested', workerId: 42 });

    command.complete();
    expect(output.debug).toHaveBeenCalledWith('[cao:cancel-command]', { event: 'completed', offered: true });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { offerCancelCommand: offerCancelCommandWithoutDebug } = await import('../../src/cancel-command.js');

    const cancel = vi.fn(() => 1);
    const command = offerCancelCommandWithoutDebug(document, { delay: 5000, cancel });
    vi.advanceTimersByTime(5000);
    command.complete();

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
