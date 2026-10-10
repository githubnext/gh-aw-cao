import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startDashboardServer } from "../../dashboard/local-server.mjs";
import { CANONICAL_SCHEMA_VERSION } from "../../dashboard/site/src/data/model/schema.js";
import { normalize } from "../../dashboard/site/src/data/normalize/index.js";
import { queryDashboardSourceObservations } from "../../dashboard/site/src/data/queries/ingestion.js";
import { NORMALIZED_JSONL_INGESTION_VERSION } from "../../dashboard/site/src/data/ingest/coordinator.js";

for (const { canvas, dataBackend, expected } of [
  { canvas: true, expected: "sqlite" },
  { canvas: true, dataBackend: "indexeddb", expected: "indexeddb" },
  { canvas: false, expected: "indexeddb" },
  { canvas: false, dataBackend: "sqlite", expected: "sqlite" },
]) {
  test(`local ${canvas ? "canvas" : "browser"} preview selects ${dataBackend ?? "default"} backend`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cao-backend-selection-"));
    let preview;
    try {
      await writeFile(join(root, "index.html"), "<html><head></head><body>preview</body></html>");
      await writeFile(join(root, "dashboard.json"), JSON.stringify({
        "language-version": "0.1.0",
        dashboard: {
          id: "test", title: "Test", navigation: [{ label: "Test", pages: ["test"] }],
          pages: [{ id: "test", title: "Test", kind: "custom", views: [] }],
        },
      }));
      preview = await startDashboardServer({
        workingDirectory: root, siteRoot: root, catalogRoot: null, port: 0, canvas, dataBackend,
        approveCliAction: async () => false, executeCliAction: async () => {},
        output: () => {}, traceOutput: () => {}, requestOutput: () => {},
        downloadData: async (destination) => {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "sources.json"), "{}");
        },
      });
      const html = await (await fetch(`${preview.url}/`)).text();
      assert.equal(html.includes('name="dashboard-data-backend" content="server-http"'), expected === "sqlite");
      assert.equal((await fetch(`${preview.url}/api/v1/diagnostics`)).status, expected === "sqlite" ? 200 : 404);
    } finally {
      await preview?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("local server rejects an invalid data backend before startup", async () => {
  await assert.rejects(startDashboardServer({ dataBackend: "redis" }), /must be sqlite or indexeddb/);
});

test("canvas ingests phased Activity into SQLite and serves aliases, pagination, and memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cao-canvas-sqlite-"));
  let preview;
  try {
    await writeFile(join(root, "index.html"), "<html><head></head><body>preview</body></html>");
    await writeFile(join(root, "dashboard.json"), JSON.stringify({
      "language-version": "0.1.0",
      dashboard: {
        id: "test", title: "Test", navigation: [{ label: "Test", pages: ["test"] }],
        pages: [{ id: "test", title: "Test", kind: "custom", views: [] }],
      },
    }));
    const metadata = { "as-of": new Date().toISOString() };
    const batch = normalize(queryDashboardSourceObservations({
      repositories: {
        metadata, rows: [{ organization: "acme", repository: "one" }, { organization: "acme", repository: "two" }],
      },
    }).observations);
    const content = "bounded memory\n";
    preview = await startDashboardServer({
      workingDirectory: root, siteRoot: root, catalogRoot: null, port: 0, canvas: true,
      approveCliAction: async () => false,
      executeCliAction: async () => {},
      output: () => {}, traceOutput: () => {}, requestOutput: () => {},
      downloadData: async (destination) => {
        for (const phase of ["runs", "records"]) {
          const directory = join(destination, `gh-aw-logs-${phase}`);
          await mkdir(directory, { recursive: true });
          const records = phase === "runs" ? batch.repositories : [];
          await writeFile(join(directory, "1.jsonl"), [
            JSON.stringify({
              kind: "metadata", phase, records: records.length,
              schemaVersion: CANONICAL_SCHEMA_VERSION, ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
            }),
            ...records.map((record) => JSON.stringify({ kind: "record", collection: "repositories", record })),
          ].join("\n") + "\n");
        }
        await writeFile(join(destination, "inventory-sources.json"), "{}");
        await mkdir(join(destination, "memory", "dashboard"), { recursive: true });
        await writeFile(join(destination, "memory", "dashboard", "notes.md"), content);
        await writeFile(join(destination, "memory", "manifest.json"), JSON.stringify({
          version: 1,
          campaigns: [{
            campaign: "dashboard", branch: "memory/dashboard", commit: "a".repeat(40),
            files: [{
              path: "notes.md", size: Buffer.byteLength(content), oid: "b".repeat(40),
              sha256: createHash("sha256").update(content).digest("hex"),
            }],
          }],
        }));
      },
    });
    const projection = (await readdir(root)).find((name) => name.startsWith(".cao-dashboard-preview-"));
    const database = new DatabaseSync(join(root, projection, "dashboard.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT count(*) AS records FROM __idb_records WHERE store_name = 'repositories'").get().records, 2);
    } finally {
      database.close();
    }
    const base = `${preview.url}/`;
    const query = async (pagination = {}) => {
      const response = await fetch(`${base}api/v1/query`, {
        method: "POST",
        headers: { Origin: new URL(base).origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceNames: ["repositories"], replacedSources: ["repositories"], aliases: ["selected"],
          compiledQueries: [{ name: "selected", from: "repositories", "order-by": [{ field: "repository" }] }],
          pagination,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).sources;
    };
    const first = await query({ selected: { limit: 1 } });
    assert.deepEqual(Object.keys(first), ["selected"]);
    assert.equal(first.selected.rows[0].repository, "one");
    const token = first.selected.continuationToken;
    assert.equal(typeof token, "string");
    const second = await query({ selected: { limit: 1, continuationToken: token } });
    assert.equal(second.selected.rows[0].repository, "two");
    const memory = await (await fetch(`${base}api/v1/memory/dashboard/content?path=notes.md`)).json();
    assert.equal(memory.content, content);
    const listing = await (await fetch(`${base}api/v1/memory/dashboard`)).json();
    assert.equal(listing.files[0].path, "notes.md");
  } finally {
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  }
});
