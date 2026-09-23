import { describe, expect, it } from 'vitest';
import {
  issueCoordinates,
  issueId,
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
  });

  it('keys runs by repository and GitHub run ID', () => {
    expect(runId('GitHubNext', 'GH-AW-CAO', 123456789)).toBe(
      'github:run:githubnext/gh-aw-cao:123456789'
    );
    expect(runId('githubnext', 'other', 123456789))
      .not.toBe(runId('githubnext', 'gh-aw-cao', 123456789));
  });

  it('keys issues and pull requests by repository and number', () => {
    expect(issueId('GitHubNext', 'GH-AW-CAO', 42)).toBe(
      'github:issue:githubnext/gh-aw-cao:42'
    );
    expect(issueCoordinates('https://github.com/GitHubNext/GH-AW-CAO/pull/42/files')).toEqual({
      owner: 'GitHubNext',
      repository: 'GH-AW-CAO',
      number: 42
    });
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
    expect(sourceId('audit', 'gh-aw-log', 'run-12/audit-4')).toBe(
      'audit:gh-aw-log:run-12%2Faudit-4'
    );
  });

  it('rejects missing IDs and invalid issue coordinates', () => {
    expect(() => repositoryId(' ')).toThrow('repository ID is required');
    expect(() => runId('', '', 123)).toThrow('Run repository owner and name are required');
    expect(() => runId('', 'repo', 123)).toThrow('Run repository owner and name are required');
    expect(() => issueId('owner', 'repo', 0)).toThrow('Issue number must be a positive integer');
    expect(() => issueId('owner', '', 1)).toThrow('Issue repository owner and name are required');
    expect(() => issueCoordinates('https://example.com/owner/repo/issues/1'))
      .toThrow('URL must identify a GitHub issue or pull request');
    expect(() => sourceId('audit', '', '42')).toThrow('audit source and coordinate are required');
  });
});