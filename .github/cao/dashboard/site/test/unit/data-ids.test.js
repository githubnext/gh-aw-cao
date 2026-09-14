import { describe, expect, it } from 'vitest';
import {
  jobId,
  repositoryCoordinateId,
  repositoryId,
  runId,
  sourceId,
  workflowCoordinateId,
  workflowId,
  workflowSourcePath
} from '../../src/data/model/ids.js';

describe('canonical data identities', () => {
  it('uses immutable GitHub IDs rather than renameable labels', () => {
    expect(repositoryId(123456)).toBe('github:repository:123456');
    expect(workflowId(98765)).toBe('github:workflow:98765');
    expect(jobId(445566)).toBe('github:job:445566');
  });

  it('distinguishes attempts of the same workflow run', () => {
    expect(runId(123456789, 1)).toBe('github:run:123456789:attempt:1');
    expect(runId(123456789, 2)).not.toBe(runId(123456789, 1));
  });

  it('normalizes repository coordinates independently of their source', () => {
    expect(repositoryCoordinateId('GitHubNext', 'GH-AW-CAO')).toBe(
      'repository:githubnext%2Fgh-aw-cao'
    );
  });

  it('maps compiled workflows to their authored workflow coordinate', () => {
    expect(workflowSourcePath('.github/workflows/Example.lock.yml')).toBe(
      '.github/workflows/example.md'
    );
    expect(workflowCoordinateId('GitHubNext', 'GH-AW-CAO', '.github/workflows/example.lock.yml')).toBe(
      workflowCoordinateId('githubnext', 'gh-aw-cao', '.github/workflows/example.md')
    );
  });

  it('derives stable source-coordinate identities without random values', () => {
    expect(sourceId('session', 'gh-aw-log', 'run-12/job-4')).toBe(
      'session:gh-aw-log:run-12%2Fjob-4'
    );
  });

  it('rejects missing IDs and invalid run attempts', () => {
    expect(() => repositoryId(' ')).toThrow('repository ID is required');
    expect(() => runId(123, 0)).toThrow('Run attempt must be a positive integer');
    expect(() => sourceId('event', '', '42')).toThrow('event source and coordinate are required');
  });
});