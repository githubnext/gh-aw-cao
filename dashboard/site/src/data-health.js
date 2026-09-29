/**
 * Deterministic evidence-confidence diagnostics for the dashboard.
 */

/**
 * @typedef {import('./presenter.js').LogicalSourceInput} LogicalSourceInput
 * @typedef {import('./presenter.js').SourceMetadata} SourceMetadata
 */

/**
 * Infers per-source schemas for the offline dashboard data-schema report.
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {Record<string, LogicalSourceInput>}
 */
export function deriveDataHealthSources(sources) {
  const metadata = combineSourceMetadata(Object.values(sources));
  const schemaRows = Object.entries(sources).map(([name, source]) => schemaDiagnostic(name, source));
  return {
    'data-health-schema': healthSource('data-health-schema', schemaRows, metadata)
  };
}

/** @param {string} name @param {Array<Record<string, unknown>>} rows @param {SourceMetadata} metadata */
function healthSource(name, rows, metadata) {
  return { source: name, rows, metadata };
}

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

/** @param {string} name @param {LogicalSourceInput} source */
function schemaDiagnostic(name, source) {
  const rows = Array.isArray(source?.rows) ? source.rows.slice(0, MAX_SCHEMA_SAMPLE_ROWS) : [];
  if (rows.length === 0) return { source: name, schema: '{}' };
  const rowShapes = rows.map((row) => inferShape(row, new Set()));
  return { source: name, schema: formatShape(mergeShapes(rowShapes), 0) };
}

/**
 * Recursively infers the structural shape of a JSON-like value, merging the shapes observed
 * across array elements and object properties. Reference cycles are detected by tracking the
 * containers currently open on the recursion path (rather than every container ever visited),
 * so sibling values never falsely trigger a cycle and self-referential input cannot recurse
 * without bound.
 * @param {unknown} value
 * @param {Set<object>} openContainers containers currently being visited on this recursion path
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
      return { kind: 'array', element: elementShapes.length > 0 ? mergeShapes(elementShapes) : { kind: 'primitive', type: 'unknown' } };
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
 * Merges multiple shapes observed for the same position (array elements, or the same object
 * property across samples) into a single representative shape. Object shapes are merged
 * property-by-property, marking a property optional when it is absent from at least one sample.
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
    const elementShapes = /** @type {Array<{ element: Shape }>} */ (shapes).map((shape) => shape.element);
    return { kind: 'array', element: mergeShapes(elementShapes) };
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
    if (!distinctOptions.some((option) => formatShape(option, 0) === formatShape(shape, 0))) distinctOptions.push(shape);
  }
  return distinctOptions.length === 1 ? distinctOptions[0] : { kind: 'union', options: distinctOptions };
}

/**
 * Renders a shape into a compact, JSON-Schema-like preview string, truncating wide objects and
 * marking previously detected cycles so the preview never grows unbounded.
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

/** @param {unknown} value */
function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * @param {LogicalSourceInput[]} sources
 * @returns {SourceMetadata}
 */
function combineSourceMetadata(sources) {
  const metadata = sources.map((source) => source?.metadata).filter(Boolean);
  const retrieved = metadata.map((value) => value['retrieved-at']).filter(Boolean).sort().at(-1);
  const now = retrieved ?? new Date().toISOString();
  return {
    'source-id': 'data-health',
    'source-kind': 'derived',
    'as-of': now,
    'retrieved-at': now,
    completeness: metadata.some((value) => value.completeness === 'partial') ? 'partial' : metadata.length > 0 && metadata.every((value) => value.completeness === 'complete') ? 'complete' : 'unknown',
    freshness: metadata.some((value) => value.freshness === 'stale') ? 'stale' : metadata.length > 0 && metadata.every((value) => value.freshness === 'fresh') ? 'fresh' : 'unknown',
    availability: sources.length > 0 ? 'available' : 'empty'
  };
}
