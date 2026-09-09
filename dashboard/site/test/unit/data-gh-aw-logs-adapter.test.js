import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptGhAwLogs } from '../../src/data/adapters/gh-aw-logs.js'
import { relationshipErrors } from '../../src/data/model/schema.js'
import { normalize } from '../../src/data/normalize/index.js'

const fixtureRoot = resolve('test/fixtures/gh-aw-logs')

/** @param {string} directory */
function files(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => {
      const filePath = join(entry.parentPath, entry.name)
      return {
        path: relative(fixtureRoot, filePath),
        content: readFileSync(filePath, 'utf8'),
      }
    })
}

describe('gh-aw logs adapter', () => {
  it('converts agent, gateway, and firewall JSONL into one ordered operational session', () => {
    const context = JSON.parse(readFileSync(join(fixtureRoot, 'context.json'), 'utf8'))
    const adapted = adaptGhAwLogs({ ...context, files: files(fixtureRoot) })
    const batch = normalize(adapted.observations, {
      generation: adapted.generation,
    })

    expect(relationshipErrors(batch)).toEqual([])
    expect(batch.sessions).toEqual([
      expect.objectContaining({
        runId: 'github:run:303:attempt:1',
        jobId: 'github:job:404',
        kind: 'unified-operational-log',
      }),
    ])
    expect(batch.events.map((event) => [event.sequence, event.source, event.type])).toEqual([
      [0, 'agent', 'agent_turn'],
      [1, 'gateway', 'tool_call'],
      [2, 'agent', 'agent_tool_start'],
      [3, 'agent', 'agent_tool_done'],
      [4, 'firewall', 'net_allowed'],
      [5, 'agent', 'assistant_message'],
    ])
    expect(batch.events.filter((event) => event.correlationId === 'call-1')).toHaveLength(3)
  })
})
