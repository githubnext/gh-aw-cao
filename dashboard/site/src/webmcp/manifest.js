/**
 * Generates the WebMCP tool manifest from dashboard page definitions.
 *
 * Dashboard pages define the semantic capabilities of the dashboard. Human
 * rendering and WebMCP are generated adapters over the same definitions and the
 * same query execution path, so this module derives tool descriptors and never
 * maintains a second catalog. It is pure: it reads a dashboard document and
 * returns descriptors without touching the DOM, the network, or the database.
 */

/**
 * @typedef {{
 *   id?: string,
 *   title?: string,
 *   description?: string,
 *   intent?: string,
 *   ['navigation-label']?: string,
 *   route?: { ['hash-query-parameter']?: string, ['navigation-page']?: string },
 *   form?: { fields?: Array<Record<string, unknown>> }
 * } & Record<string, unknown>} DashboardPageDefinition
 */

/**
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   pageId: string,
 *   routeParameter: string | null,
 *   formFields: string[],
 *   inputSchema: { type: 'object', properties: Record<string, Record<string, unknown>>, required?: string[], additionalProperties: false },
 *   annotations: { readOnlyHint: true }
 * }} WebMCPToolDescriptor
 */

const TOOL_NAME_PREFIX = 'cao_';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns the deterministic WebMCP tool name for one page identifier.
 * @param {string} pageId
 */
export function webMCPToolName(pageId) {
  return `${TOOL_NAME_PREFIX}${text(pageId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/**
 * Returns the page identifiers reachable from the declared navigation.
 * @param {unknown} navigation
 * @returns {Set<string>}
 */
export function navigationPageIds(navigation) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (!Array.isArray(navigation)) return ids;
  for (const group of navigation) {
    if (!isPlainObject(group) || !Array.isArray(group.pages)) continue;
    for (const pageId of group.pages) {
      if (text(pageId)) ids.add(text(pageId));
    }
  }
  return ids;
}

/**
 * Reports whether a page is exposed to browser agents.
 *
 * A page is agent facing when an operator can reach it deliberately: either it
 * appears in the declared navigation, or it is a detail page addressed by one
 * route parameter. Pages that only exist as navigation targets of another page
 * are excluded so the manifest stays a bounded capability catalog. Experimental
 * pages remain included because `experimental` is informational page metadata
 * that changes presentation only.
 *
 * @param {DashboardPageDefinition} page
 * @param {Set<string>} [navigationPages]
 */
export function isAgentFacingPage(page, navigationPages = new Set()) {
  if (!isPlainObject(page)) return false;
  const pageId = text(page.id);
  if (!pageId || !text(page.title)) return false;
  if (navigationPages.has(pageId)) return true;
  return Boolean(text(page.route?.['hash-query-parameter']));
}

/**
 * Reports whether a value is an exact multiple of a positive step.
 * @param {number} value
 * @param {number} step
 */
function isMultipleOf(value, step) {
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/**
 * Maps one declared form field to a JSON Schema property.
 * @param {Record<string, unknown>} field
 * @returns {Record<string, unknown> | null}
 */
function formFieldSchema(field) {
  const description = text(field.label) || text(field.id);
  switch (text(field.control)) {
    case 'checkbox':
      return {
        type: 'boolean',
        description,
        ...(typeof field.default === 'boolean' ? { default: field.default } : {})
      };
    case 'slider': {
      /** @type {Record<string, unknown>} */
      const schema = { type: 'number', description };
      if (typeof field.min === 'number' && Number.isFinite(field.min)) schema.minimum = field.min;
      if (typeof field.max === 'number' && Number.isFinite(field.max)) schema.maximum = field.max;
      // Slider positions are offsets from `min`, so `multipleOf` (an offset from
      // zero) is only equivalent when `min` is itself a multiple of the step.
      if (typeof field.step === 'number' && Number.isFinite(field.step) && field.step > 0
        && (typeof schema.minimum !== 'number' || isMultipleOf(schema.minimum, field.step))) {
        schema.multipleOf = field.step;
      }
      if (typeof field.default === 'number' && Number.isFinite(field.default)) schema.default = field.default;
      return schema;
    }
    case 'radio':
    case 'select': {
      const options = Array.isArray(field.options) ? field.options : [];
      const values = options
        .map((option) => (isPlainObject(option) ? option.value : option))
        .filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
      if (values.length === 0) return null;
      if (values.some((value) => typeof value !== typeof values[0])) return null;
      const type = typeof values[0] === 'number' ? 'number' : typeof values[0] === 'boolean' ? 'boolean' : 'string';
      return {
        type,
        description,
        enum: values,
        ...(values.includes(/** @type {string | number | boolean} */ (field.default)) ? { default: field.default } : {})
      };
    }
    case 'text':
      return {
        type: 'string',
        description,
        ...(typeof field.default === 'string' ? { default: field.default } : {})
      };
    default:
      return null;
  }
}

/**
 * Generates the read-only WebMCP tool descriptor for one dashboard page.
 * @param {DashboardPageDefinition} page
 * @param {{ dashboardTitle?: string }} [context]
 * @returns {WebMCPToolDescriptor}
 */
export function webMCPToolForPage(page, context = {}) {
  const pageId = text(page.id);
  const title = text(page.title) || text(page['navigation-label']) || pageId;
  const dashboardTitle = text(context.dashboardTitle) || 'Central Agentic Ops Dashboard';
  const pageDescription = text(page.description)
    || text(page.intent)
    || `Read the ${title} page of the ${dashboardTitle}.`;
  const description = page.experimental === true ? `Experimental. ${pageDescription}` : pageDescription;
  /** @type {Record<string, Record<string, unknown>>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  const routeParameter = text(page.route?.['hash-query-parameter']);
  if (routeParameter) {
    properties[routeParameter] = {
      type: 'string',
      description: `The ${routeParameter} this page reports on.`
    };
    required.push(routeParameter);
  }
  /** @type {string[]} */
  const formFields = [];
  const fields = Array.isArray(page.form?.fields) ? page.form.fields : [];
  for (const field of fields) {
    if (!isPlainObject(field)) continue;
    const fieldId = text(field.id);
    if (!fieldId || fieldId === routeParameter || properties[fieldId]) continue;
    const schema = formFieldSchema(field);
    if (!schema) continue;
    properties[fieldId] = schema;
    formFields.push(fieldId);
  }
  return {
    name: webMCPToolName(pageId),
    title,
    description,
    pageId,
    routeParameter: routeParameter || null,
    formFields,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  };
}

/**
 * Generates the WebMCP manifest for one dashboard document.
 * @param {{ dashboard?: { title?: string, pages?: DashboardPageDefinition[], navigation?: unknown } }} document
 * @returns {WebMCPToolDescriptor[]}
 */
export function webMCPManifestForDashboard(document) {
  const dashboard = isPlainObject(document?.dashboard) ? document.dashboard : null;
  const pages = Array.isArray(dashboard?.pages) ? dashboard.pages : [];
  const navigationPages = navigationPageIds(dashboard?.navigation);
  /** @type {Map<string, WebMCPToolDescriptor>} */
  const tools = new Map();
  for (const page of pages) {
    if (!isAgentFacingPage(page, navigationPages)) continue;
    const tool = webMCPToolForPage(page, { dashboardTitle: text(dashboard?.title) });
    if (tool.name === TOOL_NAME_PREFIX || tools.has(tool.name)) continue;
    tools.set(tool.name, tool);
  }
  return [...tools.values()];
}
