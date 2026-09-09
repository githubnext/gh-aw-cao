import { describe, expect, it } from 'vitest'
import {
  jobId,
  repositoryId,
  runId,
  sourceId,
  workflowId,
} from '../../src/data/model/ids.js'

describe('canonical data identities', () => {
  it('uses immutable GitHub IDs rather than renameable labels', () => {
    expect(repositoryId(123456)).toBe('github:repository:123456')
    expect(workflowId(98765)).toBe('github:workflow:98765')
    expect(jobId(445566)).toBe('github:job:445566')
  })

  it('distinguishes attempts of the same workflow run', () => {
    expect(runId(123456789, 1)).toBe('github:run:123456789:attempt:1')
    expect(runId(123456789, 2)).not.toBe(runId(123456789, 1))
  })

  it('derives stable source-coordinate identities without random values', () => {
    expect(sourceId('session', 'gh-aw-log', 'run-12/job-4')).toBe(
      'session:gh-aw-log:run-12%2Fjob-4',
    )
  })

  it('rejects missing IDs and invalid run attempts', () => {
    expect(() => repositoryId(' ')).toThrow('repository ID is required')
    expect(() => runId(123, 0)).toThrow(
      'Run attempt must be a positive integer',
    )
    expect(() => sourceId('event', '', '42')).toThrow(
      'event source and coordinate are required',
    )
  })
})
