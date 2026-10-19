import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { downloadDeployedDashboardData } from "../e2e/dashboard-view-data.mjs";
import { startDashboardSiteFixture } from "../e2e/dashboard-site-fixture.mjs";
import { startNativeDashboard } from "../helpers/native-dashboard.mjs";

const snapshot = "canonical SQLite snapshot bytes";
const hash = (content) => createHash("sha256").update(content).digest("hex");
const temporaryDirectory = async () => {
  const scratch = join(process.cwd(), ".tmp");
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, "dashboard-view-data-"));
};

for (const phase of ["download", "native-start"]) {
  test(`site fixture removes its ignored outer workspace after ${phase} failure`, async () => {
    let workspace;
    await assert.rejects(startDashboardSiteFixture({
      dataBackend: "fixture-invalid-backend",
      downloadData: async (destination) => {
        workspace = dirname(dirname(destination));
        assert.match(relative(join(process.cwd(), ".tmp"), workspace), /^cao-dashboard-e2e-[^/\\]+$/);
        await access(join(workspace, "site/index.html"));
        await assert.rejects(access(join(workspace, "site/test")), { code: "ENOENT" });
        if (phase === "download") throw new Error("fixture acquisition failure");
      },
    }), phase === "download" ? /fixture acquisition failure/ : /data-backend/);
    assert.ok(workspace, "failure must occur after the outer site copy is prepared");
    await assert.rejects(access(workspace), { code: "ENOENT" });
  });
}

test("site fixture keeps its ignored workspace until native close and cleans up idempotently", async () => {
  const preview = await startDashboardSiteFixture({
    dataBackend: "indexeddb",
    downloadData: async (destination) => {
      const database = new DatabaseSync(join(destination, "gh-aw-logs.sqlite"));
      try {
        database.exec(`CREATE TABLE __idb_records(database_name TEXT,store_name TEXT,record_key TEXT,value TEXT);
          INSERT INTO __idb_records VALUES('gh-aw-cao-dashboard-data','repositories','"acme/control"','{"id":"acme/control","repository":"acme/control","organization":"acme"}');`);
      } finally {
        database.close();
      }
      await writeFile(join(destination, "inventory-sources.json"), '{"schemaVersion":1}');
      await writeFile(join(destination, "payload-hashes.json"), JSON.stringify({
        "gh-aw-logs.sqlite": hash(await readFile(join(destination, "gh-aw-logs.sqlite"))),
      }));
    },
  });
  try {
    assert.match(relative(join(process.cwd(), ".tmp"), preview.workspace), /^cao-dashboard-e2e-[^/\\]+$/);
    assert.equal((await fetch(`${preview.url}/`)).status, 200);
    await access(join(preview.workspace, "site/index.html"));
    await preview.close();
    await preview.close();
    await assert.rejects(access(preview.workspace), { code: "ENOENT" });
  } finally {
    await preview.close();
  }
});

function payloadFetcher(payloads, manifest = Object.fromEntries(
  Object.entries(payloads).map(([name, content]) => [name, hash(content)]),
)) {
  return async (input) => {
    const name = new URL(input).pathname.replace(/^\/cao\//, "");
    if (name === "payload-hashes.json") return Response.json(manifest);
    return Object.hasOwn(payloads, name)
      ? new Response(payloads[name])
      : new Response(null, { status: 404 });
  };
}

test("downloads canonical deployed dashboard inputs", async () => {
  const destination = await temporaryDirectory();
  const requested = [];
  const fetcher = async (url) => {
    const requestUrl = String(url);
    requested.push(requestUrl);
    let content = '{"repositories":[]}';
    if (requestUrl.endsWith(".sqlite")) content = snapshot;
    if (requestUrl.endsWith(".jsonl")) content = '{"kind":"run"}\n';
    if (requestUrl.endsWith("payload-hashes.json")) {
      content = JSON.stringify({
        "gh-aw-logs.sqlite": hash(snapshot),
        "gh-aw-logs-runs/fixture.jsonl": hash('{"kind":"run"}\n'),
      });
    }
    if (requestUrl.endsWith("memory/manifest.json")) {
      content = '{"campaigns":[{"campaign":"ambient-context","files":[{"path":"notes.md"},{"path":"%2E%2E%2Fescape.md"}]}]}';
    }
    if (requestUrl.endsWith("memory/ambient-context/notes.md")) content = "# Memory\n";
    return {
      ok: true,
      body: new Blob([content]).stream(),
      text: async () => {
        throw new Error("response must be streamed");
      },
      json: async () => JSON.parse(content),
      arrayBuffer: async () => Buffer.from(content),
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/payload-hashes.json",
      fetcher,
    );

    assert.deepEqual(requested, [
      "https://example.test/cao/payload-hashes.json",
      "https://example.test/cao/inventory-sources.json",
      "https://example.test/cao/gh-aw-logs.sqlite",
      "https://example.test/cao/memory/manifest.json",
      "https://example.test/cao/memory/ambient-context/notes.md",
      "https://example.test/cao/gh-aw-logs-runs/fixture.jsonl",
    ]);
    assert.equal(await readFile(join(destination, "gh-aw-logs-runs", "fixture.jsonl"), "utf8"), '{"kind":"run"}\n');
    assert.equal(
      await readFile(join(destination, "inventory-sources.json"), "utf8"),
      '{"repositories":[]}',
    );
    assert.equal(await readFile(join(destination, "memory", "ambient-context", "notes.md"), "utf8"), "# Memory\n");
    assert.equal(await readFile(join(destination, "gh-aw-logs.sqlite"), "utf8"), snapshot);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("limits the downloaded activity shards when requested", async () => {
  const destination = await temporaryDirectory();
  const requested = [];
  const fetcher = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("memory/manifest.json")) return { ok: false, status: 404 };
    const content = String(url).endsWith("payload-hashes.json")
      ? JSON.stringify({
          "gh-aw-logs.sqlite": hash(snapshot),
          "gh-aw-logs-runs/first.jsonl": hash('{"kind":"record"}\n'),
          "gh-aw-logs-records/second.jsonl": hash('{"kind":"record"}\n'),
        })
      : String(url).endsWith("inventory-sources.json")
        ? '{"repositories":[]}'
        : String(url).endsWith(".sqlite") ? snapshot : '{"kind":"record"}\n';
    return {
      ok: true,
      body: new Blob([content]).stream(),
      json: async () => JSON.parse(content),
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/payload-hashes.json",
      fetcher,
      1,
    );

    assert.deepEqual(requested, [
      "https://example.test/cao/payload-hashes.json",
      "https://example.test/cao/inventory-sources.json",
      "https://example.test/cao/gh-aw-logs.sqlite",
      "https://example.test/cao/memory/manifest.json",
      "https://example.test/cao/gh-aw-logs-runs/first.jsonl",
    ]);
    const retained = JSON.parse(await readFile(join(destination, "payload-hashes.json"), "utf8"));
    assert.equal(retained["gh-aw-logs-records/second.jsonl"], undefined);
    assert.equal(retained["gh-aw-logs.sqlite"], hash(snapshot));
    for (const [name, expected] of Object.entries(retained)) {
      assert.equal(hash(await readFile(join(destination, name))), expected, name);
    }
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("waits for both deployed dashboard downloads when one fails", async () => {
  const destination = await temporaryDirectory();
  let inventoryFinished = false;
  const fetcher = async (url) => ({
    ok: true,
    body: String(url).endsWith("inventory-sources.json")
      ? new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(new TextEncoder().encode('{"repositories":[]}'));
            controller.close();
            inventoryFinished = true;
          },
        })
      : new ReadableStream({
          start(controller) {
            controller.error(new Error("activity download failed"));
          },
        }),
    json: async () => ({
      "gh-aw-logs.sqlite": hash(snapshot),
      "gh-aw-logs-runs/fixture.jsonl": hash('{"kind":"run"}\n'),
    }),
  });

  try {
    await assert.rejects(
      downloadDeployedDashboardData(
        destination,
        "https://example.test/cao/payload-hashes.json",
        fetcher,
      ),
      /activity download failed/,
    );
    assert.equal(inventoryFinished, true);
  } finally {
    await rm(destination, { recursive: true });
  }
});

test("converts predecessor compacted phase JSON to current JSONL", async () => {
  const destination = await temporaryDirectory();
  const legacyName = "gh-aw-logs-runs/legacy.json";
  const currentName = "gh-aw-logs-runs/legacy.jsonl";
  const legacy = JSON.stringify({
    schemaVersion: 13,
    ingestionVersion: 2,
    sourceRecords: 1,
    phase: "runs",
    batch: {
      campaigns: [],
      repositories: [{ id: "repository:acme%2Fcontrol" }],
      workflows: [],
      runs: [],
    },
  });

  test("verifies original SQLite, inventory and activity bytes before accepting a fixture", async (t) => {
    for (const name of ["gh-aw-logs.sqlite", "inventory-sources.json", "gh-aw-logs-runs/run.jsonl", "gh-aw-logs-runs/legacy.json"]) {
      await t.test(name, async () => {
        const destination = await temporaryDirectory();
        const payloads = {
          "gh-aw-logs.sqlite": snapshot,
          "inventory-sources.json": "{}",
          [name.endsWith(".json") && name.includes("legacy") ? name : "gh-aw-logs-runs/run.jsonl"]: "{}\n",
        };
        const manifest = Object.fromEntries(Object.entries(payloads).map(([file, content]) => [file, hash(content)]));
        payloads[name] = "altered";
        try {
          await assert.rejects(downloadDeployedDashboardData(
            destination, "https://example.test/cao/payload-hashes.json", payloadFetcher(payloads, manifest),
          ), /checksum mismatch/);
          await assert.rejects(readFile(join(destination, "payload-hashes.json")), { code: "ENOENT" });
        } finally {
          await rm(destination, { recursive: true, force: true });
        }
      });
    }
  });

  test("rejects missing SQLite digests and unsafe manifest entries before acquisition", async (t) => {
    for (const manifest of [
      { "gh-aw-logs-runs/run.jsonl": hash("{}\n") },
      { "gh-aw-logs.sqlite": hash(snapshot), "../escape.jsonl": hash("{}\n") },
      { "gh-aw-logs.sqlite": hash(snapshot), "gh-aw-logs-runs/%2e%2e.jsonl": hash("{}\n") },
      { "gh-aw-logs.sqlite": "not-a-sha256" },
    ]) {
      await t.test(JSON.stringify(manifest), async () => {
        const destination = await temporaryDirectory();
        try {
          await assert.rejects(downloadDeployedDashboardData(
            destination, "https://example.test/cao/payload-hashes.json",
            payloadFetcher({ "inventory-sources.json": "{}" }, manifest),
          ), /manifest/);
        } finally {
          await rm(destination, { recursive: true, force: true });
        }
      });
    }
  });

  test("downloaded shard subsets pass the unchanged production Go preparation boundary", async () => {
    const workspace = await temporaryDirectory();
    let preview;
    try {
      const database = new DatabaseSync(join(workspace, "canonical.sqlite"));
      try {
        database.exec(`CREATE TABLE __idb_records(database_name TEXT,store_name TEXT,record_key TEXT,value TEXT);
          INSERT INTO __idb_records VALUES('gh-aw-cao-dashboard-data','repositories','"acme/control"','{"id":"acme/control","repository":"acme/control","organization":"acme"}');`);
      } finally {
        database.close();
      }
      const payloads = {
        "gh-aw-logs.sqlite": await readFile(join(workspace, "canonical.sqlite")),
        "inventory-sources.json": '{"schemaVersion":1}',
        "gh-aw-logs-runs/first.jsonl": '{"kind":"metadata","phase":"runs","schemaVersion":13,"ingestionVersion":3,"records":0}\n',
        "gh-aw-logs-records/second.jsonl": '{"kind":"metadata","phase":"records","schemaVersion":13,"ingestionVersion":3,"records":0}\n',
      };
      const data = join(workspace, "data");
      await mkdir(data);
      await downloadDeployedDashboardData(data, "https://example.test/cao/payload-hashes.json", payloadFetcher(payloads), 1);
      preview = await startNativeDashboard({ workspace, data, dataBackend: "indexeddb" });
      const response = await fetch(`${preview.url}/payload-hashes.json`);
      assert.equal(response.status, 200);
      const manifest = await response.json();
      assert.equal(manifest["gh-aw-logs-records/second.jsonl"], undefined);
      assert.equal(manifest["gh-aw-logs.sqlite"], hash(payloads["gh-aw-logs.sqlite"]));
      assert.equal(hash(await readFile(join(data, "gh-aw-logs.sqlite"))), hash(payloads["gh-aw-logs.sqlite"]));
    } finally {
      try { await preview?.close(); }
      finally { await rm(workspace, { recursive: true, force: true }); }
    }
  });
  const fetcher = async (url) => {
    const value = String(url);
    if (value.endsWith("memory/manifest.json")) return { ok: false, status: 404 };
    const content = value.endsWith("payload-hashes.json")
      ? JSON.stringify({ "gh-aw-logs.sqlite": hash(snapshot), [legacyName]: hash(legacy) })
      : value.endsWith("inventory-sources.json")
        ? '{"repositories":[]}'
        : value.endsWith(".sqlite") ? snapshot : legacy;
    return {
      ok: true,
      body: new Blob([content]).stream(),
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
      json: async () => JSON.parse(content),
    };
  };

  try {
    await downloadDeployedDashboardData(
      destination,
      "https://example.test/cao/payload-hashes.json",
      fetcher,
    );
    const lines = (await readFile(join(destination, currentName), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], {
      kind: "metadata",
      schemaVersion: 13,
      ingestionVersion: 3,
      sourceRecords: 1,
      phase: "runs",
      records: 1,
    });
    assert.deepEqual(lines[1], {
      kind: "record",
      collection: "repositories",
      record: { id: "repository:acme%2Fcontrol" },
    });
    const retained = JSON.parse(await readFile(join(destination, "payload-hashes.json"), "utf8"));
    assert.equal(retained[legacyName], undefined);
    assert.equal(retained[currentName], hash(await readFile(join(destination, currentName))));
    assert.notEqual(retained[currentName], hash(legacy));
  } finally {
    await rm(destination, { recursive: true });
  }
});
