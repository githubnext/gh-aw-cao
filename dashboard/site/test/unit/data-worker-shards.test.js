import { describe, expect, it } from 'vitest';
import {
  publishedRunRecordShards,
  publishedJsonlShards,
  publishedNormalizedShards,
  publishedPhasedActivityShards,
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

  it('recognizes phased run-information and record shards', () => {
    const name = `gh-aw-logs-1000-a-${'b'.repeat(64)}-${'c'.repeat(16)}.json`;
    const hashes = {
      [`gh-aw-logs-runs/${name}`]: 'd'.repeat(64),
      [`gh-aw-logs-records/${name}`]: 'e'.repeat(64)
    };

    expect(publishedRunInformationShards(hashes)).toEqual([{
      name: `gh-aw-logs-runs/${name}`,
      hash: 'd'.repeat(64),
      phase: 'runs'
    }]);
    expect(publishedRunRecordShards(hashes)).toEqual([{
      name: `gh-aw-logs-records/${name}`,
      hash: 'e'.repeat(64),
      phase: 'records'
    }]);
    expect(publishedPhasedActivityShards(hashes)).toHaveLength(2);
  });

  it('accepts independently filtered run and record shard sets', () => {
    const first = `gh-aw-logs-1000-a-${'a'.repeat(64)}-${'b'.repeat(16)}.json`;
    const second = `gh-aw-logs-2000-b-${'c'.repeat(64)}-${'d'.repeat(16)}.json`;
    const shards = publishedPhasedActivityShards({
      [`gh-aw-logs-runs/${first}`]: 'e'.repeat(64),
      [`gh-aw-logs-records/${second}`]: 'f'.repeat(64)
    });
    expect(shards.map(({ name }) => name)).toEqual([
      `gh-aw-logs-runs/${first}`,
      `gh-aw-logs-records/${second}`
    ]);
    expect(publishedPhasedActivityShards({
      [`gh-aw-logs-runs/${first}`]: 'e'.repeat(64)
    })).toHaveLength(1);
  });

  it('rejects phased manifests without run information', () => {
    const name = `gh-aw-logs-1000-a-${'a'.repeat(64)}-${'b'.repeat(16)}.json`;
    expect(publishedPhasedActivityShards({
      [`gh-aw-logs-records/${name}`]: 'f'.repeat(64)
    })).toEqual([]);
  });
});
