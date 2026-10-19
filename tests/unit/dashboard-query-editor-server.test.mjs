import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { nativeDashboardFixture, startNativeDashboard } from "../helpers/native-dashboard.mjs";

const document = await readFile(new URL("../../dashboard/site/test/fixtures/query-editor.json", import.meta.url), "utf8");
const intent = { intent: "Find failing workflows", subject: "Workflow failures", acceptance: "Show native conclusions." };

async function preview(t, { canvas = false, dashboardDocument = document } = {}) {
  const data = await nativeDashboardFixture();
  let server;
  t.after(async () => { await server?.close(); await data.close(); });
  const dashboard = join(data.workspace, "dashboard.json");
  await writeFile(dashboard, dashboardDocument);
  const settings = { ...data, canvas, dashboard, ghExecutable: join(data.workspace, "unavailable-gh") };
  server = await startNativeDashboard(settings);
  return {
    root: data.workspace,
    get url() { return server.url; },
    close: () => server.close(),
    async restart() { await server.close(); server = await startNativeDashboard(settings); },
  };
}
const requestOptions = (server, payload = intent, origin = new URL(server.url).origin) => ({
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(payload),
});
const manifest = async (server) => (await fetch(`${server.url}/dashboard.json`)).json();
const chunk = async (server, page) => (await fetch(`${server.url}/${page.chunk}`)).json();

test("native query editor is canvas-only and query flags cannot grant authoring capability", async (t) => {
  const normal = await preview(t);
  for (const path of ["/__query_designer", "/__query_designer/enhance", "/__custom_views"]) {
    assert.equal((await fetch(`${normal.url}${path}`, requestOptions(normal))).status, 404);
  }
  assert.equal((await fetch(`${normal.url}/?local-preview=canvas`)).status, 200);
  assert.equal((await manifest(normal)).dashboard.pages.some(({ id }) => id === "query-editor"), false);
  const canvas = await preview(t, { canvas: true });
  const dashboard = await manifest(canvas);
  const page = dashboard.dashboard.pages.find(({ id }) => id === "query-editor");
  assert.ok(page);
  const experimental = dashboard.dashboard.navigation.filter(({ experimental }) => experimental);
  assert.equal(experimental.length, 1);
  assert.deepEqual(experimental[0].pages, ["query-editor"]);
  const editor = await chunk(canvas, page);
  assert.equal(editor.page.views[0].element, "query-editor");
  assert.deepEqual(editor.page.views[0].data.sources, []);
});

test("native authoring joins existing Experimental navigation exactly once", async (t) => {
  const base = JSON.parse(document);
  base.dashboard.navigation = [{ label: "Experimental", experimental: true, pages: ["query-preview"] }];
  const server = await preview(t, { canvas: true, dashboardDocument: JSON.stringify(base) });
  const sections = (await manifest(server)).dashboard.navigation.filter(({ experimental }) => experimental);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].pages, ["query-preview", "query-editor"]);
});

// SDK success, repair, concurrency, cancellation, no-tools and output budgets are covered with native Go providers.
test("native authoring HTTP rejects unsafe transport and budgets before starting an SDK session", async (t) => {
  const server = await preview(t, { canvas: true });
  const endpoint = `${server.url}/__query_designer`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, requestOptions(server, intent, "https://untrusted.test"))).status, 403);
  for (const payload of [null, [], {}, { ...intent, model: "custom" }, { ...intent, acceptance: "x".repeat(512) }]) {
    assert.equal((await fetch(endpoint, requestOptions(server, payload))).status, 400);
  }
  assert.equal((await fetch(endpoint, requestOptions(server, { ...intent, intent: "x".repeat(200000) }))).status, 413);
  assert.equal((await fetch(`${new URL(server.url).origin}/__query_designer`, requestOptions(server))).status, 404);
  const enhancement = `${endpoint}/enhance`;
  assert.equal((await fetch(enhancement)).status, 405);
  assert.equal((await fetch(enhancement, requestOptions(server, { intent: "Find failures", tools: ["shell"] }))).status, 400);
  assert.equal((await fetch(enhancement, requestOptions(server, { intent: "Find failures" }, "https://untrusted.test"))).status, 403);
});

test("native custom views validate, isolate sources, deduplicate and restore durable saves without exposing storage failures", async (t) => {
  const server = await preview(t, { canvas: true });
  const endpoint = () => `${server.url}/__custom_views`;
  assert.equal((await fetch(endpoint())).status, 405);
  assert.equal((await fetch(endpoint(), requestOptions(server, { document }, "https://untrusted.test"))).status, 403);
  for (const payload of [{ document, path: "../outside.json" }, { document: "[invalid" }, { document: "{}" }]) {
    assert.equal((await fetch(endpoint(), requestOptions(server, payload))).status, 400);
  }
  const unsafe = JSON.parse(document);
  unsafe.dashboard["cli-actions"] = [{ id: "unsafe", label: "Unsafe", icon: "play", command: "gh aw compile" }];
  assert.equal((await fetch(endpoint(), requestOptions(server, { document: JSON.stringify(unsafe) }))).status, 400);
  const response = await fetch(endpoint(), requestOptions(server, { document }));
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.match(saved.id, /^local-[a-f0-9]{24}$/);
  assert.match(saved.path, /^\.cao\/dashboard\/custom-views\/local-[a-f0-9]{24}\.json$/);
  assert.deepEqual(JSON.parse(await readFile(join(server.root, saved.path), "utf8")), JSON.parse(document));
  const dashboard = await manifest(server);
  assert.ok(dashboard.dashboard.navigation.some(({ label, pages }) => label === "Custom views" && pages.includes(saved.id)));
  const page = dashboard.dashboard.pages.find(({ id }) => id === saved.id);
  assert.equal((await chunk(server, page)).page.views[0].data.source, `${saved.id}-failure-counts`);
  const duplicate = await (await fetch(endpoint(), requestOptions(server, { document }))).json();
  assert.equal(duplicate.id, saved.id);
  assert.equal((await manifest(server)).dashboard.pages.filter(({ id }) => id === saved.id).length, 1);
  await server.restart();
  const restoredPage = (await manifest(server)).dashboard.pages.find(({ id }) => id === saved.id);
  assert.ok(restoredPage);
  assert.equal((await chunk(server, restoredPage)).page.views[0].data.source, `${saved.id}-failure-counts`);
  const separate = await preview(t, { canvas: true });
  assert.equal((await manifest(separate)).dashboard.pages.some(({ id }) => id === saved.id), false);
  await writeFile(join(server.root, saved.path), "[invalid");
  const failed = await fetch(endpoint(), requestOptions(server, { document }));
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes(server.root), false);
});
