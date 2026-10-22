import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startCanvasServer } from "../../dashboard/canvas-server.mjs";
import { CANONICAL_SCHEMA_VERSION } from "../../dashboard/site/src/data/model/schema.js";
import { normalize } from "../../dashboard/site/src/data/normalize/index.js";
import { queryDashboardSourceObservations } from "../../dashboard/site/src/data/queries/ingestion.js";
import { NORMALIZED_JSONL_INGESTION_VERSION } from "../../dashboard/site/src/data/ingest/coordinator.js";

async function mockCompilerMetadata(t, root, repository, version) {
  const ghExecutable = join(root, "gh");
  await writeFile(ghExecutable, `#!${process.execPath}
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2), ["auth", "token", "--hostname", "github.com"]);
console.log("test-credential");
`);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await chmod(ghExecutable, 0o700);
  const fetchImpl = globalThis.fetch;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "127.0.0.1") return fetchImpl(input, options);
    assert.equal(url.href, `https://api.github.com/repos/acme/${repository}/contents/.github/workflows/demo.lock.yml`);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Authorization, "Bearer test-credential");
    requests.push(url.href);
    return version ? Response.json({
      type: "file", path: ".github/workflows/demo.lock.yml",
      sha: "a".repeat(40), encoding: "base64",
      content: Buffer.from(`# gh-aw-metadata: ${JSON.stringify({ compiler_version: version })}\n`).toString("base64"),
    }) : Response.json({ message: "Not Found" }, { status: 404 });
  });
  return { ghExecutable, requests };
}

for (const { dataBackend, expected, compilerVersion } of [
  { expected: "sqlite", compilerVersion: "v0.91.6" },
  { expected: "sqlite" },
  { dataBackend: "indexeddb", expected: "indexeddb", compilerVersion: "v0.91.6" },
]) {
  test(`canvas preview selects ${dataBackend ?? "default"} backend with ${compilerVersion ? "fresh" : "unavailable"} compiler metadata`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "cao-backend-selection-"));
    let preview;
    try {
      const { ghExecutable, requests } = await mockCompilerMetadata(t, root, "control", compilerVersion);
      await writeFile(join(root, "index.html"), "<html><head></head><body>preview</body></html>");
      await writeFile(join(root, "dashboard.json"), JSON.stringify({
        "language-version": "0.1.0",
        dashboard: {
          id: "test", title: "Test", navigation: [{ label: "Test", pages: ["test"] }],
          pages: [{ id: "test", title: "Test", kind: "custom", views: [] }],
        },
      }));
      preview = await startCanvasServer({
        workingDirectory: root, siteRoot: root, catalogRoot: null, port: 0, dataBackend, ghExecutable,
        approveCliAction: async () => false, executeCliAction: async () => {},
        output: () => {}, traceOutput: () => {}, requestOutput: () => {},
        downloadData: async (destination) => {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "sources.json"), JSON.stringify({
            workflows: {
              metadata: { "as-of": "2026-10-01T00:00:00Z" },
              rows: [{
                organization: "acme", repository: "control", workflow: "demo.md",
                "gh-aw-version": "v0.91.5", "gh-aw-current-version": "v0.89.21",
                "gh-aw-update-state": "up-to-date",
              }],
            },
          }));
          return { latestGhAwVersion: "v0.92.0" };
        },
      });
      const html = await (await fetch(`${preview.url}/`)).text();
      assert.equal(html.includes('name="dashboard-data-backend" content="server-http"'), expected === "sqlite");
      assert.equal(html.includes('name="dashboard-storage-backend" content="sqlite"'), expected === "sqlite");
      assert.equal((await fetch(`${preview.url}/api/v1/diagnostics`)).status, expected === "sqlite" ? 200 : 404);
      if (expected === "sqlite") {
        const response = await fetch(`${preview.url}/api/v1/query`, {
          method: "POST",
          headers: { Origin: new URL(preview.url).origin, "Content-Type": "application/json" },
          body: JSON.stringify({ sourceNames: ["workflows"] }),
        });
        assert.equal(response.status, 200);
        const { sources } = await response.json();
        assert.equal(sources.workflows.rows[0]["gh-aw-current-version"], "v0.92.0");
        assert.equal(sources.workflows.rows[0]["gh-aw-version"], compilerVersion ?? "v0.91.5");
        assert.equal(sources.workflows.rows[0]["gh-aw-update-state"], !compilerVersion ? "unknown" : "update-available");
      }
      assert.equal(requests.length, 1);
    } finally {
      await preview?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("local server rejects an invalid data backend before startup", async () => {
  await assert.rejects(startCanvasServer({ dataBackend: "redis" }), /must be sqlite or indexeddb/);
});

async function assertPhasedActivityPreview(t, compilerVersion) {
  const root = await mkdtemp(join(tmpdir(), "cao-canvas-sqlite-"));
  let preview;
  try {
    const { ghExecutable, requests } = await mockCompilerMetadata(t, root, "one", compilerVersion);
    await writeFile(join(root, "index.html"), "<html><head></head><body>preview</body></html>");
    await writeFile(join(root, "dashboard.json"), JSON.stringify({
      "language-version": "0.1.0",
      dashboard: {
        id: "test", title: "Test", navigation: [{ label: "Test", pages: ["test"] }],
        pages: [{ id: "test", title: "Test", kind: "custom", views: [] }],
      },
    }));
    const metadata = { "as-of": new Date().toISOString() };
    const workflowSources = {
      workflows: {
        metadata,
        rows: [{
          organization: "acme", repository: "one", workflow: "demo.md",
          "gh-aw-version": "v0.91.5", "gh-aw-current-version": "v0.89.21",
          "gh-aw-update-state": "up-to-date",
        }],
      },
    };
    const batch = normalize(queryDashboardSourceObservations({
      ...workflowSources,
      repositories: {
        metadata, rows: [{ organization: "acme", repository: "one" }, { organization: "acme", repository: "two" }],
      },
    }).observations);
    const content = "bounded memory\n";
    preview = await startCanvasServer({
      workingDirectory: root, siteRoot: root, catalogRoot: null, port: 0, ghExecutable,
      approveCliAction: async () => false,
      executeCliAction: async () => {},
      output: () => {}, traceOutput: () => {}, requestOutput: () => {},
      downloadData: async (destination) => {
        for (const phase of ["runs", "records"]) {
          const directory = join(destination, `gh-aw-logs-${phase}`);
          await mkdir(directory, { recursive: true });
          const records = phase === "runs" ? [
            ...batch.repositories.map((record) => ({ kind: "record", collection: "repositories", record })),
            ...batch.workflows.map((record) => ({ kind: "record", collection: "workflows", record })),
          ] : [];
          await writeFile(join(directory, "1.jsonl"), [
            JSON.stringify({
              kind: "metadata", phase, records: records.length,
              schemaVersion: CANONICAL_SCHEMA_VERSION, ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
            }),
            ...records.map((record) => JSON.stringify(record)),
          ].join("\n") + "\n");
        }
        await writeFile(join(destination, "inventory-sources.json"), JSON.stringify(workflowSources));
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
        return { latestGhAwVersion: "v0.92.0" };
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
    const workflowResponse = await fetch(`${base}api/v1/query`, {
      method: "POST",
      headers: { Origin: new URL(base).origin, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceNames: ["workflows"] }),
    });
    assert.equal(workflowResponse.status, 200);
    const { sources } = await workflowResponse.json();
    assert.equal(sources.workflows.rows[0]["gh-aw-current-version"], "v0.92.0");
    assert.equal(sources.workflows.rows[0]["gh-aw-version"], compilerVersion ?? "v0.91.5");
    assert.equal(sources.workflows.rows[0]["gh-aw-update-state"], compilerVersion ? "update-available" : "unknown");
    assert.equal(requests.length, 1);
    const memory = await (await fetch(`${base}api/v1/memory/dashboard/content?path=notes.md`)).json();
    assert.equal(memory.content, content);
    const listing = await (await fetch(`${base}api/v1/memory/dashboard`)).json();
    assert.equal(listing.files[0].path, "notes.md");
  } finally {
    await preview?.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const compilerVersion of ["v0.91.6", null]) {
  test(`canvas ingests phased Activity into SQLite and serves aliases, pagination, and memory with ${compilerVersion ? "fresh" : "unavailable"} compiler metadata`, async (t) => {
    await assertPhasedActivityPreview(t, compilerVersion);
  });
}
