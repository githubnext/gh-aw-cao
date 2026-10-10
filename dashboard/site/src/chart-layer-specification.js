import { FIELD_DEFINITION_KEYS, TEMPORAL_FIELD_NAMES } from './specification.js';

export const MAX_CHART_LAYERS = 8;
export const MAX_CHART_LAYER_DEPTH = 4;
export const CHART_LAYER_TYPES = ['area', 'bar', 'line', 'dot', 'rule'];
const CHANNELS = ['x', 'y', 'color', 'href'];

/** @typedef {{ chart: string, encoding: Record<string, unknown>, path: string }} ChartLayer */

export class ChartLayerError extends TypeError {
  /** @param {string} message @param {string} path */
  constructor(message, path) {
    super(message);
    this.path = path;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves presentation inheritance only; layers never read or transform data.
 * @param {Record<string, unknown>} view
 * @returns {ChartLayer[]}
 */
export function resolveChartLayers(view) {
  /** @type {ChartLayer[]} */
  const result = [];
  /** @param {string} message @param {string} path @returns {never} */
  const fail = (message, path) => { throw new ChartLayerError(message, path); };
  /** @param {unknown} value @param {string} path */
  const encoding = (value, path) => {
    if (value === undefined) return {};
    if (!isObject(value)) fail('Layer encoding must be a mapping.', path);
    for (const [channel, definition] of Object.entries(value)) {
      if (!CHANNELS.includes(channel)) fail(`Layer encoding does not support ${channel}.`, `${path}.${channel}`);
      if (!isObject(definition)) fail('Layer channels must contain one field definition.', `${path}.${channel}`);
      for (const key of Object.keys(definition)) {
        if (!FIELD_DEFINITION_KEYS.includes(key)) fail(`Unknown field definition key "${key}".`, `${path}.${channel}.${key}`);
      }
      if (definition.aggregate !== undefined && definition.aggregate !== 'none') {
        fail('Layer aggregates must be declared in dashboard.queries.', `${path}.${channel}.aggregate`);
      }
      if (definition['time-unit'] !== undefined) {
        fail('Layer time buckets must be declared in dashboard.queries.', `${path}.${channel}.time-unit`);
      }
    }
    return value;
  };
  /** @param {unknown} layers @param {Record<string, unknown>} inherited @param {string} path @param {number} depth */
  const visit = (layers, inherited, path, depth) => {
    if (depth > MAX_CHART_LAYER_DEPTH) fail(`Chart layer nesting must not exceed ${MAX_CHART_LAYER_DEPTH} levels.`, path);
    if (!Array.isArray(layers) || layers.length === 0 || layers.length > MAX_CHART_LAYERS) {
      fail(`layer must contain between one and ${MAX_CHART_LAYERS} specifications.`, path);
    }
    layers.forEach((layer, index) => {
      const itemPath = `${path}[${index}]`;
      if (!isObject(layer)) fail('A chart layer must be a mapping.', itemPath);
      for (const key of Object.keys(layer)) {
        if (!['chart', 'encoding', 'layer'].includes(key)) fail(`Unknown chart layer key "${key}".`, `${itemPath}.${key}`);
      }
      const effective = { ...inherited, ...encoding(layer.encoding, `${itemPath}.encoding`) };
      if (layer.layer !== undefined) {
        if (layer.chart !== undefined) fail('A layer group must not also declare chart.', `${itemPath}.chart`);
        visit(layer.layer, effective, `${itemPath}.layer`, depth + 1);
      } else {
        if (typeof layer.chart !== 'string' || !CHART_LAYER_TYPES.includes(layer.chart)) {
          fail(`Layer chart must be ${CHART_LAYER_TYPES.join(', ')}.`, `${itemPath}.chart`);
        }
        result.push({ chart: layer.chart, encoding: effective, path: itemPath });
        if (result.length > MAX_CHART_LAYERS) fail(`A chart must not exceed ${MAX_CHART_LAYERS} leaf layers.`, itemPath);
      }
    });
  };
  if (view.chart !== undefined) fail('A layered view must not also declare chart.', 'chart');
  if (isObject(view.data)) {
    for (const key of ['limit', 'order-by']) {
      if (view.data[key] !== undefined) fail(`Layer ${key} must be declared in dashboard.queries.`, `data.${key}`);
    }
  }
  visit(view.layer, encoding(view.encoding, 'encoding'), 'layer', 1);
  for (const layer of result) {
    for (const channel of layer.chart === 'rule' ? ['y'] : ['x', 'y']) {
      const definition = layer.encoding[channel];
      if (!isObject(definition) || typeof definition.field !== 'string' || !definition.field) {
        fail(`Layer ${channel} must declare one field.`, `${layer.path}.encoding.${channel}`);
      }
    }
    if (layer.chart !== 'rule' && isObject(layer.encoding.x)
      && layer.encoding.x.type !== undefined
      && !['nominal', 'ordinal', 'temporal'].includes(String(layer.encoding.x.type))) {
      fail('Layer x must be nominal, ordinal, or temporal.', `${layer.path}.encoding.x.type`);
    }
  }
  const xTypes = new Set(result.filter((layer) => layer.chart !== 'rule').map((layer) => (
    isObject(layer.encoding.x) ? layer.encoding.x.type ?? (TEMPORAL_FIELD_NAMES.includes(String(layer.encoding.x.field)) ? 'temporal' : 'ordinal') : 'ordinal'
  )));
  if (xTypes.size > 1) fail('Layer x encodings must use compatible types.', 'layer');
  if (!hasIndependentLayerY(view)) {
    const units = new Set(result.map((layer) => isObject(layer.encoding.y) ? layer.encoding.y.unit ?? null : null));
    if (units.size > 1) fail('Shared y scales require matching units; use resolve.scale.y: independent.', 'layer');
  }
  if (view.resolve !== undefined) {
    const resolve = view.resolve;
    if (!isObject(resolve) || Object.keys(resolve).some((key) => key !== 'scale')
      || !isObject(resolve.scale) || Object.keys(resolve.scale).some((key) => key !== 'y')
      || !['shared', 'independent'].includes(String(resolve.scale.y))) {
      fail('resolve supports only scale.y: shared or independent.', 'resolve');
    }
  }
  return result;
}

/** @param {Record<string, unknown>} view */
export function hasIndependentLayerY(view) {
  return isObject(view.resolve) && isObject(view.resolve.scale) && view.resolve.scale.y === 'independent';
}

/** @param {ChartLayer} layer */
export function hasTemporalLayerX(layer) {
  return layer.chart !== 'rule' && isObject(layer.encoding.x)
    && (layer.encoding.x.type === 'temporal'
      || (layer.encoding.x.type === undefined && TEMPORAL_FIELD_NAMES.includes(String(layer.encoding.x.field))));
}
