import assert from 'node:assert/strict'
import test from 'node:test'
import { setActionsGlobals } from '../../activity/actions-context.mjs'

test('Actions context exposes the github-script singleton as globals', () => {
  const originals = Object.fromEntries(
    ['core', 'github', 'context', 'exec', 'io', 'getOctokit'].map((name) => [
      name,
      globalThis[name],
    ]),
  )
  const actions = {
    core: { info() {} },
    github: { rest: {} },
    context: { repo: {} },
    exec: { exec() {} },
    io: { cp() {} },
    getOctokit() {},
  }

  try {
    setActionsGlobals(actions)
    for (const [name, value] of Object.entries(actions))
      assert.equal(globalThis[name], value)
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
})
