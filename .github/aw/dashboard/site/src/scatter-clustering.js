export const MAX_RENDERED_SCATTER_POINTS = 400;

/**
 * @typedef {{
 *   key: string,
 *   x: string,
 *   y: number,
 *   color: string | null,
 *   link: { href: string, label: string } | null,
 *   source?: Record<string, unknown>
 * } & Record<string, unknown>} ScatterPoint
 */

/**
 * Reduces scatter observations to bounded temporal clusters while preserving
 * every color series when the cluster budget permits.
 * @param {ScatterPoint[]} points
 * @param {number} [maximumClusters]
 * @returns {ScatterPoint[]}
 */
export function clusterScatterPoints(points, maximumClusters = MAX_RENDERED_SCATTER_POINTS) {
  const limit = Math.max(1, Math.floor(maximumClusters));
  if (points.length <= limit) return points;

  /** @type {Map<string, ScatterPoint[]>} */
  const grouped = new Map();
  for (const point of points) {
    const key = point.color ?? 'value';
    const series = grouped.get(key) ?? [];
    series.push(point);
    grouped.set(key, series);
  }

  const series = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const quotas = allocateClusterQuotas(series.map(([, entries]) => entries.length), limit);

  return series.flatMap(([name, entries], seriesIndex) => {
    const sorted = [...entries].sort((left, right) => Date.parse(left.x) - Date.parse(right.x));
    const quota = quotas[seriesIndex];
    return Array.from({ length: quota }, (_, clusterIndex) => {
      const start = Math.floor((clusterIndex * sorted.length) / quota);
      const end = Math.floor(((clusterIndex + 1) * sorted.length) / quota);
      const cluster = sorted.slice(start, end);
      if (cluster.length === 1) return cluster[0];
      const timestamps = cluster.map((point) => Date.parse(point.x)).filter(Number.isFinite);
      const values = cluster.map((point) => point.y).filter(Number.isFinite);
      const timestamp = timestamps.reduce((sum, value) => sum + value, 0) / timestamps.length;
      const y = values.reduce((sum, value) => sum + value, 0) / values.length;
      return /** @type {ScatterPoint} */ ({
        ...cluster[0],
        key: `scatter-cluster:${seriesIndex}:${clusterIndex}`,
        x: timestamps.length > 0 ? new Date(timestamp).toISOString() : cluster[0].x,
        y: values.length > 0 ? y : cluster[0].y,
        color: name === 'value' ? null : name,
        link: null,
        source: { 'cluster-count': cluster.length }
      });
    });
  });
}

/**
 * @param {number[]} sizes
 * @param {number} limit
 * @returns {number[]}
 */
function allocateClusterQuotas(sizes, limit) {
  if (sizes.length >= limit) {
    return sizes.map((_, index) => index < limit ? 1 : 0);
  }
  const quotas = sizes.map(() => 1);
  let remaining = limit - sizes.length;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const shares = sizes.map((size, index) => ({
    index,
    exact: (size / total) * remaining
  }));
  for (const share of shares) {
    const addition = Math.min(sizes[share.index] - 1, Math.floor(share.exact));
    quotas[share.index] += addition;
    remaining -= addition;
  }
  shares.sort((left, right) => (right.exact % 1) - (left.exact % 1) || left.index - right.index);
  while (remaining > 0) {
    const candidate = shares.find(({ index }) => quotas[index] < sizes[index]);
    if (!candidate) break;
    quotas[candidate.index] += 1;
    remaining -= 1;
  }
  return quotas;
}
