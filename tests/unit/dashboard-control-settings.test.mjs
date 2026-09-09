import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDashboardControlSettings } from '../../dashboard/report/control-settings.mjs'

const options = {
  repository: 'acme/control',
  controlProgram: '.github/cao/src/control.mjs',
  policyPath: '.github/workflows/cao.json',
}

test('dashboard control settings retain successful policy resolution', () => {
  const settings = resolveDashboardControlSettings({
    ...options,
    readPolicy: () => '{"version":1,"control-plane":{}}',
    execute: () => ({
      status: 0,
      stdout: JSON.stringify({
        allowed_owners: ['acme'],
        allowed_repositories: ['acme/target'],
        packages: { dependabot: { enabled: true } },
      }),
      stderr: '',
    }),
  })

  assert.deepEqual(settings.policy_resolution, {
    status: 'available',
    reason: '',
  })
  assert.deepEqual(settings.allowed_repositories, ['acme/target'])
  assert.deepEqual(settings.packages, { dependabot: { enabled: true } })
  assert.deepEqual(settings.policy_document, {
    version: 1,
    'control-plane': {},
  })
  assert.equal(settings.policy_source, '{"version":1,"control-plane":{}}')
})

test('dashboard control settings report policy refusal without widening scope', () => {
  const settings = resolveDashboardControlSettings({
    ...options,
    readPolicy: () => {
      throw new Error('missing policy')
    },
    execute: () => ({
      status: 1,
      stdout: '',
      stderr: 'control-plane is required\n',
    }),
  })

  assert.deepEqual(settings, {
    allowed_owners: ['acme'],
    allowed_repositories: ['acme/control'],
    web: { favicon: './favicon.svg' },
    packages: {},
    publishing_enabled: false,
    publishing_control_repositories: ['acme/control'],
    publishing_reviewers: [],
    policy_resolution: {
      status: 'unavailable',
      reason: 'control-plane is required',
    },
    policy_document: null,
    policy_source: '',
  })
})

test('dashboard control settings report resolver crashes without widening scope', () => {
  const settings = resolveDashboardControlSettings({
    ...options,
    readPolicy: () => {
      throw new Error('missing policy')
    },
    execute: () => {
      throw new Error('resolver crashed')
    },
  })

  assert.equal(settings.policy_resolution.status, 'unavailable')
  assert.equal(settings.policy_resolution.reason, 'resolver crashed')
  assert.deepEqual(settings.allowed_repositories, ['acme/control'])
  assert.deepEqual(settings.packages, {})
})
