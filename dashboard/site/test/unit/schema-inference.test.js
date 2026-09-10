import { describe, expect, it } from 'vitest';
import { inferJsonSchema } from '../../src/schema-inference.js';

describe('JSON schema inference', () => {
  it('infers optional fields and mixed primitive types from bounded rows', () => {
    expect(inferJsonSchema([
      { id: 1, detail: 'ready' },
      { id: '2' }
    ])).toBe('{ detail?: string, id: number | string }');
  });

  it('bounds recursive values', () => {
    const recursive = /** @type {Record<string, unknown>} */ ({ id: 1 });
    recursive.self = recursive;
    expect(inferJsonSchema([recursive])).toBe('{ id: number, self: (circular) }');
  });
});
