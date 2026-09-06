// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateWithViewTransition } from '../../src/presenter.js';

describe('dashboard view transitions', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    Reflect.deleteProperty(window, 'matchMedia');
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

  it('swallows rejected ready/finished promises when a transition is skipped', async () => {
    const update = vi.fn();
    const startViewTransition = vi.fn((callback) => {
      callback();
      return {
        ready: Promise.reject(new Error('Transition was skipped because there is a pending transition.')),
        finished: Promise.reject(new Error('Transition was skipped because there is a pending transition.'))
      };
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition
    });

    expect(() => updateWithViewTransition(document, update)).not.toThrow();
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
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
});
