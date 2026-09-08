// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectLazyViews, enableLazyViews, renderLazyView, trackViewTransition } from '../../src/components/lazy-view.js';

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'IntersectionObserver');
  vi.restoreAllMocks();
});

describe('lazy dashboard views', () => {
  it('renders immediately when IntersectionObserver is unavailable', async () => {
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Run trend', minHeight: 240, render });
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(document.body.querySelector('article')).not.toBeNull();
    expect(document.body.querySelector('.dashboard-lazy-view')).toBeNull();
  });

  it('does not hydrate a closed supplemental view until it is opened', async () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor() {}
        observe = observe;
        unobserve = unobserve;
        disconnect() {}
      }
    });
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Evidence', render });
    const disclosure = document.createElement('details');
    disclosure.append(document.createElement('summary'), lazyView);
    document.body.append(disclosure);

    enableLazyViews(document.body);
    await Promise.resolve();

    expect(render).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(lazyView);
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(unobserve).toHaveBeenCalledWith(lazyView);
    expect(disclosure.querySelector('article')).not.toBeNull();
  });

  it('reserves space and hydrates only after entering the viewport', async () => {
    /** @type {IntersectionObserverCallback} */
    let callback = () => {};
    const observe = vi.fn();
    const unobserve = vi.fn();
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        /** @param {IntersectionObserverCallback} nextCallback */
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
    document.body.append(lazyView);

    enableLazyViews(document.body);

    expect(lazyView.getAttribute('data-lazy-view')).toBe('');
    expect(lazyView.style.getPropertyValue('--dashboard-lazy-view-min-height')).toBe('320px');
    expect(lazyView.querySelector('.dashboard-lazy-view-skeleton')).not.toBeNull();
    expect(render).not.toHaveBeenCalled();
    callback(
      /** @type {IntersectionObserverEntry[]} */ (/** @type {unknown} */ ([{ target: lazyView, isIntersecting: true, intersectionRatio: 1 }])),
      /** @type {IntersectionObserver} */ ({})
    );
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(unobserve).toHaveBeenCalledWith(lazyView);
    expect(document.body.querySelector('article')).not.toBeNull();
  });

  it('hydrates a view skipped by a scroll jump even without an observer intersection', async () => {
    /** @type {IntersectionObserverInit | undefined} */
    let observerOptions;
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        /** @param {IntersectionObserverCallback} _callback @param {IntersectionObserverInit} options */
        constructor(_callback, options) {
          observerOptions = options;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    const scroller = document.createElement('main');
    scroller.className = 'dashboard-prototype';
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(/** @type {DOMRect} */ ({ bottom: 600 }));
    const root = document.createElement('section');
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Skipped chart', render });
    const lazyRect = vi.spyOn(lazyView, 'getBoundingClientRect');
    lazyRect.mockReturnValue(/** @type {DOMRect} */ ({ top: 1000 }));
    root.append(lazyView);
    scroller.append(root);
    document.body.append(scroller);

    enableLazyViews(root);
    expect(observerOptions?.root).toBe(scroller);
    expect(observerOptions?.rootMargin).toBe('320px 0px');
    expect(render).not.toHaveBeenCalled();

    lazyRect.mockReturnValue(/** @type {DOMRect} */ ({ top: -300 }));
    scroller.dispatchEvent(new Event('scroll'));

    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(root.querySelector('article')).not.toBeNull();
  });

  it('waits for an active view transition before hydrating', async () => {
    /** @type {IntersectionObserverCallback} */
    let callback = () => {};
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        /** @param {IntersectionObserverCallback} nextCallback */
        constructor(nextCallback) {
          callback = nextCallback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    let finishTransition = () => {};
    /** @type {Promise<void>} */
    const finished = new Promise((resolve) => {
      finishTransition = () => resolve();
    });
    trackViewTransition(document, { finished });
    const render = vi.fn(() => document.createElement('article'));
    const lazyView = renderLazyView({ label: 'Findings', render });
    document.body.append(lazyView);
    enableLazyViews(document.body);

    callback(
      /** @type {IntersectionObserverEntry[]} */ (/** @type {unknown} */ ([{ target: lazyView, isIntersecting: true, intersectionRatio: 1 }])),
      /** @type {IntersectionObserver} */ ({})
    );
    await Promise.resolve();
    expect(render).not.toHaveBeenCalled();

    finishTransition();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  });

  it('ignores skipped view transition readiness rejections', async () => {
    trackViewTransition(document, {
      ready: Promise.reject(new Error('Transition was skipped')),
      finished: Promise.resolve()
    });

    await Promise.resolve();
  });

  it('reports hydration failures without leaving the placeholder busy', async () => {
    const error = new Error('renderer failed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const render = vi.fn(() => {
      throw error;
    });
    const lazyView = renderLazyView({ label: 'Findings', render });
    document.body.append(lazyView);

    enableLazyViews(document.body);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

    expect(consoleError).toHaveBeenCalledWith(error);
    expect(lazyView.getAttribute('aria-busy')).toBe('false');
    expect(lazyView.getAttribute('aria-label')).toBe('Unable to load Findings');
    expect(document.body.querySelector('.dashboard-lazy-view')).toBe(lazyView);
  });

  it('exposes a heading and hydrates when keyboard focus reaches the placeholder', async () => {
    const disconnect = vi.fn();
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      }
    });
    const article = document.createElement('article');
    const render = vi.fn(() => article);
    const lazyView = renderLazyView({ label: 'Evidence', headingLevel: 'h4', render });
    document.body.append(lazyView);
    enableLazyViews(document.body);

    expect(lazyView.querySelector('h4')?.textContent).toBe('Evidence');
    lazyView.focus();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(article);

    disconnectLazyViews(document.body);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('preserves an existing tabindex when restoring focus to a hydrated view', async () => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    const section = document.createElement('section');
    section.tabIndex = 0;
    const render = vi.fn(() => section);
    const lazyView = renderLazyView({ label: 'Tabbable Section', render });
    document.body.append(lazyView);
    enableLazyViews(document.body);

    lazyView.focus();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(section);
    expect(section.tabIndex).toBe(0);
    expect(section.getAttribute('tabindex')).toBe('0');
  });

  it('hydrates views entering the viewport together one at a time', async () => {
    /** @type {IntersectionObserverCallback} */
    let callback = () => {};
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: class {
        /** @param {IntersectionObserverCallback} nextCallback */
        constructor(nextCallback) {
          callback = nextCallback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    });
    let active = 0;
    let concurrent = 0;
    /** @type {Array<() => void>} */
    const releases = [];
    const render = vi.fn(() => {
      active += 1;
      concurrent = Math.max(concurrent, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve(document.createElement('article'));
        });
      });
    });
    const first = renderLazyView({ label: 'First', render });
    const second = renderLazyView({ label: 'Second', render });
    document.body.append(first, second);
    enableLazyViews(document.body);

    callback(
      /** @type {IntersectionObserverEntry[]} */ (/** @type {unknown} */ ([
        { target: first, isIntersecting: true, intersectionRatio: 1 },
        { target: second, isIntersecting: true, intersectionRatio: 1 }
      ])),
      /** @type {IntersectionObserver} */ ({})
    );

    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    releases[0]();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    releases[1]();
    await vi.waitFor(() => expect(document.body.querySelectorAll('article')).toHaveLength(2));
    expect(concurrent).toBe(1);
  });
});
