// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatCount, formatCountNoun, pluralSuffix, slugify, text, titleCase } from '../../src/components/count-formatters.js';

describe('count formatters', () => {
  it('formats counts for UI text', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1200)).toBe('1,200');
    expect(formatCount('7')).toBe('7');
    expect(formatCount(undefined)).toBe('0');
  });

  it('formats singular and plural count nouns for reusable UI copy', () => {
    expect(formatCountNoun(1, 'signal', 'signals')).toBe('1 signal');
    expect(formatCountNoun(2, 'signal', 'signals')).toBe('2 signals');
    expect(formatCountNoun(1, 'worker dispatch lacks', 'worker dispatches lack')).toBe('1 worker dispatch lacks');
    expect(formatCountNoun(3, 'worker dispatch lacks', 'worker dispatches lack')).toBe('3 worker dispatches lack');
    expect(formatCountNoun(undefined, 'workflow', 'workflows')).toBe('0 workflows');
    expect(formatCountNoun(1, 'item', 'items')).toBe('1 item');
    expect(formatCountNoun(3, 'item', 'items')).toBe('3 items');
  });

  it('title-cases kebab-case identifiers for shared display text', () => {
    expect(titleCase('not-planned')).toBe('Not Planned');
    expect(titleCase('in-progress')).toBe('In Progress');
    expect(titleCase('review')).toBe('Review');
    expect(titleCase('')).toBe('');
  });

  it('returns the regular plural suffix for a count', () => {
    expect(pluralSuffix(1)).toBe('');
    expect(pluralSuffix(0)).toBe('s');
    expect(pluralSuffix(2)).toBe('s');
    expect(pluralSuffix('1')).toBe('');
    expect(pluralSuffix(undefined)).toBe('s');
  });

  it('coerces values to display strings, treating null/undefined as empty', () => {
    expect(text('hello')).toBe('hello');
    expect(text(42)).toBe('42');
    expect(text(null)).toBe('');
    expect(text(undefined)).toBe('');
    expect(text(false)).toBe('false');
  });

  it('slugifies text into a lowercase, hyphen-delimited id fragment', () => {
    expect(slugify('Domain Attention')).toBe('domain-attention');
    expect(slugify('AI Credits / Usage')).toBe('ai-credits-usage');
    expect(slugify('--already--slug--')).toBe('already-slug');
    expect(slugify('')).toBe('');
    expect(slugify('', 'fallback')).toBe('fallback');
    expect(slugify('!!!', 'section')).toBe('section');
  });
});
