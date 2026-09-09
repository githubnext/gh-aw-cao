// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { derived, effect, state } from '../../src/reactive.js'
import { h, keyed } from '../../src/dom.js'

describe('reactive core', () => {
  it('DLS-CONF-004 updates state and derived values deterministically', () => {
    const count = state(1)
    const doubled = derived(() => count.get() * 2)

    expect(count.get()).toBe(1)
    expect(doubled.get()).toBe(2)

    count.set((value) => value + 2)

    expect(count.get()).toBe(3)
    expect(doubled.get()).toBe(6)

    doubled.dispose()
  })

  it('DLS-CONF-004 reruns effects and supports disposal', () => {
    const value = state('a')
    /** @type {string[]} */
    const seen = []

    const runner = effect(() => {
      seen.push(value.get())
    })

    value.set('b')
    runner.stop()
    value.set('c')

    expect(seen).toEqual(['a', 'b'])
  })

  it('DLS-CONF-004 builds DOM trees with text and attributes', () => {
    const button = h(
      'button',
      { className: 'primary', dataset: { viewId: 'summary' }, type: 'button' },
      'Open dashboard',
    )

    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('class')).toBe('primary')
    expect(button.getAttribute('data-view-id')).toBe('summary')
    expect(button.textContent).toBe('Open dashboard')
  })

  it('DLS-CONF-004 keyed lists support update removal and reordering', () => {
    const host = document.createElement('div')
    /** @type {{ id: string, label: string }[]} */
    let items = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' },
    ]

    const list = keyed(
      items,
      (item) =>
        h(
          'span',
          { 'data-id': /** @type {{ id: string }} */ (item).id },
          /** @type {{ label: string }} */ (item).label,
        ),
      (item) => /** @type {{ id: string }} */ (item).id,
    )

    host.append(h('div', null, list))
    expect(
      [...host.querySelectorAll('span')].map((node) => node.textContent),
    ).toEqual(['Alpha', 'Beta', 'Gamma'])

    items = [
      { id: 'c', label: 'Gamma' },
      { id: 'a', label: 'Alpha' },
    ]
    const existingGamma = host.querySelector('[data-id="c"]')
    const existingAlpha = host.querySelector('[data-id="a"]')
    list.items = items
    list.render()

    const spans = [...host.querySelectorAll('span')]
    expect(spans.map((node) => node.textContent)).toEqual(['Gamma', 'Alpha'])
    expect(host.querySelector('[data-id="b"]')).toBeNull()
    expect(host.querySelector('[data-id="c"]')).toBe(existingGamma)
    expect(host.querySelector('[data-id="a"]')).toBe(existingAlpha)
  })
})
