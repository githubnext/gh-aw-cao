import { describe, expect, it } from 'vitest';
import { publishedJsonlShards, publishedNormalizedShards } from '../../src/data-worker.js';

describe('published activity shards', () => {
  it('recognizes hashed normalized JSON independently from compatibility JSONL', () => {
    const hashes = {
      'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64),
      [`gh-aw-logs-normalized/${'b'.repeat(64)}-${'c'.repeat(16)}.json`]: 'd'.repeat(64),
      'gh-aw-logs-normalized/invalid.json': 'e'.repeat(64)
    };

    expect(publishedNormalizedShards(hashes)).toEqual([{
      name: `gh-aw-logs-normalized/${'b'.repeat(64)}-${'c'.repeat(16)}.json`,
      hash: 'd'.repeat(64)
    }]);
    expect(publishedJsonlShards(hashes)).toEqual([{
      name: 'gh-aw-logs-shards/logs-1.jsonl',
      hash: 'a'.repeat(64)
    }]);
  });
});
