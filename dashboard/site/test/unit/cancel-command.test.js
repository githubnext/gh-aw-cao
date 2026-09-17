// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offerCancelCommand } from '../../src/cancel-command.js';
import { isDebugEnabled } from '../../src/debug.js';

describe('dashboard cancel command', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
    vi.useFakeTimers();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
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

  it('derives the cancel-command debug category predictably from the filename', () => {
    expect(isDebugEnabled('cancel-command', '?debug=cancel-command')).toBe(true);
    expect(isDebugEnabled('cancel-command', '?debug=1')).toBe(true);
    expect(isDebugEnabled('cancel-command', '?debug=render')).toBe(false);
  });

  it('stays silent by default even once the command is revealed and cancelled', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const cancel = vi.fn(() => 1);
    offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(debug).not.toHaveBeenCalled();
  });

  it('logs sanitized reveal, cancel, and completion metadata when the category is enabled', async () => {
    window.history.replaceState(null, '', '/?debug=cancel-command');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.resetModules();
    const { offerCancelCommand: offerCancelCommandWithDebug } = await import('../../src/cancel-command.js');
    const cancel = vi.fn(() => 1);
    const command = offerCancelCommandWithDebug(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    expect(debug).toHaveBeenCalledWith('[cao:cancel-command]', 'revealed', { delay: 5000 });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(debug).toHaveBeenCalledWith('[cao:cancel-command]', 'cancel requested');

    command.complete();
    expect(debug).toHaveBeenCalledWith('[cao:cancel-command]', 'completed', { revealed: true });

    for (const call of debug.mock.calls) {
      const values = call.slice(1);
      for (const value of values) {
        if (value && typeof value === 'object') {
          expect(Object.keys(value)).not.toEqual(expect.arrayContaining(['message', 'token', 'secret']));
        }
      }
    }
  });
});
