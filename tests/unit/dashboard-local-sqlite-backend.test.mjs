import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeDashboardFixture, startNativeDashboard } from "../helpers/native-dashboard.mjs";

const observedAt = "2026-10-01T00:00:00Z";
const repositoryId = (repository) => `repository:acme%2F${repository}`;
const workflowId = (repository) => `workflow:acme%2F${repository}%3A.github%2Fworkflows%2Fdemo.md`;

async function fixture(repository = "control", { history = false } = {}) {
  const records = {
    repositories: [repository, ...(history ? ["two"] : [])].map((name) => ({
      id: repositoryId(name), owner: "acme", name,
    })),
    workflows: [{
      id: workflowId(repository), repositoryId: repositoryId(repository), path: ".github/workflows/demo.md", name: "Demo",
      ghAwVersion: "v0.91.5", ghAwCurrentVersion: "v0.89.21", ghAwUpdateState: "up-to-date",
      observedAt,
    }, ...(history ? [
      { id: "workflow:historical", repositoryId: repositoryId(repository), path: ".github/workflows/removed.md",
        ghAwVersion: "v0.90.0", ghAwCurrentVersion: "v0.89.21", ghAwUpdateState: "up-to-date", observedAt },
      { id: "workflow:placeholder", repositoryId: repositoryId(repository), name: "Historical placeholder" },
    ] : [])],
  };
  const result = await nativeDashboardFixture(records);
  try {
    const site = join(result.workspace, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<html><head></head><body>preview</body></html>");
    await writeFile(join(site, "dashboard.json"), JSON.stringify({
      "language-version": "0.1.0",
      dashboard: {
        id: "test", title: "Test", navigation: [{ label: "Test", pages: ["test"] }],
        pages: [{ id: "test", title: "Test", kind: "custom", views: [] }],
      },
    }));
    await writeFile(join(result.data, "inventory-sources.json"), JSON.stringify({
      workflows: {
        metadata: { "as-of": observedAt },
        rows: [{
          organization: "acme", repository, workflow: "demo.md",
          "gh-aw-version": "v0.91.5", "gh-aw-current-version": "v0.89.21",
          "gh-aw-update-state": "up-to-date", "observed-at": observedAt,
        }],
      },
    }));
    return { ...result, site, records };
  } catch (error) {
    await result.close();
    throw error;
  }
}

async function compilerMetadataFixture(artifact, repository, version) {
  const ghExecutable = join(artifact.workspace, "fake-gh");
  const metadata = Buffer.from(`# gh-aw-metadata: ${JSON.stringify({ compiler_version: version })}\n`).toString("base64");
  await writeFile(join(artifact.workspace, "compiler-response.json"), JSON.stringify({
    type: "file", path: ".github/workflows/demo.lock.yml", sha: "a".repeat(40), encoding: "base64", content: metadata,
  }));
  await writeFile(ghExecutable, `#!/bin/sh
printf '%s\\n' "$*" >> gh-calls
case "$1 $2" in
  'auth status') exit 0 ;;
  'api repos/acme/control') printf '{"default_branch":"main","full_name":"acme/control"}\\n' ;;
  'api repos/acme/control/actions/artifacts?name=central-agentic-ops-dashboard&per_page=100')
    printf '{"artifacts":[{"name":"central-agentic-ops-dashboard","expired":false,"created_at":"2026-10-01T00:00:00Z","workflow_run":{"id":42}}]}\\n' ;;
  'api repos/acme/control/actions/runs/42')
    printf '{"status":"completed","conclusion":"success","head_branch":"main","path":".github/workflows/cao-dashboard.yml","head_repository":{"full_name":"acme/control"}}\\n' ;;
  'api repos/github/gh-aw/releases/latest') printf '{"tag_name":"v0.92.0"}\\n' ;;
  'api repos/acme/${repository}/contents/.github/workflows/demo.lock.yml') ${version ? "cat compiler-response.json" : "exit 1"} ;;
  'run download')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--dir' ]; then shift; cp -R data/. "$1"/; exit 0; fi
      shift
    done
    exit 2 ;;
  *) exit 3 ;;
esac
`);
  await chmod(ghExecutable, 0o700);
  return {
    ghExecutable,
    calls: async () => (await readFile(join(artifact.workspace, "gh-calls"), "utf8")).trim().split("\n"),
  };
}

async function query(base, body) {
  const response = await fetch(new URL("api/v1/query", base), {
    method: "POST",
    headers: { Origin: base.origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

for (const { canvas, dataBackend, expected, compilerVersion } of [
  { canvas: true, expected: "sqlite", compilerVersion: "v0.91.6" },
  { canvas: true, expected: "sqlite" },
  { canvas: true, dataBackend: "indexeddb", expected: "indexeddb", compilerVersion: "v0.91.6" },
  { canvas: false, expected: "sqlite" },
  { canvas: false, dataBackend: "indexeddb", expected: "indexeddb" },
  { canvas: false, dataBackend: "sqlite", expected: "sqlite" },
]) {
  test(`native ${canvas ? "canvas" : "browser"} preview selects ${dataBackend ?? "default"} backend${canvas ? ` with ${compilerVersion ? "fresh" : "unavailable"} compiler metadata` : ""}`, async () => {
    const artifact = await fixture();
    let preview;
    try {
      const gh = await compilerMetadataFixture(artifact, "control", compilerVersion);
      preview = await startNativeDashboard({
        workspace: artifact.workspace, data: "", site: artifact.site, canvas, dataBackend, ghExecutable: gh.ghExecutable,
      });
      const base = new URL(`${preview.url}/`);
      const html = await (await fetch(base)).text();
      assert.equal(html.includes('name="dashboard-data-backend" content="server-http"'), expected === "sqlite");
      assert.equal(html.includes('name="dashboard-storage-backend" content="sqlite"'), expected === "sqlite");
      assert.equal((await fetch(new URL("api/v1/diagnostics", base))).status, expected === "sqlite" ? 200 : 404);
      if (expected === "sqlite") {
        const { sources } = await query(base, { sourceNames: ["workflows"] });
        assert.equal(sources.workflows.rows[0]["gh-aw-current-version"], "v0.92.0");
        assert.equal(sources.workflows.rows[0]["gh-aw-version"], compilerVersion ?? "v0.91.5");
        assert.equal(sources.workflows.rows[0]["gh-aw-update-state"], canvas && !compilerVersion ? "unknown" : "update-available");
      }
      const calls = await gh.calls();
      assert.equal(calls.filter((call) => call === "api repos/github/gh-aw/releases/latest").length, 1);
      assert.equal(calls.filter((call) => call === "api repos/acme/control/contents/.github/workflows/demo.lock.yml --include").length, canvas ? 1 : 0);
    } finally {
      try { await preview?.close(); } finally { await artifact.close(); }
    }
  });
}

test("native server rejects an invalid data backend before startup", async () => {
  const artifact = await fixture();
  try {
    await assert.rejects(startNativeDashboard({
      workspace: artifact.workspace, data: artifact.data, site: artifact.site, dataBackend: "redis",
    }),     /--data-backend must be sqlite or indexeddb; use serve-hosted for PostgreSQL/);
  } finally { await artifact.close(); }
});

for (const compilerVersion of ["v0.91.6", null]) {
  test(`native canvas serves phased Activity SQLite, aliases, pagination, history, events, and memory with ${compilerVersion ? "fresh" : "unavailable"} compiler metadata`, async () => {
    const artifact = await fixture("one", { history: true });
    let preview;
    try {
      const gh = await compilerMetadataFixture(artifact, "one", compilerVersion);
      const content = "bounded memory\n";
      await mkdir(join(artifact.data, "memory", "dashboard"), { recursive: true });
      await writeFile(join(artifact.data, "memory", "dashboard", "notes.md"), content);
      await writeFile(join(artifact.data, "memory", "manifest.json"), JSON.stringify({
        version: 1, campaigns: [{
          campaign: "dashboard", branch: "memory/dashboard", commit: "a".repeat(40),
          files: [{ path: "notes.md", size: Buffer.byteLength(content), oid: "b".repeat(40),
            sha256: createHash("sha256").update(content).digest("hex") }],
        }],
      }));
      for (const phase of ["runs", "records"]) {
        const directory = join(artifact.data, `gh-aw-logs-${phase}`);
        await mkdir(directory);
        const records = phase === "runs" ? Object.entries(artifact.records).flatMap(([collection, rows]) =>
          rows.map((record) => ({ kind: "record", collection, record }))) : [];
        await writeFile(join(directory, "1.jsonl"), [
          JSON.stringify({ kind: "metadata", phase, records: records.length }),
          ...records.map((record) => JSON.stringify(record)),
        ].join("\n") + "\n");
      }
      const snapshot = await readFile(join(artifact.data, "gh-aw-logs.sqlite"));
      preview = await startNativeDashboard({
        workspace: artifact.workspace, data: "", site: artifact.site, canvas: true, ghExecutable: gh.ghExecutable,
      });
      const projection = (await readdir(artifact.workspace)).find((name) => name.startsWith(".cao-dashboard-preview-"));
      const prepared = join(artifact.workspace, projection, "artifact", "gh-aw-logs.sqlite");
      assert.deepEqual(await readFile(prepared), snapshot);
      const database = new DatabaseSync(prepared, { readOnly: true });
      try {
        assert.equal(database.prepare("SELECT count(*) AS records FROM __idb_records WHERE store_name = 'repositories'").get().records, 2);
      } finally { database.close(); }
      const base = new URL(`${preview.url}/`);
      const aliases = (pagination = {}) => query(base, {
        sourceNames: ["repositories"], replacedSources: ["repositories"], aliases: ["selected"],
        compiledQueries: [{ name: "selected", from: "repositories", "order-by": [{ field: "repository" }] }],
        pagination,
      });
      const first = await aliases({ selected: { limit: 1 } });
      assert.deepEqual(Object.keys(first.sources), ["selected"]);
      assert.equal(first.sources.selected.rows[0].repository, "one");
      const token = first.sources.selected.continuationToken;
      assert.equal(typeof token, "string");
      const second = await aliases({ selected: { limit: 1, continuationToken: token } });
      assert.equal(second.sources.selected.rows[0].repository, "two");
      assert.equal(second.revision, first.revision);
      const { sources } = await query(base, { sourceNames: ["workflows"] });
      const retained = sources.workflows.rows.find((row) => row.workflow === ".github/workflows/demo.md");
      assert.equal(retained["gh-aw-current-version"], "v0.92.0");
      assert.equal(retained["gh-aw-version"], compilerVersion ?? "v0.91.5");
      assert.equal(retained["gh-aw-update-state"], compilerVersion ? "update-available" : "unknown");
      const history = (await query(base, { sourceNames: ["history"], queries: [{ name: "history", from: "$workflows" }] })).sources.history.rows;
      const historical = history.find((row) => row.id === "workflow:historical");
      assert.equal(historical.ghAwVersion, "v0.90.0");
      assert.equal(historical.ghAwCurrentVersion, "v0.92.0");
      assert.equal(historical.ghAwUpdateState, "update-available");
      assert.equal(historical.observedAt, observedAt);
      const placeholder = history.find((row) => row.id === "workflow:placeholder");
      assert.equal(placeholder.ghAwCurrentVersion, "v0.92.0");
      assert.equal(Object.hasOwn(placeholder, "ghAwVersion"), false);
      assert.equal(Object.hasOwn(placeholder, "ghAwUpdateState"), false);
      assert.equal((await gh.calls()).filter((call) => call === "api repos/acme/one/contents/.github/workflows/demo.lock.yml --include").length, 1);
      const memory = await (await fetch(new URL("api/v1/memory/dashboard/content?path=notes.md", base))).json();
      assert.equal(memory.content, content);
      const listing = await (await fetch(new URL("api/v1/memory/dashboard", base))).json();
      assert.equal(listing.files[0].path, "notes.md");
      const events = await fetch(new URL("api/v1/events", base), { signal: AbortSignal.timeout(5000) });
      assert.match(events.headers.get("Content-Type"), /text\/event-stream/);
      const reader = events.body.getReader();
      try {
        const event = new TextDecoder().decode((await reader.read()).value);
        const data = event.split("\n").find((line) => line.startsWith("data: "));
        assert.equal(JSON.parse(data.slice("data: ".length)).revision, first.revision);
      } finally { await reader.cancel(); }
      assert.deepEqual(await readFile(prepared), snapshot);
    } finally {
      try { await preview?.close(); } finally { await artifact.close(); }
    }
  });
}
