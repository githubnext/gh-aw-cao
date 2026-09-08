// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clampPercent, computeObservationCoverage, countBy, formatCount, formatCountNoun, formatCoveragePercent, formatRoundedPercent, pluralSuffix, slugify, text, textValue, titleCase } from '../../src/components/count-formatters.js';

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

  it('coerces values to trimmed strings, treating non-strings as empty', () => {
    expect(textValue('  hello  ')).toBe('hello');
    expect(textValue(42)).toBe('');
    expect(textValue(null)).toBe('');
    expect(textValue(undefined)).toBe('');
    expect(textValue('')).toBe('');
  });

  it('slugifies text into a lowercase, hyphen-delimited id fragment', () => {
    expect(slugify('Domain Attention')).toBe('domain-attention');
    expect(slugify('AI Credits / Usage')).toBe('ai-credits-usage');
    expect(slugify('--already--slug--')).toBe('already-slug');
    expect(slugify('')).toBe('');
    expect(slugify('', 'fallback')).toBe('fallback');
    expect(slugify('!!!', 'section')).toBe('section');
  });

  it('clamps percentages into the closed [0, 100] range', () => {
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(-10)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(100)).toBe(100);
  });

  it('computes observation coverage as usable / (usable + excluded), or null when empty', () => {
    expect(computeObservationCoverage(9, 1)).toBe(0.9);
    expect(computeObservationCoverage(0, 0)).toBeNull();
    expect(computeObservationCoverage(3, 0)).toBe(1);
  });

  it('formats coverage ratios as one-decimal percentages, with a placeholder for null', () => {
    expect(formatCoveragePercent(0.9)).toBe('90.0%');
    expect(formatCoveragePercent(0.12345)).toBe('12.3%');
    expect(formatCoveragePercent(null)).toBe('—');
    expect(formatCoveragePercent(null, 'n/a')).toBe('n/a');
  });

  it('formats ratios as whole-number percentages, with a placeholder for null/non-finite', () => {
    expect(formatRoundedPercent(0.9)).toBe('90%');
    expect(formatRoundedPercent(0.125)).toBe('13%');
    expect(formatRoundedPercent(0)).toBe('0%');
    expect(formatRoundedPercent(null)).toBe('—');
    expect(formatRoundedPercent(null, 'n/a')).toBe('n/a');
    expect(formatRoundedPercent(Number.NaN)).toBe('—');
  });

  it('tallies rows into a Map keyed by a derived label', () => {
    const rows = [{ readiness: 'ready' }, { readiness: 'blocked' }, { readiness: 'ready' }];
    const counts = countBy(rows, (row) => row.readiness);
    expect(counts.get('ready')).toBe(2);
    expect(counts.get('blocked')).toBe(1);
    expect(countBy([], (row) => row.readiness).size).toBe(0);
  });
});
