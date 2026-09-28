/**
 * Generates the WebMCP tool manifest from dashboard page definitions.
 *
 * Dashboard pages define the semantic capabilities of the dashboard. Human
 * rendering, WebMCP, the `cao` CLI, and the read-only MCP server are generated
 * adapters over the same definitions and the same query execution path, so this
 * module derives tool descriptors from the shared agent catalog and never
 * maintains a second catalog. It is pure: it reads a dashboard document and
 * returns descriptors without touching the DOM, the network, or the database.
 */

import { agentFacingPages, isAgentFacingPage, navigationPageIds, pageParameters } from '../agent/catalog.js';
import { createDebug } from '../debug.js';

export { isAgentFacingPage, navigationPageIds };

const debugManifest = createDebug('webmcp-manifest');

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
 *   annotations: { readOnlyHint: true, untrustedContentHint: true }
 * }} WebMCPToolDescriptor
 */

const TOOL_NAME_PREFIX = 'cao_';

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
  /** @type {string[]} */
  const formFields = [];
  const routeParameter = text(page.route?.['hash-query-parameter']);
  for (const parameter of pageParameters(page)) {
    properties[parameter.name] = parameter.schema;
    if (parameter.required) required.push(parameter.name);
    else formFields.push(parameter.name);
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
    // `readOnlyHint` states that the tool only reads. `untrustedContentHint`
    // states that the rows it returns are ingested from GitHub and agentic
    // workflow runs, so an agent must treat the result as data and never as
    // instructions.
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  };
}

/**
 * Generates the WebMCP manifest for one dashboard document.
 * @param {{ dashboard?: { title?: string, pages?: DashboardPageDefinition[], navigation?: unknown } }} document
 * @returns {WebMCPToolDescriptor[]}
 */
export function webMCPManifestForDashboard(document) {
  const dashboardTitle = text(document?.dashboard?.title);
  /** @type {Map<string, WebMCPToolDescriptor>} */
  const tools = new Map();
  let skippedCount = 0;
  for (const page of agentFacingPages(document)) {
    const tool = webMCPToolForPage(page, { dashboardTitle });
    if (tool.name === TOOL_NAME_PREFIX || tools.has(tool.name)) {
      skippedCount += 1;
      debugManifest({
        event: 'tool-skipped',
        pageId: tool.pageId,
        reason: tool.name === TOOL_NAME_PREFIX ? 'empty-name' : 'duplicate-name'
      });
      continue;
    }
    tools.set(tool.name, tool);
  }
  debugManifest({ event: 'manifest-generated', toolCount: tools.size, skippedCount });
  return [...tools.values()];
}
