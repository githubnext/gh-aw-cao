// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateWithViewTransition } from '../../src/presenter.js'

describe('dashboard view transitions', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition')
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('uses the View Transition API when available', () => {
    const update = vi.fn()
    const startViewTransition = vi.fn((callback) => callback())
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })

    updateWithViewTransition(document, update)

    expect(startViewTransition).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
  })

  it('handles an expected abort when a transition is superseded', async () => {
    const update = vi.fn()
    const ready = Promise.reject(new DOMException('Transition was superseded', 'AbortError'))
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((callback) => {
        callback()
        return { ready }
      }),
    })

    updateWithViewTransition(document, update)

    await expect(ready).rejects.toMatchObject({ name: 'AbortError' })
    expect(update).toHaveBeenCalledOnce()
  })

  it('updates directly when the View Transition API is unavailable', () => {
    const update = vi.fn()

    updateWithViewTransition(document, update)

    expect(update).toHaveBeenCalledOnce()
  })

  it('updates directly when reduced motion is preferred', () => {
    const update = vi.fn()
    const startViewTransition = vi.fn((callback) => callback())
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    })

    updateWithViewTransition(document, update)

    expect(startViewTransition).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
  })
})
