/**
 * Presentation-only rectangle tiling. Input order and values are supplied by
 * the worker query; this module does not select, aggregate, or sort source rows.
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rectangle */
/** @typedef {{ index: number, value: number }} Tile */
/** @typedef {{ method?: 'squarify'|'binary'|'slicedice', ratio?: number, padding?: number }} TreemapOptions */
/** @typedef {Tile & Rectangle} PlacedTile */

/**
 * @param {Tile[]} tiles
 * @param {Rectangle} bounds
 * @param {TreemapOptions} [options]
 * @param {number} [depth]
 * @returns {PlacedTile[]}
 */
export function tileTreemap(tiles, bounds, options = {}, depth = 0) {
  if (tiles.length === 0 || bounds.width <= 0 || bounds.height <= 0) return [];
  const maximum = Math.max(...tiles.map((tile) => tile.value));
  if (!Number.isFinite(maximum) || maximum <= 0
      || tiles.some((tile) => !Number.isFinite(tile.value) || tile.value <= 0)) {
    throw new RangeError('Treemap layout requires finite positive tile values.');
  }
  const weights = tiles.map((tile) => ({ ...tile, value: tile.value / maximum }));
  const total = weights.reduce((sum, tile) => sum + tile.value, 0);
  const method = options.method ?? 'squarify';
  if (method === 'binary') return binary(weights, bounds, total);
  if (method === 'slicedice') return slice(weights, bounds, total, depth % 2 === 0);
  return squarify(weights, bounds, total, options.ratio ?? 1.618);
}

/** @param {Tile[]} tiles @param {Rectangle} bounds @param {number} total @param {boolean} vertical */
function slice(tiles, bounds, total, vertical) {
  let offset = 0;
  return tiles.map((tile) => {
    const length = vertical ? bounds.width : bounds.height;
    const size = length * (tile.value / total);
    const placed = {
      ...tile,
      x: bounds.x + (vertical ? offset : 0),
      y: bounds.y + (vertical ? 0 : offset),
      width: vertical ? size : bounds.width,
      height: vertical ? bounds.height : size
    };
    offset += size;
    return placed;
  });
}

/** @param {Tile[]} tiles @param {Rectangle} bounds @param {number} total @returns {PlacedTile[]} */
function binary(tiles, bounds, total) {
  if (tiles.length === 1) return [{ ...tiles[0], ...bounds }];
  let split = 1;
  let leftTotal = tiles[0].value;
  while (split < tiles.length - 1
      && Math.abs(leftTotal + tiles[split].value - total / 2) < Math.abs(leftTotal - total / 2)) {
    leftTotal += tiles[split++].value;
  }
  const vertical = bounds.width >= bounds.height;
  const fraction = leftTotal / total;
  const left = { ...bounds, width: vertical ? bounds.width * fraction : bounds.width, height: vertical ? bounds.height : bounds.height * fraction };
  const right = {
    x: bounds.x + (vertical ? left.width : 0),
    y: bounds.y + (vertical ? 0 : left.height),
    width: vertical ? bounds.width - left.width : bounds.width,
    height: vertical ? bounds.height : bounds.height - left.height
  };
  return [...binary(tiles.slice(0, split), left, leftTotal), ...binary(tiles.slice(split), right, total - leftTotal)];
}

/** @param {Tile[]} tiles @param {Rectangle} bounds @param {number} total @param {number} ratio */
function squarify(tiles, bounds, total, ratio) {
  /** @type {PlacedTile[]} */
  const placed = [];
  let remaining = { ...bounds };
  let remainingTotal = total;
  let start = 0;
  while (start < tiles.length) {
    const vertical = remaining.width >= remaining.height;
    const short = vertical ? remaining.height : remaining.width;
    const areaScale = remaining.width * remaining.height / remainingTotal;
    let end = start + 1;
    let rowTotal = tiles[start].value;
    let minimum = rowTotal;
    let maximum = rowTotal;
    const score = () => Math.max(
      short * short * maximum / (ratio * rowTotal * rowTotal * areaScale),
      ratio * rowTotal * rowTotal * areaScale / (short * short * minimum)
    );
    let worst = score();
    while (end < tiles.length) {
      const value = tiles[end].value;
      const previousTotal = rowTotal;
      const previousMinimum = minimum;
      const previousMaximum = maximum;
      rowTotal += value;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      const next = score();
      if (next > worst) {
        rowTotal = previousTotal;
        minimum = previousMinimum;
        maximum = previousMaximum;
        break;
      }
      worst = next;
      end += 1;
    }
    const length = vertical ? remaining.width : remaining.height;
    const size = end === tiles.length ? length : length * (rowTotal / remainingTotal);
    const strip = { ...remaining, width: vertical ? size : remaining.width, height: vertical ? remaining.height : size };
    placed.push(...slice(tiles.slice(start, end), strip, rowTotal, !vertical));
    remaining = {
      x: remaining.x + (vertical ? size : 0),
      y: remaining.y + (vertical ? 0 : size),
      width: vertical ? remaining.width - size : remaining.width,
      height: vertical ? remaining.height : remaining.height - size
    };
    remainingTotal -= rowTotal;
    start = end;
  }
  return placed;
}
