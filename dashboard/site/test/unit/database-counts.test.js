// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatDatabaseCounts } from '../../src/database-counts.js';

describe('database counts', () => {
  it('pluralizes each table counter', () => {
    expect(formatDatabaseCounts({
      packages: 1,
      repositories: 1,
      workflows: 1,
      runs: 1,
      events: 1
    })).toBe('1 package · 1 repository · 1 workflow · 1 run · 1 event');

    expect(formatDatabaseCounts({
      packages: 2,
      repositories: 3,
      workflows: 4,
      runs: 12,
      events: 89
    })).toBe('2 packages · 3 repositories · 4 workflows · 12 runs · 89 events');
  });
});
