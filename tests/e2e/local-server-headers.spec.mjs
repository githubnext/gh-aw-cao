import { test, expect } from "@playwright/test";
import { nativeDashboardFixture, startNativeDashboard } from "../helpers/native-dashboard.mjs";

let fixture;
let preview;

test.beforeAll(async () => {
  fixture = await nativeDashboardFixture();
  preview = await startNativeDashboard({ workspace: fixture.workspace, data: fixture.data });
});

test.afterAll(async () => {
  try { await preview?.close(); } finally { await fixture?.close(); }
});

test.describe("local-server HTTP response headers", () => {
  test("index.html serves correct Content-Type and Cache-Control", async ({ request }) => {
    const response = await request.get(`${preview.url}/`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("inventory serves JSON with no-store cache", async ({ request }) => {
    const response = await request.get(`${preview.url}/inventory-sources.json`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("dashboard.json serves JSON with no-store cache", async ({ request }) => {
    const response = await request.get(`${preview.url}/dashboard.json`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("JavaScript files serve correct Content-Type", async ({ request }) => {
    const response = await request.get(`${preview.url}/src/presenter.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  test("CSS files serve correct Content-Type", async ({ request }) => {
    const response = await request.get(`${preview.url}/src/styles.js`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  test("HEAD requests return headers without body", async ({ request }) => {
    const response = await request.head(`${preview.url}/`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/html; charset=utf-8");
    const body = await response.body();
    expect(body.length).toBe(0);
  });

  test("non-GET/HEAD methods return 405 with Allow header", async ({ request }) => {
    const response = await request.delete(`${preview.url}/`, { headers: { Origin: new URL(preview.url).origin } });
    expect(response.status()).toBe(405);
    expect(response.headers()["allow"]).toBe("GET, HEAD");
  });

  test("path traversal returns 404", async ({ request }) => {
    const response = await request.get(`${preview.url}/../package.json`);
    expect(response.status()).toBe(404);
  });

  test("unsupported file extension returns 404", async ({ request }) => {
    const response = await request.get(`${preview.url}/test.exe`);
    expect(response.status()).toBe(404);
  });

  test("nonexistent file returns 404", async ({ request }) => {
    const response = await request.get(`${preview.url}/does-not-exist.html`);
    expect(response.status()).toBe(404);
  });
});
