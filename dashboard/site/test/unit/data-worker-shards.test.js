import { describe, expect, it } from 'vitest';
import {
  publishedEventShards,
  publishedJsonlShards,
  publishedNormalizedShards,
  publishedRunInformationShards
} from '../../src/data-worker.js';

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

  it('recognizes phased run-information and event shards', () => {
    const name = `${'b'.repeat(64)}-${'c'.repeat(16)}.json`;
    const hashes = {
      [`gh-aw-logs-runs/${name}`]: 'd'.repeat(64),
      [`gh-aw-logs-events/${name}`]: 'e'.repeat(64)
    };

    expect(publishedRunInformationShards(hashes)).toEqual([{
      name: `gh-aw-logs-runs/${name}`,
      hash: 'd'.repeat(64),
      phase: 'runs'
    }]);
    expect(publishedEventShards(hashes)).toEqual([{
      name: `gh-aw-logs-events/${name}`,
      hash: 'e'.repeat(64),
      phase: 'events'
    }]);
  });
});
