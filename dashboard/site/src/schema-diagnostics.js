/**
 * Pseudo-JSON schema inference for sampled dashboard source rows.
 */

const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_SAMPLE_ROWS = 50;
const MAX_SCHEMA_PROPERTIES = 12;

/**
 * @typedef {{ kind: 'primitive', type: string }
 *   | { kind: 'array', element: Shape, minItems: number, maxItems: number }
 *   | { kind: 'object', properties: Record<string, { shape: Shape, optional: boolean }> }
 *   | { kind: 'union', options: Shape[] }
 *   | { kind: 'circular' }} Shape
 */

/**
 * @param {string} name
 * @param {{ rows?: Array<Record<string, unknown>> }} source
 * @returns {{ source: string, schema: string }}
 */
export function schemaDiagnostic(name, source) {
  const rows = Array.isArray(source?.rows) ? source.rows.slice(0, MAX_SCHEMA_SAMPLE_ROWS) : [];
  if (rows.length === 0) return { source: name, schema: '{}' };
  const rowShapes = rows.map((row) => inferShape(row, new Set()));
  return { source: name, schema: formatShape(mergeShapes(rowShapes), 0) };
}

/**
 * @param {{ rows?: Array<Record<string, unknown>> }} source
 * @returns {unknown}
 */
export function schemaDiagnosticValue(source) {
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  if (rows.length === 0) return ['// 0 items'];
  const rowShapes = rows
    .slice(0, MAX_SCHEMA_SAMPLE_ROWS)
    .map((row) => inferShape(row, new Set()));
  return [
    `// ${arrayItemCount(rows.length, rows.length)}`,
    shapeValue(mergeShapes(rowShapes))
  ];
}

/**
 * @param {unknown} value
 * @param {Set<object>} openContainers
 * @param {number} [depth]
 * @returns {Shape}
 */
function inferShape(value, openContainers, depth = 0) {
  if (Array.isArray(value)) {
    if (openContainers.has(value)) return { kind: 'circular' };
    if (depth >= MAX_SCHEMA_DEPTH) return { kind: 'primitive', type: 'array' };
    openContainers.add(value);
    try {
      const elementShapes = value.map((item) => inferShape(item, openContainers, depth + 1));
      return {
        kind: 'array',
        element: elementShapes.length > 0
          ? mergeShapes(elementShapes)
          : { kind: 'primitive', type: 'unknown' },
        minItems: value.length,
        maxItems: value.length
      };
    } finally {
      openContainers.delete(value);
    }
  }
  if (value !== null && typeof value === 'object') {
    if (openContainers.has(value)) return { kind: 'circular' };
    if (depth >= MAX_SCHEMA_DEPTH) return { kind: 'primitive', type: 'object' };
    openContainers.add(value);
    try {
      /** @type {Record<string, { shape: Shape, optional: boolean }>} */
      const properties = {};
      for (const [key, propertyValue] of Object.entries(value)) {
        properties[key] = { shape: inferShape(propertyValue, openContainers, depth + 1), optional: false };
      }
      return { kind: 'object', properties };
    } finally {
      openContainers.delete(value);
    }
  }
  return { kind: 'primitive', type: valueType(value) };
}

/**
 * @param {Shape[]} shapes
 * @returns {Shape}
 */
function mergeShapes(shapes) {
  if (shapes.length === 0) return { kind: 'primitive', type: 'unknown' };
  if (shapes.length === 1) return shapes[0];
  const kinds = new Set(shapes.map((shape) => shape.kind));
  if (kinds.size === 1 && kinds.has('circular')) return { kind: 'circular' };
  if (kinds.size === 1 && kinds.has('primitive')) {
    const types = [...new Set(shapes.map((shape) => /** @type {{ type: string }} */ (shape).type))].sort();
    const knownTypes = types.filter((type) => type !== 'unknown');
    return { kind: 'primitive', type: (knownTypes.length > 0 ? knownTypes : types).join(' | ') };
  }
  if (kinds.size === 1 && kinds.has('array')) {
    const arrayShapes = /** @type {Array<{ element: Shape, minItems: number, maxItems: number }>} */ (shapes);
    return {
      kind: 'array',
      element: mergeShapes(arrayShapes.map((shape) => shape.element)),
      minItems: Math.min(...arrayShapes.map((shape) => shape.minItems)),
      maxItems: Math.max(...arrayShapes.map((shape) => shape.maxItems))
    };
  }
  if (kinds.size === 1 && kinds.has('object')) {
    const objectShapes = /** @type {Array<{ properties: Record<string, { shape: Shape, optional: boolean }>}>} */ (shapes);
    const keys = [...new Set(objectShapes.flatMap((shape) => Object.keys(shape.properties)))].sort();
    /** @type {Record<string, { shape: Shape, optional: boolean }>} */
    const properties = {};
    for (const key of keys) {
      const observed = objectShapes.map((shape) => shape.properties[key]).filter((property) => property !== undefined);
      properties[key] = {
        shape: mergeShapes(observed.map((property) => property.shape)),
        optional: observed.length < objectShapes.length || observed.some((property) => property.optional)
      };
    }
    return { kind: 'object', properties };
  }
  /** @type {Shape[]} */
  const distinctOptions = [];
  for (const shape of shapes) {
    if (!distinctOptions.some((option) => formatShape(option, 0) === formatShape(shape, 0))) {
      distinctOptions.push(shape);
    }
  }
  return distinctOptions.length === 1 ? distinctOptions[0] : { kind: 'union', options: distinctOptions };
}

/**
 * @param {Shape} shape
 * @param {number} depth
 * @returns {string}
 */
function formatShape(shape, depth) {
  if (shape.kind === 'circular') return '(circular)';
  if (shape.kind === 'primitive') return shape.type;
  if (shape.kind === 'union') return shape.options.map((option) => formatShape(option, depth)).join(' | ');
  if (shape.kind === 'array') return `${formatShape(shape.element, depth + 1)}[]`;
  const keys = Object.keys(shape.properties).sort();
  if (keys.length === 0) return '{}';
  const visibleKeys = keys.slice(0, MAX_SCHEMA_PROPERTIES);
  const fields = visibleKeys.map((key) => {
    const property = shape.properties[key];
    return `${key}${property.optional ? '?' : ''}: ${formatShape(property.shape, depth + 1)}`;
  });
  if (keys.length > visibleKeys.length) fields.push(`… +${keys.length - visibleKeys.length} more`);
  return `{ ${fields.join(', ')} }`;
}

/**
 * @param {Shape} shape
 * @returns {unknown}
 */
function shapeValue(shape) {
  if (shape.kind === 'circular') return '(circular)';
  if (shape.kind === 'primitive') return shape.type;
  if (shape.kind === 'union') return shape.options.map((option) => formatShape(option, 0)).join(' | ');
  if (shape.kind === 'array') {
    return [`// ${arrayItemCount(shape.minItems, shape.maxItems)}`, shapeValue(shape.element)];
  }

  const keys = Object.keys(shape.properties).sort();
  const visibleKeys = keys.slice(0, MAX_SCHEMA_PROPERTIES);
  /** @type {Record<string, unknown>} */
  const value = {};
  for (const key of visibleKeys) {
    const property = shape.properties[key];
    value[`${key}${property.optional ? '?' : ''}`] = shapeValue(property.shape);
  }
  if (keys.length > visibleKeys.length) value['...'] = `+${keys.length - visibleKeys.length} more properties`;
  return value;
}

/**
 * @param {number} minItems
 * @param {number} maxItems
 */
function arrayItemCount(minItems, maxItems) {
  if (minItems === maxItems) return `${minItems} ${minItems === 1 ? 'item' : 'items'}`;
  return `${minItems}-${maxItems} items`;
}

/** @param {unknown} value */
function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
