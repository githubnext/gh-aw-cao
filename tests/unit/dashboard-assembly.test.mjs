import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assembleDashboardDocument,
  dashboardSourcePaths,
  loadDashboardDocument,
} from "../../dashboard/report/assemble-dashboard.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-assembly-"));
  await Promise.all(Object.entries(files).map(([name, value]) => (
    writeFile(path.join(root, name), `${JSON.stringify(value)}\n`)
  )));
  return root;
}

test("assembles ordered dashboard fragments recursively", async () => {
  const root = await fixture({
    "dashboard.sources.json": { version: 1, files: ["metadata.json", "queries.json", "pages.json"] },
    "metadata.json": {
      "language-version": "0.1.0",
      dashboard: { id: "assembled", title: "Assembled", pages: [] },
    },
    "queries.json": { dashboard: { queries: [{ name: "all-runs", source: "runs" }] } },
    "pages.json": { dashboard: { pages: [{ id: "overview", kind: "custom", views: [] }] } },
  });

  try {
    const assembled = await assembleDashboardDocument(path.join(root, "dashboard.sources.json"));
    assert.equal(assembled.dashboard.id, "assembled");
    assert.deepEqual(assembled.dashboard.queries, [{ name: "all-runs", source: "runs" }]);
    assert.deepEqual(assembled.dashboard.pages, [{ id: "overview", kind: "custom", views: [] }]);
    assert.deepEqual(
      await dashboardSourcePaths(path.join(root, "dashboard.sources.json")),
      ["metadata.json", "queries.json", "pages.json"].map((name) => path.join(root, name)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers dashboard sources and falls back to dashboard.json", async () => {
  const root = await fixture({
    "dashboard.json": { "language-version": "0.1.0", dashboard: { id: "fallback" } },
  });

  try {
    assert.equal((await loadDashboardDocument(path.join(root, "dashboard.json"))).dashboard.id, "fallback");
    await writeFile(
      path.join(root, "dashboard.sources.json"),
      JSON.stringify({ version: 1, files: ["dashboard.json", "addition.json"] }),
    );
    await writeFile(path.join(root, "addition.json"), JSON.stringify({ dashboard: { title: "Assembled" } }));
    assert.equal((await loadDashboardDocument(path.join(root, "dashboard.json"))).dashboard.title, "Assembled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects conflicting fields and unsafe source paths", async () => {
  const root = await fixture({
    "dashboard.sources.json": { version: 1, files: ["first.json", "second.json"] },
    "first.json": { dashboard: { title: "First" } },
    "second.json": { dashboard: { title: "Second" } },
  });

  test("fails closed when an assembled source is missing or contains a prototype key", async () => {
    const root = await fixture({
      "dashboard.json": { "language-version": "0.1.0", dashboard: { id: "must-not-fallback" } },
      "dashboard.sources.json": { version: 1, files: ["missing.json"] },
    });

    try {
      await assert.rejects(
        loadDashboardDocument(path.join(root, "dashboard.json")),
        (error) => error?.code === "ENOENT",
      );
      await writeFile(
        path.join(root, "unsafe.json"),
        '{"dashboard":{"__proto__":{"polluted":true}}}\n',
      );
      await writeFile(
        path.join(root, "dashboard.sources.json"),
        JSON.stringify({ version: 1, files: ["unsafe.json"] }),
      );
      await assert.rejects(
        assembleDashboardDocument(path.join(root, "dashboard.sources.json")),
        /contains an unsupported key at \$\.dashboard\.__proto__/,
      );
      assert.equal(Object.prototype.polluted, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid and duplicate source declarations", async () => {
    const root = await fixture({
      "dashboard.sources.json": { version: 1, files: [] },
      "fragment.json": {},
    });

    try {
      await assert.rejects(
        dashboardSourcePaths(path.join(root, "dashboard.sources.json")),
        /must declare version 1 and a non-empty files array/,
      );
      await writeFile(
        path.join(root, "dashboard.sources.json"),
        JSON.stringify({ version: 1, files: ["fragment.json", "fragment.json"] }),
      );
      await assert.rejects(
        dashboardSourcePaths(path.join(root, "dashboard.sources.json")),
        /contains a duplicate dashboard source/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  try {
    await assert.rejects(
      assembleDashboardDocument(path.join(root, "dashboard.sources.json")),
      /conflicts with an earlier dashboard source at \$\.dashboard\.title/,
    );
    await writeFile(
      path.join(root, "dashboard.sources.json"),
      JSON.stringify({ version: 1, files: ["../outside.json"] }),
    );
    await assert.rejects(
      dashboardSourcePaths(path.join(root, "dashboard.sources.json")),
      /invalid dashboard source path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
