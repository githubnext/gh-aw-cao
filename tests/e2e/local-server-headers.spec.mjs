import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:4173";

test.describe("local-server HTTP response headers", () => {
  test("index.html serves correct Content-Type and Cache-Control", async ({ request }) => {
    const response = await request.get(`${BASE}/`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("sources.json serves JSON with no-store cache", async ({ request }) => {
    const response = await request.get(`${BASE}/sources.json`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("dashboard.json serves JSON with no-store cache", async ({ request }) => {
    const response = await request.get(`${BASE}/dashboard.json`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("JavaScript files serve correct Content-Type", async ({ request }) => {
    const response = await request.get(`${BASE}/src/presenter.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  test("CSS files serve correct Content-Type", async ({ request }) => {
    const response = await request.get(`${BASE}/src/styles.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  test("HEAD requests return headers without body", async ({ request }) => {
    const response = await request.head(`${BASE}/`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
    const body = await response.body();
    expect(body.length).toBe(0);
  });

  test("non-GET/HEAD methods return 405 with Allow header", async ({ request }) => {
    const response = await request.delete(`${BASE}/`);
    expect(response.status()).toBe(405);
    expect(response.headers()["allow"]).toBe("GET, HEAD");
  });

  test("path traversal returns 404", async ({ request }) => {
    const response = await request.get(`${BASE}/../package.json`);
    expect(response.status()).toBe(404);
  });

  test("unsupported file extension returns 404", async ({ request }) => {
    const response = await request.get(`${BASE}/test.exe`);
    expect(response.status()).toBe(404);
  });

  test("nonexistent file returns 404", async ({ request }) => {
    const response = await request.get(`${BASE}/does-not-exist.html`);
    expect(response.status()).toBe(404);
  });
});
