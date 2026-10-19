import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startLocalDashboardPreview } from "../../com.github.copilot/extensions/cao-dashboard/local-preview.mjs";
import { nativeDashboardFixture } from "../helpers/native-dashboard.mjs";

const staged = async (workspace) => (await readdir(workspace)).filter((name) => name.startsWith(".cao-dashboard-preview-"));

test("native canvas stages a complete site in a foreign workspace and cleans up on SIGTERM", async () => {
  const fixture = await nativeDashboardFixture();
  let preview;
  try {
    preview = await startLocalDashboardPreview({
      workingDirectory: fixture.workspace, repository: "acme/control",
      dataDirectory: fixture.data, approveCliAction: async () => false,
    });
    const base = new URL(`${preview.url}/`);
    assert.equal(base.hostname, "127.0.0.1");
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal(new URL(response.url).searchParams.get("local-preview"), "canvas");
    assert.match(await response.text(), /name="dashboard-data-backend" content="server-http"/);
    assert.equal((await fetch(new URL("src/main.js", base))).status, 200);
    const document = await (await fetch(new URL("dashboard.json", base))).json();
    assert.equal(document.dashboard.repository, "acme/control");
    assert.ok(document.dashboard.pages.length > 0);
    const query = await fetch(new URL("api/v1/query", base), {
      method: "POST", headers: { Origin: base.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceNames: ["count"], queries: [{
        name: "count", from: "$repositories", aggregate: { values: [{ field: "id", as: "count", reducer: "count" }] },
      }] }),
    });
    assert.equal(query.status, 200);
    assert.deepEqual((await query.json()).sources.count.rows, [{ count: 1 }]);
    const diagnostics = await (await fetch(new URL("api/v1/diagnostics", base))).json();
    assert.equal(diagnostics.counts.repositories, 1);
    assert.equal((await fetch(new URL("/api/v1/diagnostics", base))).status, 404);
    const events = await fetch(new URL("api/v1/events", base));
    assert.match(events.headers.get("Content-Type"), /text\/event-stream/);
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /"revision":/);
    await reader.cancel();
    assert.equal((await staged(fixture.workspace)).length, 1);
    await preview.close();
    await preview.close();
    assert.deepEqual(await staged(fixture.workspace), []);
    await assert.rejects(fetch(base));
  } finally {
    try { await preview?.close(); } finally { await fixture.close(); }
  }
});

test("native canvas fails closed on a corrupt snapshot and removes staged assets", async () => {
  const fixture = await nativeDashboardFixture();
  try {
    await writeFile(join(fixture.data, "gh-aw-logs.sqlite"), "not a canonical snapshot");
    await assert.rejects(startLocalDashboardPreview({
      workingDirectory: fixture.workspace, dataDirectory: fixture.data,
      approveCliAction: async () => false,
    }), /hash|checksum|SQLite|integrity/i);
    assert.deepEqual(await staged(fixture.workspace), []);
  } finally { await fixture.close(); }
});

test("canvas startup requires trusted host approval before spawning an operator", async () => {
  await assert.rejects(startLocalDashboardPreview({ workingDirectory: "." }), /trusted CLI action approval/);
});
