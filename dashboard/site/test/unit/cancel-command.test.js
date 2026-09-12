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
});
