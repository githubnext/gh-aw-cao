import { afterEach, describe, expect, it, vi } from "vitest";
import {
  queryRemoteDashboard,
  refreshRemoteDashboard,
  subscribeRemoteRevision,
  usesRemoteDataBackend,
} from "../../src/remote-data-backend.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.replaceChildren();
  sessionStorage.clear();
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

  it("posts compiled query context without Redis connection details", async () => {
    sessionStorage.setItem("cao-dashboard-access-token", "test-access-token");
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

    const result = await queryRemoteDashboard(["runs"], {
      pages: [{ id: "runs", views: [] }],
      queries: [],
      views: [],
    }, undefined, { pageId: "runs" });

    expect(result.revision).toBe(4);
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    expect(init).toBeDefined();
    const request = JSON.parse(String(init?.body));
    expect(request.sourceNames).toEqual(["runs"]);
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

  it("authenticates the revision stream without an ambient cookie", async () => {
    sessionStorage.setItem("cao-dashboard-access-token", "stream-access-token");
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
});
