export const SIMULATION_DAYS = 'simulation-days';

/** A bounded, deterministic source independent of canonical storage. */
export function simulationDaysSource() {
  return /** @type {import('../../presenter.js').LogicalSourceInput} */ ({
    source: SIMULATION_DAYS,
    rows: Array.from({ length: 30 }, (_, index) => ({
      day: index + 1,
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString()
    })),
    metadata: {
      'source-id': SIMULATION_DAYS,
      'source-kind': 'synthetic',
      'as-of': '1970-01-01T00:00:00.000Z',
      'retrieved-at': '1970-01-01T00:00:00.000Z',
      availability: 'available',
      completeness: 'complete',
      freshness: 'fresh'
    }
  });
}
