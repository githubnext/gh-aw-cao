import { describe, expect, it } from 'vitest';
import { rowsFor } from '../../src/components/source-rows.js';

/** @param {unknown} rows @returns {import('../../src/presenter.js').LogicalSourceInput} */
function source(rows) {
  return /** @type {import('../../src/presenter.js').LogicalSourceInput} */ ({
    source: 'workflows',
    rows,
    metadata: /** @type {import('../../src/presenter.js').SourceMetadata} */ ({})
  });
}

describe('source-rows', () => {
  it('rowsFor returns the rows array for a known source', () => {
    const sources = { workflows: source([{ id: 1 }, { id: 2 }]) };
    expect(rowsFor(sources, 'workflows')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('rowsFor returns an empty array for a missing source', () => {
    expect(rowsFor({}, 'workflows')).toEqual([]);
  });

  it('rowsFor returns an empty array when rows is not an array', () => {
    const sources = { workflows: source('not-an-array') };
    expect(rowsFor(sources, 'workflows')).toEqual([]);
  });
});
