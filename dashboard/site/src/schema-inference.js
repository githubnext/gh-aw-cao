const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_SAMPLE_ROWS = 50;
const MAX_SCHEMA_PROPERTIES = 12;

/**
 * @typedef {{ kind: 'primitive', type: string }
 *   | { kind: 'array', element: Shape }
 *   | { kind: 'object', properties: Record<string, { shape: Shape, optional: boolean }> }
 *   | { kind: 'union', options: Shape[] }
 *   | { kind: 'circular' }} Shape
 */

/** @param {unknown[]} rows */
export function inferJsonSchema(rows) {
  const samples = rows.slice(0, MAX_SCHEMA_SAMPLE_ROWS);
  if (samples.length === 0) return '{}';
  return formatShape(mergeShapes(samples.map((row) => inferShape(row, new Set()))));
}

/** @param {unknown} value @param {Set<object>} openContainers @param {number} [depth] @returns {Shape} */
function inferShape(value, openContainers, depth = 0) {
  if (Array.isArray(value)) {
    if (openContainers.has(value)) return { kind: 'circular' };
    if (depth >= MAX_SCHEMA_DEPTH) return { kind: 'primitive', type: 'array' };
    openContainers.add(value);
    try {
      const elements = value.map((item) => inferShape(item, openContainers, depth + 1));
      return { kind: 'array', element: elements.length ? mergeShapes(elements) : { kind: 'primitive', type: 'unknown' } };
    } finally {
      openContainers.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (openContainers.has(value)) return { kind: 'circular' };
    if (depth >= MAX_SCHEMA_DEPTH) return { kind: 'primitive', type: 'object' };
    openContainers.add(value);
    try {
      return {
        kind: 'object',
        properties: Object.fromEntries(Object.entries(value).map(([key, property]) => [
          key,
          { shape: inferShape(property, openContainers, depth + 1), optional: false }
        ]))
      };
    } finally {
      openContainers.delete(value);
    }
  }
  return { kind: 'primitive', type: valueType(value) };
}

/** @param {Shape[]} shapes @returns {Shape} */
function mergeShapes(shapes) {
  if (shapes.length === 0) return { kind: 'primitive', type: 'unknown' };
  if (shapes.length === 1) return shapes[0];
  const kinds = new Set(shapes.map((shape) => shape.kind));
  if (kinds.size === 1 && kinds.has('circular')) return { kind: 'circular' };
  if (kinds.size === 1 && kinds.has('primitive')) {
    const types = [...new Set(shapes.map((shape) => /** @type {{ type: string }} */ (shape).type))].sort();
    const knownTypes = types.filter((type) => type !== 'unknown');
    return { kind: 'primitive', type: (knownTypes.length ? knownTypes : types).join(' | ') };
  }
  if (kinds.size === 1 && kinds.has('array')) {
    return {
      kind: 'array',
      element: mergeShapes(/** @type {Array<{ element: Shape }>} */ (shapes).map((shape) => shape.element))
    };
  }
  if (kinds.size === 1 && kinds.has('object')) {
    const objects = /** @type {Array<{ properties: Record<string, { shape: Shape, optional: boolean }>}>} */ (shapes);
    const keys = [...new Set(objects.flatMap((shape) => Object.keys(shape.properties)))].sort();
    return {
      kind: 'object',
      properties: Object.fromEntries(keys.map((key) => {
        const observed = objects.map((shape) => shape.properties[key]).filter(Boolean);
        return [key, {
          shape: mergeShapes(observed.map((property) => property.shape)),
          optional: observed.length < objects.length || observed.some((property) => property.optional)
        }];
      }))
    };
  }
  const options = shapes.filter((shape, index) =>
    shapes.findIndex((candidate) => formatShape(candidate) === formatShape(shape)) === index
  );
  return options.length === 1 ? options[0] : { kind: 'union', options };
}

/** @param {Shape} shape @returns {string} */
function formatShape(shape) {
  if (shape.kind === 'circular') return '(circular)';
  if (shape.kind === 'primitive') return shape.type;
  if (shape.kind === 'union') return shape.options.map(formatShape).join(' | ');
  if (shape.kind === 'array') return `${formatShape(shape.element)}[]`;
  const keys = Object.keys(shape.properties).sort();
  if (!keys.length) return '{}';
  const visibleKeys = keys.slice(0, MAX_SCHEMA_PROPERTIES);
  /** @type {string[]} */
  const fields = visibleKeys.map((key) => {
    const property = shape.properties[key];
    return `${key}${property.optional ? '?' : ''}: ${formatShape(property.shape)}`;
  });
  if (keys.length > visibleKeys.length) fields.push(`… +${keys.length - visibleKeys.length} more`);
  return `{ ${fields.join(', ')} }`;
}

/** @param {unknown} value */
function valueType(value) {
  if (value === null) return 'null';
  return typeof value;
}
