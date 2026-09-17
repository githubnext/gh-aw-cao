// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { batch, derived, effect, onCleanup, render, state, untracked } from '../../src/reactive.js';
import { h, keyed } from '../../src/dom.js';

describe('reactive core', () => {
  it('keeps untracked reads out of an effect\'s dependencies', () => {
    const tracked = state(0);
    const bookkeeping = state(0);
    let runs = 0;
    const handle = effect(() => {
      tracked.get();
      untracked(() => bookkeeping.get());
      runs += 1;
    });

    bookkeeping.set(1);
    expect(runs).toBe(1);

    tracked.set(1);
    expect(runs).toBe(2);
    handle.stop();
  });

  it('stops a derived value when its lifetime signal aborts', () => {
    const count = state(1);
    const controller = new AbortController();
    const doubled = derived(() => count.get() * 2, { signal: controller.signal });

    count.set(2);
    expect(doubled.get()).toBe(4);

    controller.abort();
    count.set(3);
    expect(doubled.get()).toBe(4);
  });

  it('DLS-CONF-004 updates state and derived values deterministically', () => {
    const count = state(1);
    const doubled = derived(() => count.get() * 2);

    expect(count.get()).toBe(1);
    expect(doubled.get()).toBe(2);

    count.set((value) => value + 2);

    expect(count.get()).toBe(3);
    expect(doubled.get()).toBe(6);

    doubled.dispose();
  });

  it('DLS-CONF-004 reruns effects and supports disposal', () => {
    const value = state('a');
    /** @type {string[]} */
    const seen = [];

    const runner = effect(() => {
      seen.push(value.get());
    });

    value.set('b');
    runner.stop();
    value.set('c');

    expect(seen).toEqual(['a', 'b']);
  });

  it('DLS-CONF-004 batches dependent effects with their final state', () => {
    const first = state(1);
    const second = state(2);
    /** @type {number[]} */
    const seen = [];
    const runner = effect(() => {
      seen.push(first.get() + second.get());
    });

    batch(() => {
      first.set(3);
      second.set(4);
      first.set(5);
    });

    expect(seen).toEqual([3, 9]);
    runner.stop();
  });

  it('DLS-CONF-004 does not rerun a queued consumer after a derived update', () => {
    const value = state(1);
    const doubled = derived(() => value.get() * 2);
    /** @type {number[][]} */
    const seen = [];
    const runner = effect(() => {
      seen.push([value.get(), doubled.get()]);
    });

    batch(() => value.set(2));

    expect(seen).toEqual([[1, 2], [2, 4]]);
    runner.stop();
    doubled.dispose();
  });

  it('DLS-CONF-004 resolves chained derived values before consumer effects', () => {
    const value = state(1);
    const doubled = derived(() => value.get() * 2);
    const incremented = derived(() => doubled.get() + 1);
    /** @type {number[][]} */
    const seen = [];
    const runner = effect(() => {
      seen.push([value.get(), incremented.get()]);
    });

    batch(() => value.set(2));

    expect(seen).toEqual([[1, 3], [2, 5]]);
    runner.stop();
    incremented.dispose();
    doubled.dispose();
  });

  it('DLS-CONF-004 runs registered cleanup before reruns and disposal', () => {
    const value = state('a');
    /** @type {string[]} */
    const cleaned = [];
    const runner = effect(() => {
      const current = value.get();
      onCleanup(() => cleaned.push(current));
    });

    value.set('b');
    runner.stop();

    expect(cleaned).toEqual(['a', 'b']);
    expect(() => onCleanup(() => {})).toThrow('inside an effect');
  });

  it('DLS-CONF-004 stops effects when their owner signal aborts', () => {
    const controller = new AbortController();
    const value = state(1);
    /** @type {number[]} */
    const seen = [];
    effect(() => seen.push(value.get()), { signal: controller.signal });

    controller.abort();
    value.set(2);

    expect(seen).toEqual([1]);
  });

  it('DLS-CONF-004 completes cleanup when an effect aborts its owner while running', () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const value = state(1);

    effect(() => {
      controller.abort();
      onCleanup(cleanup);
      value.get();
    }, { signal: controller.signal });
    value.set(2);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('DLS-CONF-004 builds DOM trees with text and attributes', () => {
    const button = h(
      'button',
      { className: 'primary', dataset: { viewId: 'summary' }, type: 'button' },
      'Open dashboard'
    );

    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('class')).toBe('primary');
    expect(button.getAttribute('data-view-id')).toBe('summary');
    expect(button.textContent).toBe('Open dashboard');
  });

  it('DLS-CONF-004 keyed lists support update removal and reordering', () => {
    const host = document.createElement('div');
    /** @type {{ id: string, label: string }[]} */
    let items = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' }
    ];

    const list = keyed(
      items,
      (item) => h('span', { 'data-id': /** @type {{ id: string }} */ (item).id }, /** @type {{ label: string }} */ (item).label),
      (item) => /** @type {{ id: string }} */ (item).id
    );

    host.append(h('div', null, list));
    expect([...host.querySelectorAll('span')].map((node) => node.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);

    items = [
      { id: 'c', label: 'Gamma' },
      { id: 'a', label: 'Alpha' }
    ];
    const existingGamma = host.querySelector('[data-id="c"]');
    const existingAlpha = host.querySelector('[data-id="a"]');
    list.items = items;
    list.render();

    const spans = [...host.querySelectorAll('span')];
    expect(spans.map((node) => node.textContent)).toEqual(['Gamma', 'Alpha']);
    expect(host.querySelector('[data-id="b"]')).toBeNull();
    expect(host.querySelector('[data-id="c"]')).toBe(existingGamma);
    expect(host.querySelector('[data-id="a"]')).toBe(existingAlpha);
  });

  it('renders reactive updates through a detached shadow tree', () => {
    const label = state('Ready');
    const host = h('div', null, h('p', { id: 'status' }, 'Waiting'));
    const original = host.firstElementChild;
    const handle = render(host, () => h('p', { id: 'status' }, label.get()));

    expect(host.textContent).toBe('Ready');
    expect(host.firstElementChild).toBe(original);

    label.set('Complete');

    expect(host.textContent).toBe('Complete');
    expect(host.firstElementChild).toBe(original);
    handle.stop();
  });

  it('avoids unchanged element mutations during leaf text updates', () => {
    const label = state('first');
    const host = h('div');
    const handle = render(host, () => h('p', { className: 'status' }, label.get()));
    const paragraph = /** @type {HTMLParagraphElement} */ (host.querySelector('p'));
    const setAttribute = vi.spyOn(paragraph, 'setAttribute');

    label.set('second');

    expect(paragraph.textContent).toBe('second');
    expect(setAttribute).not.toHaveBeenCalled();
    handle.stop();
  });

  it('reconciles keyed children while preserving identity and local input state', () => {
    const items = state([
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' }
    ]);
    const host = h('div');
    const handle = render(host, () => items.get().map((item) => h(
      'label',
      { 'data-key': item.id },
      item.label,
      h('input', { type: 'text' })
    )));
    const alpha = host.querySelector('[data-key="a"]');
    const gamma = host.querySelector('[data-key="c"]');
    const input = alpha?.querySelector('input');
    if (input) input.value = 'local edit';

    items.set([
      { id: 'c', label: 'Gamma updated' },
      { id: 'a', label: 'Alpha' }
    ]);

    expect([...host.children].map((node) => node.getAttribute('data-key'))).toEqual(['c', 'a']);
    expect(host.querySelector('[data-key="c"]')).toBe(gamma);
    expect(host.querySelector('[data-key="a"]')).toBe(alpha);
    expect(/** @type {HTMLInputElement | null} */ (host.querySelector('[data-key="a"] input'))?.value).toBe('local edit');
    expect(host.querySelector('[data-key="b"]')).toBeNull();
    expect(gamma?.textContent).toContain('Gamma updated');
    handle.stop();
  });

  it('reconciles adversarial unkeyed reordering with linear node matching', () => {
    const reverseGroups = state(false);
    const count = 80;
    /** @param {string} name */
    const renderGroup = (name) => Array.from(
      { length: count },
      (_, index) => h(name, null, `${name}-${index}`)
    );
    const host = h('div');
    const handle = render(host, () => reverseGroups.get()
      ? [...renderGroup('div'), ...renderGroup('span')]
      : [...renderGroup('span'), ...renderGroup('div')]);
    const originalSpans = [...host.querySelectorAll('span')];
    const originalDivs = [...host.querySelectorAll(':scope > div')];
    const localName = vi.spyOn(Element.prototype, 'localName', 'get');

    reverseGroups.set(true);

    expect([...host.children].slice(0, count)).toEqual(originalDivs);
    expect([...host.children].slice(count)).toEqual(originalSpans);
    expect(localName.mock.calls.length).toBeLessThan(count * 10);
    localName.mockRestore();
    handle.stop();
  });

  it('reverses a large keyed list with bounded DOM moves', () => {
    const reversed = state(false);
    const count = 100;
    const host = h('div');
    const handle = render(host, () => {
      const indexes = Array.from({ length: count }, (_, index) => index);
      if (reversed.get()) indexes.reverse();
      return indexes.map((index) => h('span', { 'data-key': index }, String(index)));
    });
    const original = [...host.children];
    const insertBefore = vi.spyOn(host, 'insertBefore');

    reversed.set(true);

    expect([...host.children]).toEqual([...original].reverse());
    expect(insertBefore.mock.calls.length).toBeLessThan(count + 1);
    handle.stop();
  });

  it('preserves identity through alternating keyed and unkeyed reordering', () => {
    const reordered = state(false);
    const host = h('div');
    const handle = render(host, () => reordered.get()
      ? [
          h('button', { 'data-key': 'action' }, 'Action updated'),
          h('em', null, 'Emphasis updated'),
          h('div', { 'data-key': 'panel' }, 'Panel updated'),
          h('span', null, 'Status updated')
        ]
      : [
          h('span', null, 'Status'),
          h('div', { 'data-key': 'panel' }, 'Panel'),
          h('em', null, 'Emphasis'),
          h('button', { 'data-key': 'action' }, 'Action')
        ]);
    const original = [...host.children];

    reordered.set(true);

    expect([...host.children]).toEqual([original[3], original[2], original[1], original[0]]);
    expect([...host.children].map((node) => node.textContent)).toEqual([
      'Action updated',
      'Emphasis updated',
      'Panel updated',
      'Status updated'
    ]);
    handle.stop();
  });

  it('consumes duplicate keys in order and removes surplus nodes', () => {
    const count = state(3);
    const host = h('div');
    const handle = render(host, () => Array.from(
      { length: count.get() },
      (_, index) => h('span', { 'data-key': 'duplicate' }, `item-${index}`)
    ));
    const original = [...host.children];

    count.set(2);

    expect([...host.children]).toEqual(original.slice(0, 2));
    expect(original[2].isConnected).toBe(false);

    count.set(4);

    expect([...host.children].slice(0, 2)).toEqual(original.slice(0, 2));
    expect(host.children).toHaveLength(4);
    handle.stop();
  });

  it('replaces incompatible keyed nodes without reusing their identity', () => {
    const useButton = state(false);
    const host = h('div');
    const handle = render(host, () => useButton.get()
      ? h('button', { 'data-key': 'control' }, 'Button')
      : h('a', { 'data-key': 'control', href: '#target' }, 'Link'));
    const link = host.firstElementChild;

    useButton.set(true);

    expect(host.firstElementChild).not.toBe(link);
    expect(host.firstElementChild?.localName).toBe('button');
    expect(link?.isConnected).toBe(false);
    handle.stop();
  });

  it('reorders text and comments while preserving character-data nodes', () => {
    const reordered = state(false);
    const host = h('div');
    const handle = render(host, () => reordered.get()
      ? [document.createComment('comment-updated'), 'text-updated']
      : ['text', document.createComment('comment')]);
    const text = host.childNodes[0];
    const comment = host.childNodes[1];

    reordered.set(true);

    expect([...host.childNodes]).toEqual([comment, text]);
    expect(comment.nodeValue).toBe('comment-updated');
    expect(text.nodeValue).toBe('text-updated');
    handle.stop();
  });

  it('updates explicit form properties without resetting uncontrolled fields', () => {
    const controlled = state('first');
    const tick = state(0);
    const host = h('div');
    const handle = render(host, () => [
      h('input', { 'data-key': 'controlled', value: controlled.get() }),
      h('input', { 'data-key': 'uncontrolled', 'data-tick': tick.get() })
    ]);
    const controlledInput = /** @type {HTMLInputElement} */ (host.querySelector('[data-key="controlled"]'));
    const uncontrolledInput = /** @type {HTMLInputElement} */ (host.querySelector('[data-key="uncontrolled"]'));
    uncontrolledInput.value = 'local edit';

    batch(() => {
      controlled.set('second');
      tick.set(1);
    });

    expect(controlledInput.value).toBe('second');
    expect(uncontrolledInput.value).toBe('local edit');
    handle.stop();
  });

  it('keeps generated label and form-control associations after an update', () => {
    const tick = state(0);
    const host = h('div');
    const handle = render(host, () => {
      const input = h('input', { type: 'text', 'data-tick': tick.get() });
      return [h('label', { htmlFor: input.id }, 'Search'), input];
    });
    const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));

    tick.set(1);

    const label = /** @type {HTMLLabelElement} */ (host.querySelector('label'));
    expect(host.querySelector('input')).toBe(input);
    expect(label.control).toBe(input);
    handle.stop();
  });

  it('refreshes rendered event listeners without replacing their element', () => {
    const action = state('first');
    /** @type {string[]} */
    const calls = [];
    const host = h('div');
    const handle = render(host, () => {
      const current = action.get();
      return h('button', { onClick: () => calls.push(current) }, current);
    });
    const button = /** @type {HTMLButtonElement} */ (host.querySelector('button'));

    button.click();
    action.set('second');
    button.click();

    expect(host.querySelector('button')).toBe(button);
    expect(calls).toEqual(['first', 'second']);
    handle.stop();
  });

  it('preserves focus while reconciling nested SVG and HTML nodes', () => {
    const value = state('one');
    const host = h('div');
    document.body.append(host);
    const handle = render(host, () => [
      h('input', { id: 'focus-target' }),
      h('svg', { viewBox: '0 0 10 10' }, h('title', null, value.get()), h('circle', { cx: value.get() === 'one' ? 2 : 4 }))
    ]);
    const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));
    const circle = host.querySelector('circle');
    input.focus();

    value.set('two');

    expect(document.activeElement).toBe(input);
    expect(host.querySelector('circle')).toBe(circle);
    expect(circle?.getAttribute('cx')).toBe('4');
    expect(host.querySelector('title')?.textContent).toBe('two');
    handle.stop();
    host.remove();
  });

  it('stops shadow-tree rendering with its abort-scoped lifetime', () => {
    const controller = new AbortController();
    const value = state('before');
    const host = h('div');
    render(host, () => value.get(), { signal: controller.signal });

    controller.abort();
    value.set('after');

    expect(host.textContent).toBe('before');
  });
});
