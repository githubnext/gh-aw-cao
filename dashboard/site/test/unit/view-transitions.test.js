// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateWithViewTransition } from '../../src/presenter.js';

describe('dashboard view transitions', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    Reflect.deleteProperty(window, 'matchMedia');
    delete document.documentElement.dataset.navigationDirection;
    delete document.documentElement.dataset.navigationTransition;
  });

  it('uses the View Transition API when available', () => {
    const update = vi.fn();
    const startViewTransition = vi.fn((callback) => callback());
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition
    });

    updateWithViewTransition(document, update);

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it('handles an expected abort when a transition is superseded', async () => {
    const update = vi.fn();
    const ready = Promise.reject(new DOMException('Transition was superseded', 'AbortError'));
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        callback();
        return { ready };
      })
    });

    updateWithViewTransition(document, update);

    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(update).toHaveBeenCalledOnce();
  });

  it('updates directly when the View Transition API is unavailable', () => {
    const update = vi.fn();

    updateWithViewTransition(document, update);

    expect(update).toHaveBeenCalledOnce();
  });

  it('updates directly when reduced motion is preferred', () => {
    const update = vi.fn();
    const startViewTransition = vi.fn((callback) => callback());
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }))
    });

    updateWithViewTransition(document, update);

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it('exposes navigation direction for the lifetime of a transition', async () => {
    let finishTransition = () => {};
    /** @type {Promise<void>} */
    const finished = new Promise((resolve) => {
      finishTransition = () => resolve();
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        expect(document.documentElement.dataset.navigationDirection).toBe('forward');
        callback();
        return { finished };
      })
    });

    updateWithViewTransition(document, vi.fn(), 'forward');

    expect(document.documentElement.dataset.navigationDirection).toBe('forward');
    finishTransition();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.navigationDirection).toBeUndefined();
  });

  it('scopes tab transitions separately without a full-page navigation direction', async () => {
    let finish = () => {};
    const finished = new Promise((resolve) => { finish = () => resolve(undefined); });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        expect(document.documentElement.dataset.navigationTransition).toBe('tab');
        expect(document.documentElement.dataset.navigationDirection).toBeUndefined();
        callback();
        return { finished };
      })
    });
    document.documentElement.dataset.navigationDirection = 'forward';
    const update = vi.fn();

    updateWithViewTransition(document, update, 'backward', 'tab');

    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.navigationTransition).toBe('tab');
    finish();
    await finished;
    await Promise.resolve();
    expect(document.documentElement.dataset.navigationTransition).toBeUndefined();
  });

  it('does not clear a newer transition when a previous transition finishes', async () => {
    let finish = () => {};
    const finished = new Promise((resolve) => { finish = () => resolve(undefined); });
    const startViewTransition = vi.fn((callback) => {
      callback();
      return { finished };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true, value: startViewTransition
    });
    updateWithViewTransition(document, vi.fn(), 'forward');
    startViewTransition.mockImplementation((callback) => {
      callback();
      return { finished: new Promise(() => {}) };
    });
    updateWithViewTransition(document, vi.fn(), undefined, 'tab');

    finish();
    await finished;
    await Promise.resolve();

    expect(document.documentElement.dataset.navigationTransition).toBe('tab');
    expect(document.documentElement.dataset.navigationDirection).toBeUndefined();
  });

  it('cleans transition styling and rethrows when starting the transition fails', () => {
    const error = new Error('Transition failed');
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true, value: () => { throw error; }
    });

    expect(() => updateWithViewTransition(document, vi.fn(), undefined, 'tab')).toThrow(error);
    expect(document.documentElement.dataset.navigationTransition).toBeUndefined();
    expect(document.documentElement.dataset.navigationDirection).toBeUndefined();
  });
});
