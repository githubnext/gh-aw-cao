/**
 * Deterministic evidence-confidence diagnostics for the dashboard.
 */

/**
 * @typedef {import('./presenter.js').LogicalSourceInput} LogicalSourceInput
 * @typedef {import('./presenter.js').SourceMetadata} SourceMetadata
 */

export const DOMAIN_DEPENDENCIES = Object.freeze({
  inventory: { required: ['repositories', 'workflows'], optional: ['organizations'] },
  runtime: { required: ['workflows', 'runs'], optional: ['run-performance', 'job-performance'] },
  cost: { required: ['runs', 'usage'], optional: [] },
  models: { required: ['workflows', 'usage'], optional: ['mcp-calls', 'mcp-servers'] },
  detection: { required: ['runs', 'detection-observations'], optional: ['security-observations'] },
  firewall: { required: ['runs', 'firewall-observations'], optional: ['firewall-policy-rules'] },
  'safe-outputs': { required: ['runs', 'safe-output-performance'], optional: ['findings'] },
  outcomes: { required: ['safe-output-performance', 'outcomes'], optional: ['findings', 'operational-values'] },
  configuration: { required: ['configuration-policy'], optional: ['configuration-summary', 'configuration-actions'] }
});

const COVERAGE_CONTRACTS = Object.freeze([
  { area: 'Repositories', source: 'repositories', denominator: 'metadata' },
  { area: 'Workflows', source: 'workflows', denominator: 'metadata' },
  { area: 'Run queries', source: 'runs', denominator: 'metadata' },
  { area: 'Runs', source: 'runs', denominator: 'metadata', expectedKey: 'run-records-expected', observedKey: 'run-records-observed' },
  { area: 'Usage telemetry', source: 'usage', parent: 'runs' },
  { area: 'Detection evidence', source: 'detection-observations', parent: 'runs' },
  { area: 'Firewall evidence', source: 'firewall-observations', parent: 'runs' },
  { area: 'Safe Outputs evidence', source: 'safe-output-performance', parent: 'runs' },
  { area: 'Outcome reconciliation', source: 'outcomes', parent: 'safe-output-performance' }
]);

const RECONCILIATION_CONTRACTS = Object.freeze([
  { relationship: 'Inventory → workflows', parent: 'repositories', child: 'workflows', parentKey: repositoryKey, childKey: repositoryKey, domain: 'inventory' },
  { relationship: 'Workflows → run queries', parent: 'workflows', child: 'runs', parentKey: workflowKey, childKey: workflowKey, domain: 'runtime' },
  { relationship: 'Runs → usage', parent: 'runs', child: 'usage', parentKey: runKey, childKey: runKey, domain: 'cost' },
  { relationship: 'Runs → detection', parent: 'runs', child: 'detection-observations', parentKey: runKey, childKey: runKey, domain: 'detection' },
  { relationship: 'Runs → firewall', parent: 'runs', child: 'firewall-observations', parentKey: runKey, childKey: runKey, domain: 'firewall' },
  { relationship: 'Runs → Safe Outputs', parent: 'runs', child: 'safe-output-performance', parentKey: runKey, childKey: runKey, domain: 'safe-outputs' },
  { relationship: 'Safe Outputs → outcomes', parent: 'safe-output-performance', child: 'outcomes', parentKey: runKey, childKey: runKey, domain: 'outcomes' }
]);

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {{ githubUrlBase?: string, dashboardRepository?: string | null }} [context]
 * @returns {Record<string, LogicalSourceInput>}
 */
export function deriveDataHealthSources(sources, context = {}) {
  const sourceRows = Object.entries(sources).map(([name, source]) => sourceDiagnostic(name, source));
  const fieldRows = Object.entries(sources).flatMap(([name, source]) => fieldDiagnostics(name, source));
  const fileRows = Object.entries(sources).map(([name, source]) => loadedFileDiagnostic(name, source));
  const schemaRows = Object.entries(sources).map(([name, source]) => schemaDiagnostic(name, source));
  const compatibilityRows = compatibilityDiagnostics(sources.workflows);
  const reconciliationRows = RECONCILIATION_CONTRACTS.map((contract) => reconcile(contract, sources));
  const coverageRows = COVERAGE_CONTRACTS.map((contract) => coverageDiagnostic(contract, sources, reconciliationRows));
  const collectionRows = collectionDiagnostics(sources);
  const domainRows = Object.entries(DOMAIN_DEPENDENCIES).map(([domain, dependencies]) => (
    domainDiagnostic(domain, dependencies, sourceRows, compatibilityRows, reconciliationRows)
  ));
  const confidence = overallConfidence(domainRows);
  const metadata = combineSourceMetadata(Object.values(sources));
  const affectedDomains = domainRows.filter((row) => row.confidence !== 'trusted').map((row) => row.domain);
  const repositoryCoverage = coverageRows.find((row) => row.area === 'Repositories');
  const collectorState = ['failed', 'partial', 'unknown', 'complete']
    .find((state) => collectionRows.some((row) => row.state === state)) ?? 'unknown';
  const compatibilityGaps = compatibilityRows.filter((row) => row.compatibility !== 'compatible').length;
  const githubUrlBase = typeof context.githubUrlBase === 'string' && context.githubUrlBase.length > 0
    ? context.githubUrlBase.replace(/\/+$/, '')
    : null;
  const dashboardRepository = typeof context.dashboardRepository === 'string' && context.dashboardRepository.length > 0
    ? context.dashboardRepository
    : null;
  const activityLink = githubUrlBase && dashboardRepository
    ? { href: `${githubUrlBase}/${dashboardRepository}/actions/workflows/activity.yml`, label: 'CAO Activity' }
    : null;

  return {
    'data-health-summary': healthSource('data-health-summary', [{
      confidence: confidence.state,
      reason: confidence.reason,
      'affected-domains': affectedDomains.length > 0 ? affectedDomains.join(', ') : 'None',
      'next-action': confidence.action,
      availability: aggregateAxis(sourceRows, 'availability'),
      completeness: aggregateAxis(sourceRows, 'completeness'),
      freshness: aggregateAxis(sourceRows, 'freshness'),
      'scope-coverage': repositoryCoverage?.['coverage-percent'] ?? 'Unknown',
      'collector-state': collectorState,
      'compatibility-gaps': compatibilityRows.length === 0 ? 'Unknown' : compatibilityGaps,
      sources: sourceRows.length,
      'available-sources': sourceRows.filter((row) => row.availability === 'available').length,
      rows: sourceRows.reduce((total, row) => total + row.rows, 0),
      fields: fieldRows.length,
      'populated-cells': sourceRows.reduce((total, row) => total + row['populated-cells'], 0),
      'empty-cells': sourceRows.reduce((total, row) => total + row['empty-cells'], 0),
      'external-link': activityLink
    }], metadata),
    'data-health-domains': healthSource('data-health-domains', domainRows, metadata),
    'data-health-collections': healthSource('data-health-collections', collectionRows, metadata),
    'data-health-compatibility': healthSource('data-health-compatibility', compatibilityRows, metadata),
    'data-health-reconciliation': healthSource('data-health-reconciliation', reconciliationRows, metadata),
    'data-health-coverage': healthSource('data-health-coverage', coverageRows, metadata),
    'data-health-sources': healthSource('data-health-sources', sourceRows, metadata),
    'data-health-fields': healthSource('data-health-fields', fieldRows, metadata),
    'data-health-files': healthSource('data-health-files', fileRows, metadata),
    'data-health-schema': healthSource('data-health-schema', schemaRows, metadata)
  };
}

/**
 * Derives the diagnostics required before the Data Health page is opened.
 * Detailed source inspection is deferred to the data worker.
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {Record<string, LogicalSourceInput>}
 */
export function deriveDataHealthCalloutSources(sources) {
  const reconciliationRows = RECONCILIATION_CONTRACTS.map((contract) => reconcile(contract, sources));
  const coverageRows = COVERAGE_CONTRACTS.map((contract) => coverageDiagnostic(contract, sources, reconciliationRows));
  const metadata = combineSourceMetadata(Object.values(sources));
  return {
    'data-health-collections': healthSource(
      'data-health-collections',
      collectionDiagnostics(sources),
      metadata
    ),
    'data-health-reconciliation': healthSource('data-health-reconciliation', reconciliationRows, metadata),
    'data-health-coverage': healthSource('data-health-coverage', coverageRows, metadata)
  };
}


/** @param {string} name @param {Array<Record<string, unknown>>} rows @param {SourceMetadata} metadata */
function healthSource(name, rows, metadata) {
  return { source: name, rows, metadata };
}

/** @param {string} name @param {LogicalSourceInput} source */
function sourceDiagnostic(name, source) {
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const fields = new Set(rows.flatMap((row) => Object.keys(row ?? {})));
  const populatedFields = [...fields].filter((field) => rows.some((row) => hasValue(row?.[field])));
  const populatedCells = rows.reduce(
    (total, row) => total + [...fields].filter((field) => hasValue(row?.[field])).length,
    0
  );
  const cells = rows.length * fields.size;
  const metadata = source?.metadata ?? {};
  const availability = metadata.availability ?? 'unknown';
  const completeness = metadata.completeness ?? 'unknown';
  const freshness = metadata.freshness ?? 'unknown';
  const confidence = evidenceConfidence({ availability, completeness, freshness });
  return {
    source: name,
    'source-id': metadata['source-id'] ?? name,
    'source-kind': metadata['source-kind'] ?? 'unknown',
    'as-of': metadata['as-of'] ?? '',
    'retrieved-at': metadata['retrieved-at'] ?? '',
    rows: rows.length,
    fields: fields.size,
    'populated-fields': populatedFields.length,
    'empty-fields': fields.size - populatedFields.length,
    'populated-cells': populatedCells,
    'empty-cells': cells - populatedCells,
    'field-coverage': fields.size === 0 ? 'Unknown' : formatPercent(populatedFields.length / fields.size),
    'cell-coverage': cells === 0 ? 'Unknown' : formatPercent(populatedCells / cells),
    status: confidence,
    availability,
    completeness,
    freshness,
    reason: confidenceReason({ availability, completeness, freshness })
  };
}

/** @param {string} name @param {LogicalSourceInput} source */
function loadedFileDiagnostic(name, source) {
  const serialized = safeStringify(source);
  return {
    file: `${name}.json`,
    source: name,
    size: new TextEncoder().encode(serialized).length,
    rows: Array.isArray(source?.rows) ? source.rows.length : 0,
    status: source?.metadata?.availability ?? 'unknown'
  };
}

/**
 * Serializes a value to JSON, replacing reference cycles with a marker instead of throwing, so a
 * single malformed source cannot break loaded-file size diagnostics for every other source.
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  /** @type {object[]} */
  const ancestors = [];
  return JSON.stringify(value, function replacer(_key, candidate) {
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (candidate !== null && typeof candidate === 'object') {
      if (ancestors.includes(candidate)) return '[Circular]';
      ancestors.push(candidate);
    }
    return candidate;
  });
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

/** @param {string} name @param {LogicalSourceInput} source */
function fieldDiagnostics(name, source) {
  const rows = Array.isArray(source?.rows) ? source.rows : [];
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))].sort();
  return fields.map((field) => {
    const values = rows.map((row) => row?.[field]);
    const populated = values.filter(hasValue);
    const types = [...new Set(populated.map(valueType))].sort();
    return {
      source: name,
      field,
      types: types.length > 0 ? types.join(', ') : 'Unknown',
      rows: rows.length,
      populated: populated.length,
      empty: rows.length - populated.length,
      coverage: rows.length === 0 ? 'Unknown' : formatPercent(populated.length / rows.length),
      shape: types.length > 1 ? 'mixed' : types[0] ?? 'unknown'
    };
  });
}

/** @param {unknown} value */
function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** @param {{ availability?: string, completeness?: string, freshness?: string, compatibility?: string, collectionState?: string }} state */
export function evidenceConfidence({ availability, completeness, freshness, compatibility = 'compatible', collectionState = 'complete' }) {
  if (availability === 'unavailable' || collectionState === 'failed') return 'insufficient';
  if ([availability, completeness, freshness, compatibility, collectionState].some((value) => value === 'unknown' || value === undefined)) return 'unknown';
  if (completeness === 'partial' || freshness === 'stale' || compatibility === 'limited' || collectionState === 'partial') return 'degraded';
  if (compatibility === 'unsupported') return 'insufficient';
  return availability === 'available' && completeness === 'complete' && freshness === 'fresh' ? 'trusted' : 'unknown';
}

/** @param {{ availability?: string, completeness?: string, freshness?: string }} state */
function confidenceReason({ availability, completeness, freshness }) {
  if (availability === 'unavailable') return 'Collection is unavailable.';
  if (availability === 'unknown') return 'Availability is unknown.';
  if (completeness === 'partial') return 'Evidence is only partially collected.';
  if (completeness === 'unknown') return 'Completeness is unknown.';
  if (freshness === 'stale') return 'Evidence is stale.';
  if (freshness === 'unknown') return 'Evidence freshness is unknown.';
  return 'Evidence is available, complete, and fresh.';
}

/**
 * @param {string} domain
 * @param {{ required: readonly string[], optional: readonly string[] }} dependencies
 * @param {Array<Record<string, any>>} sourceRows
 * @param {Array<Record<string, any>>} compatibilityRows
 * @param {Array<Record<string, any>>} reconciliationRows
 */
function domainDiagnostic(domain, dependencies, sourceRows, compatibilityRows, reconciliationRows) {
  const required = dependencies.required.map((name) => sourceRows.find((row) => row.source === name));
  const missing = dependencies.required.filter((_, index) => !required[index]);
  const affectedCompatibility = compatibilityRows.filter((row) => dependencies.required.includes(row.source) && row.compatibility !== 'compatible');
  const affectedReconciliation = reconciliationRows.filter((row) => row.domain === domain && row.state !== 'complete' && row.state !== 'not-applicable');
  let confidence = 'trusted';
  let reason = 'Required evidence is available, complete, fresh, compatible, and consistent.';
  if (missing.length > 0 || required.some((row) => row?.status === 'unknown')) {
    confidence = 'unknown';
    reason = `Required evidence state is unknown: ${missing.length > 0 ? missing.join(', ') : required.filter((row) => row?.status === 'unknown').map((row) => row?.source).join(', ')}.`;
  } else if (required.some((row) => row?.status === 'insufficient') || affectedCompatibility.some((row) => row.compatibility === 'unsupported')) {
    confidence = 'insufficient';
    reason = 'A critical evidence source is unavailable or unsupported.';
  } else if (required.some((row) => row?.status === 'degraded') || affectedCompatibility.length > 0 || affectedReconciliation.length > 0) {
    confidence = 'degraded';
    reason = 'Known bounded gaps affect this domain.';
  }
  return {
    domain,
    confidence,
    reason,
    'required-sources': dependencies.required.join(', '),
    'optional-sources': dependencies.optional.join(', ') || 'None',
    'next-action': confidence === 'trusted' ? 'No action required.' : `Investigate ${domain} evidence diagnostics.`
  };
}

/** @param {Array<Record<string, any>>} domains */
function overallConfidence(domains) {
  /** @param {string} state */
  const first = (state) => domains.find((domain) => domain.confidence === state);
  const insufficient = first('insufficient');
  if (insufficient) return { state: 'insufficient', reason: insufficient.reason, action: insufficient['next-action'] };
  const unknown = first('unknown');
  if (unknown) return { state: 'unknown', reason: unknown.reason, action: unknown['next-action'] };
  const degraded = first('degraded');
  if (degraded) return { state: 'degraded', reason: degraded.reason, action: degraded['next-action'] };
  return { state: 'trusted', reason: 'All critical evidence domains are trusted.', action: 'No action required.' };
}

/**
 * @param {{ area: string, source: string, denominator?: string, parent?: string, expectedKey?: string, observedKey?: string }} contract
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Array<Record<string, any>>} reconciliationRows
 */
function coverageDiagnostic(contract, sources, reconciliationRows) {
  const source = sources[contract.source];
  const metadata = source?.metadata ?? {};
  let expected = finiteCount(metadata[contract.expectedKey ?? 'coverage-expected']);
  let observed = finiteCount(metadata[contract.observedKey ?? 'coverage-observed']);
  if (contract.parent) {
    const suffix = `→ ${contract.area.replace(' evidence', '').replace(' telemetry', '')}`.toLowerCase();
    const relationship = reconciliationRows.find((row) => String(row.relationship).toLowerCase().endsWith(suffix));
    expected = relationship ? finiteCount(relationship.expected) : uniqueKeys(sources[contract.parent]?.rows, runKey).size;
    observed = relationship ? finiteCount(relationship.observed) : uniqueKeys(source?.rows, runKey).size;
  }
  const coverage = expected === null ? null : expected === 0 ? 100 : Math.round((Math.min(observed ?? 0, expected) / expected) * 100);
  const requestedStart = String(metadata['requested-coverage-start'] ?? '');
  const requestedEnd = String(metadata['requested-coverage-end'] ?? '');
  const observedStart = String(metadata['coverage-start'] ?? '');
  const observedEnd = String(metadata['coverage-end'] ?? '');
  const horizonComplete = requestedStart && requestedEnd
    ? Boolean(observedStart && observedEnd && Date.parse(observedStart) <= Date.parse(requestedStart) && Date.parse(observedEnd) >= Date.parse(requestedEnd))
    : null;
  return {
    area: contract.area,
    expected: expected ?? 'Unknown',
    observed: observed ?? 'Unknown',
    missing: expected === null || observed === null ? 'Unknown' : Math.max(0, expected - observed),
    'coverage-percent': coverage === null ? 'Unknown' : `${coverage}%`,
    state: expected === null || horizonComplete === false ? 'unknown' : coverage === 100 ? 'complete' : 'partial',
    reason: expected === null
      ? 'No authoritative denominator is available.'
      : horizonComplete === false
        ? 'The observed evidence horizon does not cover the requested window.'
        : coverage === 100 ? 'Authoritative scope was fully observed.' : 'Some expected evidence was not observed.',
    'requested-horizon': requestedStart && requestedEnd ? `${requestedStart} — ${requestedEnd}` : 'Unknown',
    'observed-horizon': observedStart && observedEnd ? `${observedStart} — ${observedEnd}` : 'Unknown'
  };
}

/** @param {Record<string, LogicalSourceInput>} sources */
function collectionDiagnostics(sources) {
  const sourceDiagnostics = Object.entries(sources).map(([name, source]) => {
    const metadata = source?.metadata ?? {};
    const availability = metadata.availability ?? 'unknown';
    const completeness = metadata.completeness ?? 'unknown';
    const fallback = metadata['fallback-used'] === true;
    const state = metadata['collection-state']
      ?? (availability === 'unavailable' ? 'failed' : completeness === 'partial' ? 'partial' : completeness === 'complete' ? 'complete' : 'unknown');
    return {
      operation: metadata['collection-operation'] ?? name,
      source: name,
      state,
      'failure-class': metadata['failure-class'] ?? '',
      progress: metadata['collection-progress'] ?? (state === 'complete' ? 'Complete' : 'Unknown'),
      'collector-completed-at': metadata['collector-completed-at'] ?? metadata['retrieved-at'] ?? '',
      'retrieved-at': metadata['retrieved-at'] ?? '',
      'source-as-of': metadata['as-of'] ?? '',
      'evidence-horizon': metadata['coverage-start'] && metadata['coverage-end'] ? `${metadata['coverage-start']} — ${metadata['coverage-end']}` : 'Unknown',
      fallback: fallback ? 'stale snapshot' : 'none',
      'snapshot-age': metadata['snapshot-age-seconds'] == null ? 'Unknown' : `${metadata['snapshot-age-seconds']} seconds`,
      provenance: metadata['source-id'] ?? name,
      'technical-detail': '',
      reason: metadata['collection-reason'] ?? confidenceReason({ availability, completeness, freshness: metadata.freshness ?? 'unknown' })
    };
  });
  const retainedDiagnostics = (sources['coverage-diagnostics']?.rows ?? []).map((row) => ({
    operation: row.title || row.kind || 'coverage-diagnostic',
    source: 'coverage-diagnostics',
    state: 'partial',
    'failure-class': String(row.kind ?? '').includes('rate-limit') ? 'rate-limit' : 'collection',
    progress: 'Partial',
    'collector-completed-at': sources['coverage-diagnostics']?.metadata?.['retrieved-at'] ?? '',
    'retrieved-at': sources['coverage-diagnostics']?.metadata?.['retrieved-at'] ?? '',
    'source-as-of': sources['coverage-diagnostics']?.metadata?.['as-of'] ?? '',
    'evidence-horizon': 'Unknown',
    fallback: row['snapshot-age-seconds'] === '' || row['snapshot-age-seconds'] == null ? 'none' : 'stale snapshot',
    'snapshot-age': row['snapshot-age-seconds'] === '' || row['snapshot-age-seconds'] == null ? 'Unknown' : `${row['snapshot-age-seconds']} seconds`,
    provenance: row.endpoint || sources['coverage-diagnostics']?.metadata?.['source-id'] || 'coverage-diagnostics',
    'technical-detail': row['technical-detail'] || '',
    reason: row.effect || row.title || 'Collection is degraded.'
  }));
  return [...sourceDiagnostics, ...retainedDiagnostics];
}

/** @param {LogicalSourceInput | undefined} workflows */
function compatibilityDiagnostics(workflows) {
  const currentVersion = workflows?.rows?.map((row) => parseVersion(row['gh-aw-current-version'])).find(Boolean) ?? null;
  return (workflows?.rows ?? []).map((row) => {
    const producer = parseVersion(row['gh-aw-version']);
    const missingBaseFields = ['organization', 'repository', 'workflow'].filter((field) => !hasValue(row[field]));
    const missingCurrentFields = producer && currentVersion
      && producer.major === currentVersion.major
      && compareVersion(producer, currentVersion) >= 0
      && !hasValue(row['gh-aw-metadata'])
      ? ['gh-aw-metadata']
      : [];
    const missingFields = [...missingBaseFields, ...missingCurrentFields];
    let compatibility = 'unknown';
    let reason = 'Producer version is unavailable.';
    if (producer && currentVersion && producer.major !== currentVersion.major) {
      compatibility = 'unsupported';
      reason = 'Producer major version is outside the supported contract.';
    } else if (producer && currentVersion && compareVersion(producer, currentVersion) < 0) {
      compatibility = 'limited';
      reason = 'Supported legacy producer; newer optional telemetry may be absent.';
    } else if (producer) {
      compatibility = 'compatible';
      reason = 'Producer contract is supported.';
    }
    if (missingFields.length > 0 && compatibility === 'compatible') {
      compatibility = 'limited';
      reason = 'A required field is unexpectedly missing from a compatible producer.';
    }
    return {
      source: 'workflows',
      workflow: workflowKey(row),
      'producer-version': row['gh-aw-version'] || 'Unknown',
      compatibility,
      'missing-fields': missingFields.join(', ') || 'None',
      'missing-field-class': missingFields.length > 0 ? 'unexpected' : compatibility === 'limited' ? 'expected' : 'none',
      'affected-domain': compatibility === 'compatible' ? 'None' : 'runtime, cost, models, security',
      reason,
      'next-action': compatibility === 'compatible' ? 'No action required.' : 'Investigate producer compatibility.'
    };
  });
}

/**
 * @param {{ relationship: string, parent: string, child: string, parentKey: (row: any) => string, childKey: (row: any) => string, domain: string }} contract
 * @param {Record<string, LogicalSourceInput>} sources
 */
function reconcile(contract, sources) {
  const parentSource = sources[contract.parent];
  const childSource = sources[contract.child];
  if (!parentSource || !childSource || parentSource.metadata?.availability === 'unavailable') {
    return reconciliationRow(contract, null, null, 'unknown', 'Authoritative parent evidence is unavailable.');
  }
  const expectedKeys = uniqueKeys(parentSource.rows, contract.parentKey);
  if (parentSource.metadata?.completeness === 'unknown') {
    return reconciliationRow(contract, null, null, 'unknown', 'Authoritative denominator is unknown.');
  }
  const observedKeys = uniqueKeys(childSource.rows, contract.childKey);
  const observed = [...expectedKeys].filter((key) => observedKeys.has(key)).length;
  const expected = expectedKeys.size;
  const state = childSource.metadata?.availability === 'unavailable'
    ? 'missing'
    : observed === expected ? 'complete' : 'partial';
  return reconciliationRow(
    contract,
    expected,
    observed,
    state,
    expected === 0 ? 'No eligible parent records exist.' : observed === expected ? 'Stable identifiers reconcile.' : 'Expected related records are missing.'
  );
}

/**
 * @param {{ relationship: string, domain: string }} contract
 * @param {number | null} expected
 * @param {number | null} observed
 * @param {string} state
 * @param {string} reason
 */
function reconciliationRow(contract, expected, observed, state, reason) {
  const missing = expected === null || observed === null ? 'Unknown' : Math.max(0, expected - observed);
  const coverage = expected === null || observed === null ? 'Unknown' : expected === 0 ? '100%' : `${Math.round((observed / expected) * 100)}%`;
  return {
    relationship: contract.relationship,
    expected: expected ?? 'Unknown',
    observed: observed ?? 'Unknown',
    missing,
    coverage,
    state,
    reason,
    'affected-domain': contract.domain,
    'next-action': state === 'complete' ? 'No action required.' : `Investigate ${contract.relationship} reconciliation.`
  };
}

/** @param {Record<string, any>} row */
function repositoryKey(row) {
  return row?.organization && row?.repository ? `${row.organization}/${row.repository}` : '';
}

/** @param {Record<string, any>} row */
function workflowKey(row) {
  const repository = repositoryKey(row);
  return repository && row?.workflow ? `${repository}:${row.workflow}` : '';
}

/** @param {Record<string, any>} row */
function runKey(row) {
  const repository = repositoryKey(row);
  return repository && row?.run != null && row.run !== '' ? `${repository}:${row.run}` : '';
}

/** @param {Array<Record<string, any>> | undefined} rows @param {(row: Record<string, any>) => string} key */
function uniqueKeys(rows, key) {
  return new Set((Array.isArray(rows) ? rows : []).map(key).filter(Boolean));
}

/** @param {unknown} value */
function parseVersion(value) {
  const match = String(value ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

/** @param {{ major: number, minor: number, patch: number }} left @param {{ major: number, minor: number, patch: number }} right */
function compareVersion(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** @param {unknown} value */
function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** @param {Array<Record<string, any>>} rows @param {string} axis */
function aggregateAxis(rows, axis) {
  const values = rows.map((row) => row[axis]);
  if (values.includes('unavailable')) return 'unavailable';
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('partial') || values.includes('stale')) return axis === 'freshness' ? 'stale' : 'partial';
  if (axis === 'availability') return values.every((value) => value === 'available') ? 'available' : 'unknown';
  return axis === 'freshness' ? 'fresh' : 'complete';
}

/** @param {unknown} value */
function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

/** @param {number} value */
function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
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
