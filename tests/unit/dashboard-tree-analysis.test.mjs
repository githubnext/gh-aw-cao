import assert from 'node:assert/strict'
import test from 'node:test'
import {
  summarizeAccessibilityTree,
  summarizeDomTree,
  summarizeMobileAccessibility,
} from '../e2e/dashboard-tree-analysis.mjs'

test('dashboard tree analysis identifies dominant DOM structures', () => {
  const result = summarizeDomTree(
    [
      {
        tag: 'main',
        classes: ['shell'],
        depth: 1,
        childElementCount: 2,
        jsonPath: '$.dashboard',
      },
      {
        tag: 'section',
        classes: ['panel'],
        depth: 2,
        childElementCount: 1,
        jsonPath: '$.dashboard.pages[0]',
      },
      {
        tag: 'span',
        classes: ['panel', 'label'],
        depth: 3,
        childElementCount: 0,
        jsonPath: '$.dashboard.pages[0]',
      },
    ],
    [
      { tag: 'section', viewId: 'small', descendantElements: 1 },
      { tag: 'main', viewId: 'large', descendantElements: 2 },
    ],
  )

  assert.equal(result.totalElements, 3)
  assert.equal(result.depth.maximum, 3)
  assert.deepEqual(result.byTag[0], { name: 'main', count: 1 })
  assert.deepEqual(result.byClass[0], { name: 'panel', count: 2 })
  assert.deepEqual(result.byJsonPath[0], {
    name: '$.dashboard.pages[0]',
    count: 2,
  })
  assert.equal(result.topStructures[0].viewId, 'large')
})

test('accessibility tree analysis reports roles, depth, and structural issues', () => {
  const result = summarizeAccessibilityTree(`
- main:
  - heading "Dashboard" [level=1]
  - heading "Details" [level=3]
  - button
  - link "Open"
    - /url: "#open"
  - link "Open"
`)

  assert.equal(result.totalNodes, 6)
  assert.equal(result.depth.maximum, 1)
  assert.deepEqual(result.byRole[0], { name: 'heading', count: 2 })
  assert.deepEqual(result.issues.unnamedInteractive, [
    { role: 'button', depth: 1 },
  ])
  assert.deepEqual(result.issues.headingLevelJumps, [
    { from: 1, to: 3, index: 1 },
  ])
  assert.deepEqual(result.issues.duplicateNames, [
    { name: 'link: Open', count: 2 },
  ])
  assert.deepEqual(result.topStructures[0], {
    role: 'main',
    name: null,
    descendantNodes: 5,
  })
})

test('mobile accessibility analysis reports target size, reflow, zoom, and naming constraints', () => {
  const result = summarizeMobileAccessibility({
    targets: [
      { tag: 'button', name: 'Open', width: 24, height: 24 },
      { tag: 'a', name: 'Details', width: 18, height: 20 },
    ],
    scrollWidth: 391,
    viewportWidth: 390,
    viewportMeta: 'width=device-width, initial-scale=1',
    unnamedInteractive: [{ role: 'button', depth: 2 }],
  })

  assert.equal(result.targets.total, 2)
  assert.equal(result.targets.minimumWidth, 18)
  assert.deepEqual(result.targets.undersized, [
    { tag: 'a', name: 'Details', width: 18, height: 20 },
  ])
  assert.equal(result.reflow.passes, true)
  assert.equal(result.zoom.passes, true)
  assert.equal(result.accessibleNames.passes, false)
  assert.equal(result.passes, false)
})

test('mobile accessibility analysis rejects viewport metadata that disables zoom', () => {
  const result = summarizeMobileAccessibility({
    targets: [],
    scrollWidth: 390,
    viewportWidth: 390,
    viewportMeta: 'width=device-width, maximum-scale=1, user-scalable=no',
    unnamedInteractive: [],
  })

  assert.equal(result.zoom.passes, false)
  assert.equal(result.passes, false)
})
