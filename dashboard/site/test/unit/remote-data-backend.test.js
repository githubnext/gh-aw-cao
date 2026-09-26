import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableRemoteDashboardPwa,
  queryRemoteDashboard,
  queryRemoteRepositoryMemory,
  refreshRemoteDashboard,
  subscribeRemoteRevision,
  usesRemoteDataBackend,
} from "../../src/remote-data-backend.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.replaceChildren();
  localStorage.clear();
});

describe("remote dashboard data backend", () => {
  it("activates only for the server-injected backend marker", () => {
    expect(usesRemoteDataBackend(document)).toBe(false);
    const meta = document.createElement("meta");
    meta.name = "dashboard-data-backend";
    meta.content = "redis-http";
    document.head.append(meta);
    expect(usesRemoteDataBackend(document)).toBe(true);
  });

  it("removes static dashboard workers and caches in remote mode", async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const deleteCache = vi.fn().mockResolvedValue(true);

    await disableRemoteDashboardPwa({
      serviceWorkers: /** @type {never} */ ({
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      }),
      cacheStorage: /** @type {never} */ ({
        keys: vi.fn().mockResolvedValue([
          "central-agentic-ops-dashboard-app-v1",
          "central-agentic-ops-dashboard-data-v1",
          "unrelated-cache",
        ]),
        delete: deleteCache,
      }),
    });

    expect(unregister).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
  });

  it("posts compiled query context without Redis connection details", async () => {
    localStorage.setItem("cao-dashboard-access-token", "test-access-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        revision: 4,
        evaluatedAt: "2026-09-23T00:00:00.000Z",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        revision: 4,
        evaluatedAt: "2026-09-23T00:00:00.000Z",
        sources: { runs: { source: "runs", rows: [], metadata: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryRemoteDashboard(["simulated-usage"], {
      pages: [{
        id: "runs",
        form: {
          fields: [{ id: "multiplier", default: 2 }],
        },
        views: [{ id: "simulation", data: { source: "simulated-usage" } }],
      }],
      queries: [{
        name: "simulated-usage",
        parameters: [{ name: "multiplier", type: "number" }],
        from: "usage",
        compute: [{
          as: "simulated-aic",
          function: "product",
          args: [{ field: "aic" }, { parameter: "multiplier" }],
        }],
      }],
      views: [],
    }, undefined, { pageId: "runs", queryContext: { formValues: { multiplier: 3 } } });

    expect(result.revision).toBe(4);
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    expect(init).toBeDefined();
    const request = JSON.parse(String(init?.body));
    expect(request.sourceNames).toEqual(["simulated-usage"]);
    expect(request.queries[0].compute[0].args[1]).toEqual({ value: 3 });
    expect(request.compiledQueries.at(-1).compute[0].args[1]).toEqual({ value: 3 });
    expect(JSON.stringify(request)).not.toMatch(/redis|credential|password/i);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
  });

  it("refreshes through the server without asking the browser to ingest data", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 5, changed: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 5, sources: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshRemoteDashboard([], { pages: [], queries: [], views: [] });

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/api/v1/refresh",
      "/api/v1/query",
    ]);
  });

  it("resolves repository memory through the authenticated server API", async () => {
    const manifest = { version: 1, campaigns: [{ campaign: "security-review", files: [] }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "# Context" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryRemoteRepositoryMemory("security-review", undefined)).resolves.toEqual(manifest);
    await expect(queryRemoteRepositoryMemory("security-review", "notes/context.md"))
      .resolves.toEqual({ content: "# Context" });

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname + new URL(url).search)).toEqual([
      "/api/v1/memory/security-review",
      "/api/v1/memory/security-review/content?path=notes%2Fcontext.md",
    ]);
  });

  it("authenticates the revision stream without an ambient cookie", async () => {
    localStorage.setItem("cao-dashboard-access-token", "stream-access-token");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"revision":9}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const revision = new Promise((resolve) => {
      const stop = subscribeRemoteRevision((value) => {
        stop();
        resolve(value);
      });
    });

    await expect(revision).resolves.toBe(9);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/v1/events"), expect.objectContaining({
      credentials: "omit",
      headers: expect.objectContaining({ Authorization: "Bearer stream-access-token" }),
    }));
  });

  it("stays silent by default and logs only scalar metadata under its predictable category", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => "?debug=remote-data-backend", output }),
      };
    });
    vi.resetModules();
    const { refreshRemoteDashboard: refreshRemoteDashboardWithDebug } = await import("../../src/remote-data-backend.js");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 1, evaluatedAt: "2026-09-23T00:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not-found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshRemoteDashboardWithDebug([], { pages: [], queries: [], views: [] }))
      .rejects.toThrow();

    expect(output.debug).toHaveBeenCalledWith("[cao:remote-data-backend]", { event: "refresh-checked", changed: false });
    expect(output.debug).toHaveBeenCalledWith("[cao:remote-data-backend]", { event: "request-failed", path: "/api/v1/query", status: 404 });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== "object")).toBe(true);
    }
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/authorization|token|redis/i);

    vi.doUnmock("../../src/debug.js");
    vi.resetModules();
  });

  it("is disabled by default (no debug output) when the debug query is absent", async () => {
    const output = { debug: vi.fn() };
    vi.doMock("../../src/debug.js", async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual("../../src/debug.js")
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => "", output }),
      };
    });
    vi.resetModules();
    const { refreshRemoteDashboard: refreshRemoteDashboardWithoutDebug } = await import("../../src/remote-data-backend.js");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 1, evaluatedAt: "2026-09-23T00:00:00.000Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 1, sources: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshRemoteDashboardWithoutDebug([], { pages: [], queries: [], views: [] });

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock("../../src/debug.js");
    vi.resetModules();
  });
});
