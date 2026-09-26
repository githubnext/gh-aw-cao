/**
 * Registers the generated WebMCP tools with the browser agent.
 *
 * The driver is progressive enhancement: when the browser does not expose
 * `document.modelContext` nothing is registered and the dashboard behaves
 * exactly as before. Registered tools are read-only and execute through the
 * same page projection and data-worker boundary as the rendered dashboard.
 */

import { webMCPManifestForDashboard } from './manifest.js';

const DEFAULT_ROW_LIMIT = 20;

/**
 * Reports whether the current document exposes the WebMCP page API.
 * @param {Document | { modelContext?: { registerTool?: unknown } } | null | undefined} browserDocument
 */
export function supportsWebMCP(browserDocument) {
  const modelContext = /** @type {{ modelContext?: { registerTool?: unknown } } | null | undefined} */ (browserDocument)?.modelContext;
  return Boolean(modelContext && typeof modelContext.registerTool === 'function');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one tool argument against its generated JSON Schema property.
 * @param {string} name
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @returns {{ value: string | number | boolean } | { error: string }}
 */
function validateArgument(name, schema, value) {
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return { error: `"${name}" must be a boolean.` };
    return { value };
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `"${name}" must be a finite number.` };
    if (typeof schema.minimum === 'number' && value < schema.minimum) return { error: `"${name}" must be at least ${schema.minimum}.` };
    if (typeof schema.maximum === 'number' && value > schema.maximum) return { error: `"${name}" must be at most ${schema.maximum}.` };
  } else if (typeof value !== 'string' || value.length === 0) {
    return { error: `"${name}" must be a non-empty string.` };
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(/** @type {string | number | boolean} */ (value))) {
    return { error: `"${name}" must be one of ${schema.enum.join(', ')}.` };
  }
  return { value: /** @type {string | number | boolean} */ (value) };
}

/**
 * Resolves tool arguments into route parameters and form values.
 * @param {import('./manifest.js').WebMCPToolDescriptor} tool
 * @param {unknown} rawArguments
 * @returns {{ routeParameters: Record<string, string>, formValues: Record<string, string | number | boolean> } | { error: string }}
 */
export function resolveToolArguments(tool, rawArguments) {
  const args = isPlainObject(rawArguments) ? rawArguments : {};
  /** @type {Record<string, string>} */
  const routeParameters = {};
  /** @type {Record<string, string | number | boolean>} */
  const formValues = {};
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, name)) return { error: `"${name}" is not a declared parameter of ${tool.name}.` };
  }
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    const provided = Object.hasOwn(args, name) ? args[name] : schema.default;
    if (provided === undefined || provided === null) {
      if (tool.inputSchema.required?.includes(name)) return { error: `"${name}" is required by ${tool.name}.` };
      continue;
    }
    const result = validateArgument(name, schema, provided);
    if ('error' in result) return result;
    if (name === tool.routeParameter) routeParameters[name] = String(result.value);
    else formValues[name] = result.value;
  }
  return { routeParameters, formValues };
}

/**
 * Builds the dashboard route for one tool invocation.
 * @param {import('./manifest.js').WebMCPToolDescriptor} tool
 * @param {Record<string, string>} routeParameters
 */
export function dashboardRouteForTool(tool, routeParameters) {
  const query = new URLSearchParams(routeParameters).toString();
  return `#page-${encodeURIComponent(tool.pageId)}${query ? `?${query}` : ''}`;
}

/**
 * Summarizes one projected logical source for a browser agent.
 * @param {string} name
 * @param {unknown} source
 * @param {number} rowLimit
 */
function summarizeSource(name, source, rowLimit) {
  if (!isPlainObject(source)) return { source: name, availability: 'unavailable' };
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const metadata = isPlainObject(source.metadata) ? source.metadata : {};
  return {
    source: name,
    availability: metadata.availability ?? (rows.length > 0 ? 'available' : 'empty'),
    completeness: metadata.completeness,
    freshness: metadata.freshness,
    'as-of': metadata['as-of'],
    'row-count': rows.length,
    'returned-rows': Math.min(rows.length, rowLimit),
    rows: rows.slice(0, rowLimit)
  };
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Registers one read-only WebMCP tool per agent-facing dashboard page.
 *
 * @param {Document | { modelContext?: Record<string, unknown> }} browserDocument
 * @param {{
 *   dashboardDocument: () => { dashboard?: Record<string, unknown> },
 *   loadPageSources: (pageId: string, options: { signal: AbortSignal, onUpdate: (sources: Record<string, unknown>) => void, routeParameters?: Record<string, string>, queryContext?: { formValues?: Record<string, string | number | boolean> } }) => Promise<Record<string, unknown>>,
 *   navigate?: (route: string) => void,
 *   rowLimit?: number
 * }} options
 * @returns {{ refresh: () => string[], stop: () => void, toolNames: () => string[] } | null}
 */
export function startDashboardWebMCP(browserDocument, options) {
  if (!supportsWebMCP(browserDocument)) return null;
  const modelContext = /** @type {{ registerTool: (tool: Record<string, unknown>) => unknown }} */ (
    /** @type {{ modelContext: Record<string, unknown> }} */ (browserDocument).modelContext
  );
  const rowLimit = Number.isFinite(options.rowLimit) ? Math.max(1, Number(options.rowLimit)) : DEFAULT_ROW_LIMIT;
  /** @type {Map<string, { tool: import('./manifest.js').WebMCPToolDescriptor, unregister: (() => void) | null }>} */
  const registered = new Map();

  /**
   * @param {import('./manifest.js').WebMCPToolDescriptor} tool
   * @param {unknown} rawArguments
   */
  const executeTool = async (tool, rawArguments) => {
    const resolved = resolveToolArguments(tool, rawArguments);
    if ('error' in resolved) return toolResult(resolved.error, true);
    const route = dashboardRouteForTool(tool, resolved.routeParameters);
    try {
      options.navigate?.(route);
    } catch {
      // Navigation is a presentation courtesy; the projection below is authoritative.
    }
    const controller = new AbortController();
    try {
      const sources = await options.loadPageSources(tool.pageId, {
        signal: controller.signal,
        onUpdate: () => {},
        ...(tool.routeParameter ? { routeParameters: resolved.routeParameters } : {}),
        ...(Object.keys(resolved.formValues).length > 0 ? { queryContext: { formValues: resolved.formValues } } : {})
      });
      const summaries = Object.entries(isPlainObject(sources) ? sources : {})
        .map(([name, source]) => summarizeSource(name, source, rowLimit));
      return toolResult(JSON.stringify({
        page: tool.pageId,
        title: tool.title,
        route,
        parameters: { ...resolved.routeParameters, ...resolved.formValues },
        'row-limit': rowLimit,
        sources: summaries
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolResult(`Unable to read the ${tool.title} page: ${message}`, true);
    } finally {
      controller.abort();
    }
  };

  const refresh = () => {
    const manifest = webMCPManifestForDashboard(options.dashboardDocument());
    for (const tool of manifest) {
      const existing = registered.get(tool.name);
      if (existing) {
        existing.tool = tool;
        continue;
      }
      const entry = { tool, unregister: /** @type {(() => void) | null} */ (null) };
      registered.set(tool.name, entry);
      const handle = modelContext.registerTool({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: (/** @type {unknown} */ toolArguments) => executeTool(entry.tool, toolArguments)
      });
      if (typeof handle === 'function') entry.unregister = /** @type {() => void} */ (handle);
      else if (isPlainObject(handle) && typeof handle.unregister === 'function') {
        entry.unregister = () => /** @type {() => void} */ (handle.unregister)();
      }
    }
    return [...registered.keys()];
  };

  const stop = () => {
    for (const entry of registered.values()) {
      try {
        entry.unregister?.();
      } catch {
        // A browser that cannot unregister keeps the tool until the page unloads.
      }
    }
    registered.clear();
  };

  refresh();
  return { refresh, stop, toolNames: () => [...registered.keys()] };
}
