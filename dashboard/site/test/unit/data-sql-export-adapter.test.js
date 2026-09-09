import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adaptSqlExport } from '../../src/data/adapters/sql-export.js'
import { relationshipErrors } from '../../src/data/model/schema.js'
import { normalize } from '../../src/data/normalize/index.js'

function fixture() {
  return JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v1.json'), 'utf8'))
}

describe('SQL export adapter', () => {
  it('converts a versioned static export into a complete ordered canonical graph', () => {
    const adapted = adaptSqlExport(fixture())
    const batch = normalize(adapted.observations, {
      generation: adapted.generation,
    })

    expect(relationshipErrors(batch)).toEqual([])
    expect(batch).toMatchObject({
      repositories: [{ id: 'github:repository:101', fullName: 'githubnext/gh-aw-cao' }],
      workflows: [{ id: 'github:workflow:202', repositoryId: 'github:repository:101' }],
      runs: [
        {
          id: 'github:run:303:attempt:1',
          repositoryId: 'github:repository:101',
          workflowId: 'github:workflow:202',
        },
      ],
      jobs: [{ id: 'github:job:404', runId: 'github:run:303:attempt:1' }],
      sessions: [
        {
          id: 'session:sql%3Aenterprise-warehouse:session-505',
          runId: 'github:run:303:attempt:1',
          jobId: 'github:job:404',
        },
      ],
    })
    expect(batch.events.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'message.user'],
      [1, 'firewall.request.allowed'],
    ])
  })

  it('rejects unknown schema versions', () => {
    expect(() => adaptSqlExport({ ...fixture(), schema_version: 2 })).toThrow('Unsupported SQL export schema version: 2')
  })
})
