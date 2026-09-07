// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableLazyViews, renderLazyView, trackViewTransition } from '../../src/components/lazy-view.js';

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'IntersectionObserver');
});

describe('lazy dashboard views', () => {
  it('renders immediately when IntersectionObserver is unavailable', async () => {
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Run trend', minHeight: 240, render });
    lazyView.dataset.lazyView = '';
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(document.body.querySelector('article')).not.toBeNull();
    expect(document.body.querySelector('.dashboard-lazy-view')).toBeNull();
  });

  it('reserves space and hydrates only after entering the viewport', async () => {
    let callback = () => {};
    const observe = vi.fn();
    const unobserve = vi.fn();
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(nextCallback) {
          callback = nextCallback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect() {}
      }
    });
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Outcomes', minHeight: 320, render });
    lazyView.dataset.lazyView = '';
    document.body.append(lazyView);

    enableLazyViews(document.body);

    expect(lazyView.style.getPropertyValue('--dashboard-lazy-view-min-height')).toBe('320px');
    expect(lazyView.querySelector('.dashboard-lazy-view-skeleton')).not.toBeNull();
    expect(render).not.toHaveBeenCalled();
    callback([{ target: lazyView, isIntersecting: true, intersectionRatio: 1 }]);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(unobserve).toHaveBeenCalledWith(lazyView);
    expect(document.body.querySelector('article')).not.toBeNull();
  });

  it('waits for an active view transition before hydrating', async () => {
    let callback = () => {};
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor(nextCallback) {
          callback = nextCallback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    let finishTransition;
    const finished = new Promise((resolve) => {
      finishTransition = resolve;
    });
    trackViewTransition(document, { finished });
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Findings', render });
    lazyView.dataset.lazyView = '';
    document.body.append(lazyView);
    enableLazyViews(document.body);

    callback([{ target: lazyView, isIntersecting: true, intersectionRatio: 1 }]);
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();

    finishTransition();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  });
});
