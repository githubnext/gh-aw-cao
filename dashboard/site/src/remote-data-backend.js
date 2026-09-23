import { compileDashboardViewPayloadQueries } from "./data/queries/view-payload-compiler.js";

const BACKEND_META_NAME = "dashboard-data-backend";
const REMOTE_BACKEND = "redis-http";
const ACCESS_TOKEN_STORAGE_KEY = "cao-dashboard-access-token";
/** @type {number | null} */
let observedRevision = null;
/** @type {string | undefined} */
let observedEvaluatedAt;

/**
 * @typedef {{
 *   filters?: Record<string, string[]>,
 *   search?: { fields: string[], query: string },
 *   orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>,
 *   timeWindow?: { start?: string, end?: string },
 *   viewMode?: 'chart'|'table'|'card'
 * }} RemoteQueryContext
 */

/**
 * @typedef {{
 *   signal?: AbortSignal,
 *   pageId?: string,
 *   viewId?: string,
 *   routeParameters?: Record<string, string>,
 *   queryContext?: RemoteQueryContext
 * }} RemoteQueryOptions
 */

export function usesRemoteDataBackend(document = globalThis.document) {
  return document?.querySelector?.(`meta[name="${BACKEND_META_NAME}"]`)?.getAttribute("content") === REMOTE_BACKEND;
}

/**
 * Removes static-dashboard PWA state from the server-backed origin. A worker
 * controlling the current page remains until navigation, but unregistering it
 * prevents update-driven controller changes and reload loops.
 * @param {{ serviceWorkers?: ServiceWorkerContainer, cacheStorage?: CacheStorage }} [dependencies]
 */
export async function disableRemoteDashboardPwa(dependencies = {}) {
  const serviceWorkers = dependencies.serviceWorkers ?? globalThis.navigator?.serviceWorker;
  const cacheStorage = dependencies.cacheStorage ?? globalThis.caches;
  const registrations = await serviceWorkers?.getRegistrations?.().catch(() => []) ?? [];
  await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  const keys = await cacheStorage?.keys?.().catch(() => []) ?? [];
  await Promise.allSettled(keys
    .filter((key) => key.startsWith("central-agentic-ops-dashboard-"))
    .map((key) => cacheStorage.delete(key)));
}

/** @param {string} path */
function apiUrl(path) {
  return new URL(path, globalThis.location?.origin ?? "https://localhost").href;
}

function accessToken() {
  try {
    return globalThis.localStorage?.getItem(ACCESS_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @param {AbortSignal} [signal]
 */
async function apiRequest(path, init = {}, signal) {
  const response = await fetch(apiUrl(path), {
    ...init,
    signal,
    cache: "no-store",
    credentials: "omit",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken() ? { Authorization: `Bearer ${accessToken()}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Dashboard data server request failed: ${response.status}`);
  }
  return response.json();
}

/**
 * @param {string[]} sourceNames
 * @param {{ pages: unknown[], queries?: unknown[], views?: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @param {RemoteQueryOptions} [options]
 */
function remoteQueryPayload(sourceNames, context, pagination, options = {}) {
  const page = options.pageId
    ? context.pages.find((candidate) => (
        candidate && typeof candidate === "object" && "id" in candidate && candidate.id === options.pageId
      ))
    : null;
  const viewPayload = page && options.pageId
    ? compileDashboardViewPayloadQueries(page, options.pageId, {
        routeParameters: options.routeParameters,
        queryContext: options.queryContext,
        evaluatedAt: options.queryContext?.timeWindow?.end ?? observedEvaluatedAt,
        queries: context.queries ?? [],
        views: context.views ?? [],
        viewId: options.viewId,
        sourceNames,
      })
    : { aliases: [], queries: [], replacedSources: [] };
  return {
    sourceNames,
    queries: context.queries ?? [],
    compiledQueries: viewPayload.queries,
    aliases: viewPayload.aliases,
    replacedSources: viewPayload.replacedSources,
    pagination: pagination ?? {},
    pageId: options.pageId,
    viewId: options.viewId,
    routeParameters: options.routeParameters,
    queryContext: options.queryContext,
  };
}

/**
 * @param {string[]} sourceNames
 * @param {{ pages: unknown[], queries?: unknown[], views?: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @param {RemoteQueryOptions} [options]
 */
export async function queryRemoteDashboard(sourceNames, context, pagination, options = {}) {
  if (!observedEvaluatedAt) {
    const status = await apiRequest("/api/v1/refresh", { method: "POST" }, options.signal);
    if (Number.isSafeInteger(status?.revision)) observedRevision = status.revision;
    if (typeof status?.evaluatedAt === "string") observedEvaluatedAt = status.evaluatedAt;
  }
  const payload = await apiRequest("/api/v1/query", {
    method: "POST",
    body: JSON.stringify(remoteQueryPayload(sourceNames, context, pagination, options)),
  }, options.signal);
  if (!payload?.sources || typeof payload.sources !== "object" || Array.isArray(payload.sources)) {
    throw new Error("Dashboard data server returned an invalid query response.");
  }
  if (Number.isSafeInteger(payload.revision)) observedRevision = payload.revision;
  if (typeof payload.evaluatedAt === "string") observedEvaluatedAt = payload.evaluatedAt;
  return {
    revision: Number.isSafeInteger(payload.revision) ? payload.revision : null,
    sources: payload.sources,
  };
}

/**
 * @param {string[]} sourceNames
 * @param {{ pages: unknown[], queries?: unknown[], views?: unknown[] }} context
 * @param {Record<string, { limit: number, continuationToken?: string }>} [pagination]
 * @param {RemoteQueryOptions} [options]
 */
export async function refreshRemoteDashboard(sourceNames, context, pagination, options = {}) {
  const status = await apiRequest("/api/v1/refresh", { method: "POST" }, options.signal);
  const revision = Number.isSafeInteger(status?.revision) ? status.revision : null;
  const changed = revision !== null && observedRevision !== null && revision !== observedRevision;
  if (typeof status?.evaluatedAt === "string") observedEvaluatedAt = status.evaluatedAt;
  const result = await queryRemoteDashboard(sourceNames, context, pagination, options);
  return { sources: result.sources, changed };
}

/** @param {AbortSignal} [signal] */
export function queryRemoteDiagnostics(signal) {
  return apiRequest("/api/v1/diagnostics", {}, signal);
}

/**
 * @param {(revision: number) => void} onRevision
 * @param {(error: Error) => void} [onError]
 */
export function subscribeRemoteRevision(onRevision, onError) {
  if (typeof fetch !== "function" || typeof TextDecoder === "undefined") return () => {};
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  let stopped = false;

  /** @param {string} data */
  const emit = (data) => {
    try {
      const payload = JSON.parse(data);
      if (Number.isSafeInteger(payload?.revision)) {
        if (payload.revision !== observedRevision) observedEvaluatedAt = undefined;
        onRevision(payload.revision);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const connect = async () => {
    try {
      const response = await fetch(apiUrl("/api/v1/events"), {
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "text/event-stream",
          ...(accessToken() ? { Authorization: `Bearer ${accessToken()}` } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Dashboard data event stream failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) emit(data);
        }
      }
      throw new Error("Dashboard data server event stream disconnected.");
    } catch (error) {
      if (stopped || controller.signal.aborted) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
      retry = setTimeout(() => void connect(), 1000);
    }
  };
  void connect();
  return () => {
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    controller.abort();
  };
}
