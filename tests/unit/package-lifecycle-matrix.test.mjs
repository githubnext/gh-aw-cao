import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { selectPackageLifecycleSuites } from '../../scripts/package-lifecycle-matrix.mjs'

const names = (files) =>
  selectPackageLifecycleSuites(files).map(({ name }) => name)

test('package lifecycle matrix selects only packages owning changed files', () => {
  assert.deepEqual(names(['uk-ai-advisory/dashboard.json']), ['UK AI Advisory'])
  assert.deepEqual(names(['.github/workflows/shared/control.md']), [
    'root',
    'AW Doctor',
    'EU CRA',
    'UK AI Advisory',
    'SelfCare',
    'Software Development Practices',
    'Dependabot',
  ])
  assert.deepEqual(names(['dashboard/site/index.html']), ['root', 'dashboard'])
  assert.deepEqual(
    names([
      '.github/graders/dependabot-release-train-updater-operational-value.sh',
    ]),
    ['root', 'Dependabot'],
  )
  assert.deepEqual(
    names([
      '.github/graders/aw-maintenance-compiler-security-operational-value.sh',
    ]),
    ['root', 'AW Doctor'],
  )
})

test('package lifecycle matrix selects a package when its manifest changes', () => {
  assert.deepEqual(names(['activity/aw.yml']), ['root', 'activity'])
  assert.deepEqual(names(['software-development-practices/aw.yml']), [
    'Software Development Practices',
  ])
})

test('package lifecycle matrix selects no packages for unrelated changes', () => {
  assert.deepEqual(names(['docs/index.mdx']), [])
})

test('package lifecycle matrix selects all packages for manual runs', () => {
  const suites = selectPackageLifecycleSuites(null)
  assert.equal(suites.length, 9)
  assert.equal(
    names(['tests/integration/package-lifecycle.test.mjs']).length,
    9,
  )

  const source = readFileSync(
    new URL('../integration/package-lifecycle.test.mjs', import.meta.url),
    'utf8',
  )
  const testNames = [...source.matchAll(/^test\("([^"]+)"/gm)].map(
    (match) => match[1],
  )
  for (const testName of testNames) {
    const matches = suites.filter((suite) =>
      new RegExp(suite['test-pattern']).test(testName),
    )
    assert.equal(
      matches.length,
      1,
      `${testName} must run in exactly one matrix job`,
    )
  }
})
