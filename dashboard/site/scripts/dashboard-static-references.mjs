/**
 * Finds source-level dashboard references that the Dashboard Language validator
 * cannot see because they live outside dashboard.json.
 *
 * @param {unknown} document
 * @param {{ linkedPageIds: Iterable<string>, registeredElementIds: Iterable<string> }} references
 */
export function findMissingStaticDashboardReferences(document, references) {
  if (!isRecord(document) || !isRecord(document.dashboard)) {
    return ['dashboard document must contain a dashboard object'];
  }
  const dashboard = document.dashboard;
  const pageIds = idsOf(dashboard.pages);
  const registeredElementIds = new Set(references.registeredElementIds);
  const missing = [];

  for (const pageId of new Set(references.linkedPageIds)) {
    if (!pageIds.has(pageId)) missing.push(`source link references missing page "${pageId}"`);
  }

  const elementIds = new Set();
  visit([dashboard.pages, dashboard.views], (value) => {
    if (value.mark === 'element' && typeof value.element === 'string') {
      elementIds.add(value.element);
    }
  });
  for (const elementId of elementIds) {
    if (!registeredElementIds.has(elementId)) {
      missing.push(`dashboard references unregistered element "${elementId}"`);
    }
  }

  return missing.toSorted();
}

/** @param {unknown} values */
function idsOf(values) {
  return new Set(Array.isArray(values)
    ? values.flatMap((value) => isRecord(value) && typeof value.id === 'string' ? [value.id] : [])
    : []);
}

/** @param {unknown} value @param {(value: Record<string, unknown>) => void} callback */
function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!isRecord(value)) return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
