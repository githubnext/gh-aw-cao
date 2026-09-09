import { beforeEach, describe, expect, it, vi } from 'vitest';
import { offerCancelCommand } from '../../src/cancel-command.js';

describe('dashboard cancel command', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('stays hidden while the computation completes promptly', () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => 0);
    const command = offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(4000);
    expect(document.querySelector('.cancel-command')?.hasAttribute('hidden')).toBe(true);

    command.complete();
    vi.advanceTimersByTime(5000);
    expect(document.querySelector('.cancel-command')).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('offers the command once the computation runs long', () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => 1);
    offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    const panel = /** @type {HTMLElement} */ (document.querySelector('.cancel-command'));
    expect(panel.hidden).toBe(false);

    /** @type {HTMLButtonElement} */ (panel.querySelector('.cancel-command-button')).click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('positions the attention notice above the footer', () => {
    offerCancelCommand(document);

    const styles = document.querySelector('style[data-cancel-command-styles]')?.textContent;
    expect(styles).toContain('bottom: 60px');
    expect(styles).toContain('border: 1px solid var(--attention)');
    expect(styles).toContain('background: var(--attention-muted)');
    expect(styles).not.toContain('var(--surface)');
  });

  it('cancels from the keyboard only while the command is offered', () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => 1);
    offerCancelCommand(document, { delay: 5000, cancel });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops listening once the computation finishes', () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => 1);
    const command = offerCancelCommand(document, { delay: 5000, cancel });

    vi.advanceTimersByTime(5000);
    command.complete();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(cancel).not.toHaveBeenCalled();
    expect(document.querySelector('.cancel-command')).toBeNull();
  });
});
