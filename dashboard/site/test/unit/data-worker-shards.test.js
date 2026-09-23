import { describe, expect, it } from 'vitest';
import {
  publishedRunRecordShards,
  publishedPhasedActivityShards,
  publishedRunInformationShards
} from '../../src/data-worker.js';

describe('published activity shards', () => {
  it('recognizes phased run-information and record shards', () => {
    const name = `gh-aw-logs-1000-a-${'b'.repeat(64)}-${'c'.repeat(16)}.jsonl`;
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
    const first = `gh-aw-logs-1000-a-${'a'.repeat(64)}-${'b'.repeat(16)}.jsonl`;
    const second = `gh-aw-logs-2000-b-${'c'.repeat(64)}-${'d'.repeat(16)}.jsonl`;
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
    const name = `gh-aw-logs-1000-a-${'a'.repeat(64)}-${'b'.repeat(16)}.jsonl`;
    expect(publishedPhasedActivityShards({
      [`gh-aw-logs-records/${name}`]: 'f'.repeat(64)
    })).toEqual([]);
  });

  it('rejects JSON files for every normalized shard family', () => {
    const hash = 'f'.repeat(64);
    const normalized = `${'a'.repeat(64)}-${'b'.repeat(16)}.json`;
    const phased = `gh-aw-logs-1000-a-${'c'.repeat(64)}-${'d'.repeat(16)}.json`;
    const hashes = {
      [`gh-aw-logs-normalized/${normalized}`]: hash,
      [`gh-aw-logs-runs/${phased}`]: hash,
      [`gh-aw-logs-records/${phased}`]: hash
    };

    expect(publishedRunInformationShards(hashes)).toEqual([]);
    expect(publishedRunRecordShards(hashes)).toEqual([]);
    expect(publishedPhasedActivityShards(hashes)).toEqual([]);
  });
});
