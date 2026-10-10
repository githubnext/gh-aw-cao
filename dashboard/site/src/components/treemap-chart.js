import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { MAX_TREEMAP_LEAVES } from '../specification.js';
import { createDebug } from '../debug.js';
import { renderEmptyMessage, renderTooltip } from './ui-primitives.js';
import { renderSafeLink } from './link-content.js';
import { createFactoryScope } from './factory-elements.js';
import { tileTreemap } from './treemap-layout.js';

const debug = createDebug('render:treemap');
const WIDTH = 100;
const HEIGHT = 60;
let tooltipId = 0;

/**
 * @param {import('./chart-elements.js').ChartPointLike[]} points
 * @param {string} valueLabel
 * @param {{ name: string, symbol: string, significant: number } | null} unit
 * @param {import('./treemap-layout.js').TreemapOptions} options
 * @param {(name: string, index: number) => string} seriesClassName
 */
export function renderTreemapChart(points, valueLabel, unit, options, seriesClassName) {
  const root = h('div', { className: 'chart-widget treemap-chart-widget', 'data-chart-widget': 'treemap' });
  /** @param {string} message */
  const unavailable = (message) => {
    debug({ event: 'unavailable', pointCount: points.length });
    root.append(renderEmptyMessage(message, { role: 'status' }));
    return root;
  };
  if (points.length > MAX_TREEMAP_LEAVES) return unavailable(`Treemaps support at most ${MAX_TREEMAP_LEAVES} leaves. Limit the worker query.`);
  if (points.some((point) => point.y !== null && (!Number.isFinite(point.y) || Number(point.y) < 0))) {
    return unavailable('Treemap values must be finite, non-negative numbers. Correct the source query.');
  }
  const maximum = Math.max(0, ...points.map((point) => point.y ?? 0));
  if (maximum === 0) return unavailable('No positive values to show in this treemap; missing and zero values have no area.');
  if (points.some((point) => point.y !== null && point.y > 0 && point.y / maximum < Number.EPSILON)) {
    return unavailable('The treemap value range is too wide for reliable proportional areas. Narrow the source query.');
  }
  /** @type {Map<string, Array<{ index: number, value: number }>>} */
  const groups = new Map();
  let omitted = 0;
  points.forEach((point, index) => {
    if (point.y === null || point.y === 0) {
      omitted += 1;
      return;
    }
    const group = point.section ?? '';
    const tiles = groups.get(group) ?? [];
    tiles.push({ index, value: Number(point.y) / maximum });
    groups.set(group, tiles);
  });
  const entries = [...groups.entries()];
  const bounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const grouped = entries.some(([name]) => name !== '');
  const groupTiles = tileTreemap(entries.map(([, tiles], index) => ({
    index, value: tiles.reduce((sum, tile) => sum + tile.value, 0)
  })), bounds, options);
  const padding = options.padding ?? 0.5;
  const plot = h('div', { className: 'treemap-plot', role: 'group', 'aria-label': `Treemap: ${valueLabel}` });
  const scope = createFactoryScope();
  for (const groupTile of groupTiles) {
    const [groupName, tiles] = entries[groupTile.index];
    const inset = grouped ? Math.min(padding, groupTile.width / 4, groupTile.height / 4) : 0;
    const header = grouped && groupTile.width >= 12 && groupTile.height >= 10 ? 4 : 0;
    if (grouped) {
      plot.append(h('div', {
        className: 'treemap-group',
        style: rectangleStyle(groupTile),
        'data-treemap-group': groupName,
        'aria-hidden': 'true'
      }, header ? h('span', { className: 'treemap-group-label' }, groupName || 'Ungrouped') : null));
    }
    const leafBounds = {
      x: groupTile.x + inset,
      y: groupTile.y + inset + header,
      width: groupTile.width - inset * 2,
      height: groupTile.height - inset * 2 - header
    };
    for (const tile of tileTreemap(tiles, leafBounds, options, grouped ? 1 : 0)) {
      const point = points[tile.index];
      const gap = Math.min(padding / 2, tile.width / 4, tile.height / 4);
      const rectangle = { x: tile.x + gap, y: tile.y + gap, width: tile.width - gap * 2, height: tile.height - gap * 2 };
      const value = formatNumber(Number(point.y), unit);
      const label = `${grouped ? `${groupName || 'Ungrouped'} / ` : ''}${point.x}: ${valueLabel} ${value}${point.color ? `; ${point.color}` : ''}`;
      const content = h('span', { className: 'treemap-leaf-content', 'aria-hidden': 'true' },
        h('span', { className: 'treemap-leaf-label' }, point.x),
        h('span', { className: 'treemap-leaf-value' }, value));
      const leaf = renderSafeLink(content, point.link ?? null);
      const element = leaf instanceof HTMLElement && leaf.tagName === 'A'
        ? leaf
        : h('button', { type: 'button', tabIndex: 0 }, leaf);
      element.className = `treemap-leaf ${seriesClassName(point.color ?? (groupName || point.x), tile.index)}`;
      element.dataset.treemapLeaf = point.x;
      element.dataset.treemapValue = String(point.y);
      if (rectangle.width < 10 || rectangle.height < 5) element.classList.add('treemap-leaf-small');
      const tooltip = renderTooltip({
        id: `treemap-tooltip-${++tooltipId}`,
        label,
        trigger: element,
        className: 'treemap-tile',
        contentClassName: 'treemap-tooltip',
        viewportAnchored: true,
        signal: scope.signal,
        content: [
          h('strong', null, point.x),
          ...(grouped ? [h('span', { className: 'tooltip-description' }, groupName || 'Ungrouped')] : []),
          h('span', null, `${valueLabel}: ${value}`),
          ...(point.color ? [h('span', { className: 'tooltip-description' }, point.color)] : [])
        ]
      });
      tooltip.setAttribute('style', rectangleStyle(rectangle));
      tooltip.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          tooltip.classList.add('treemap-tooltip-dismissed');
          event.stopPropagation();
        }
      }, { signal: scope.signal });
      for (const event of ['pointerenter', 'focusin']) {
        tooltip.addEventListener(event, () => tooltip.classList.remove('treemap-tooltip-dismissed'), { signal: scope.signal });
      }
      plot.append(tooltip);
    }
  }
  root.append(plot);
  scope.bind(root);
  if (omitted > 0) root.append(renderEmptyMessage(`${omitted} missing or zero-valued observations have no area.`, { role: 'status' }));
  debug({ event: 'rendered', pointCount: points.length, groupCount: groups.size, omittedCount: omitted, method: options.method ?? 'squarify' });
  return root;
}

/** @param {import('./treemap-layout.js').Rectangle} rectangle */
function rectangleStyle(rectangle) {
  return `--treemap-x: ${rectangle.x / WIDTH * 100}%; --treemap-y: ${rectangle.y / HEIGHT * 100}%; --treemap-width: ${rectangle.width / WIDTH * 100}%; --treemap-height: ${rectangle.height / HEIGHT * 100}%`;
}
