import assert from "node:assert/strict";
import test from "node:test";
import { compilerVersionOverrides, refreshCanonicalCompilerRelease, refreshDashboardCompilerVersions } from "../../dashboard/local-release-metadata.mjs";

const workflow = (name, version = "v0.91.5") => ({
  organization: "octo", repository: "repo", workflow: name,
  "gh-aw-version": version, "gh-aw-current-version": "v0.92.0",
  "gh-aw-update-state": "update-available",
});

test("canonical shards cannot overwrite live inventory compiler evidence", () => {
  const versions = compilerVersionOverrides({ workflows: { rows: [{
    ...workflow(".github/workflows/first.md", "v0.92.0"),
    "gh-aw-update-state": "up-to-date",
  }] } });
  const shard = {
    kind: "record", collection: "workflows",
    record: {
      id: "workflow:first", repositoryId: "repository:octo%2Frepo",
      path: ".github/workflows/first.lock.yml", ghAwVersion: "v0.91.5",
      ghAwUpdateState: "update-available",
    },
  };
  const refreshed = refreshCanonicalCompilerRelease(shard, "v0.92.0", versions);
  assert.equal(refreshed.record.ghAwVersion, "v0.92.0");
  assert.equal(refreshed.record.ghAwUpdateState, "up-to-date");
  assert.equal(shard.record.ghAwVersion, "v0.91.5");
  const placeholder = refreshCanonicalCompilerRelease({
    kind: "record", collection: "workflows", record: { name: "Historical workflow" },
  }, "v0.92.0", versions);
  assert.equal(Object.hasOwn(placeholder.record, "ghAwUpdateState"), false);
});

test("compiler overrides match short and full source and lock paths without crossing repositories", () => {
  const paths = ["first.md", "first.lock.yml", ".github/workflows/first.md", ".github/workflows/first.lock.yml"];
  for (const inventoryPath of paths) {
    for (const path of paths) {
      for (const state of ["up-to-date", "unknown"]) {
        const versions = compilerVersionOverrides({ workflows: { rows: [{
          ...workflow(inventoryPath, "v0.92.0"), "gh-aw-update-state": state,
        }] } });
        const shard = {
          kind: "record", collection: "workflows",
          record: { repositoryId: "repository:octo%2Frepo", path, ghAwVersion: "v0.91.5" },
        };
        const refreshed = refreshCanonicalCompilerRelease(shard, "v0.92.0", versions);
        assert.equal(refreshed.record.ghAwVersion, "v0.92.0", `${inventoryPath} matches ${path}`);
        assert.equal(refreshed.record.ghAwUpdateState, state);
        const otherRepository = refreshCanonicalCompilerRelease({
          ...shard, record: { ...shard.record, repositoryId: "repository:octo%2Fother" },
        }, "v0.92.0", versions);
        assert.equal(otherRepository.record.ghAwVersion, "v0.91.5");
        assert.equal(otherRepository.record.ghAwUpdateState, "update-available");
      }
    }
  }
});

test("live compiler metadata replaces snapshot versions only for retained workflow coordinates", async () => {
  const sources = { workflows: {
    metadata: { "as-of": "2026-10-01T00:00:00Z" },
    rows: [workflow("first.md"), workflow(".github/workflows/first.lock.yml"), workflow("ci.yml")],
  } };
  const paths = [];
  const refreshed = await refreshDashboardCompilerVersions(sources, {
    request: async (path) => {
      paths.push(path);
      return { status: 200, body: { gh_aw_version: "v0.92.0" } };
    },
    output: () => assert.fail("No diagnostic expected."),
  });
  assert.deepEqual(paths, ["/api/v1/github/repos/octo/repo/contents/.github/workflows/first.lock.yml"]);
  assert.deepEqual(refreshed.workflows.rows.slice(0, 2).map((row) => row["gh-aw-version"]), ["v0.92.0", "v0.92.0"]);
  assert.deepEqual(refreshed.workflows.rows.slice(0, 2).map((row) => row["gh-aw-update-state"]), ["up-to-date", "up-to-date"]);
  assert.equal(refreshed.workflows.rows[2], sources.workflows.rows[2]);
  assert.equal(refreshed.workflows.metadata, sources.workflows.metadata);
  assert.equal(sources.workflows.rows[0]["gh-aw-version"], "v0.91.5");
});

test("unavailable or stale compiler reads keep snapshot evidence but never establish current status", async () => {
  for (const response of [
    { status: 404 },
    { status: 503 },
    { status: 200, body: { gh_aw_version: "invalid" } },
    { status: 200, headers: { Warning: '110 - "Response is stale"' }, body: { gh_aw_version: "v0.92.0" } },
  ]) {
    const diagnostics = [];
    const refreshed = await refreshDashboardCompilerVersions({ workflows: { rows: [workflow("first.md", "v0.92.0")] } }, {
      request: async () => response,
      output: (...values) => diagnostics.push(values),
    });
    assert.equal(refreshed.workflows.rows[0]["gh-aw-version"], "v0.92.0");
    assert.equal(refreshed.workflows.rows[0]["gh-aw-update-state"], "unknown");
    assert.equal(diagnostics.length, 1);
  }
});

test("live compiler reads preserve unknown release state and reject untrusted workflow coordinates", async () => {
  let reads = 0;
  const sources = { workflows: { rows: [
    { ...workflow("first.md"), "gh-aw-current-version": "unknown" },
    workflow("../secret.md"), workflow("bad/name.md"),
    { ...workflow("second.md"), repository: ".." },
    { ...workflow("second.md"), organization: "bad/owner" },
  ] } };
  const refreshed = await refreshDashboardCompilerVersions(sources, {
    request: async () => { reads++; return { status: 200, body: { gh_aw_version: "v0.92.0" } }; },
    output: () => assert.fail("No diagnostic expected."),
  });
  assert.equal(reads, 1);
  assert.equal(refreshed.workflows.rows[0]["gh-aw-update-state"], "unknown");
  assert.deepEqual(refreshed.workflows.rows.slice(1), sources.workflows.rows.slice(1));
});

test("live compiler reads are bounded and leave excess workflows explicitly unknown", async () => {
  let reads = 0;
  let active = 0;
  let maximumActive = 0;
  const diagnostics = [];
  const refreshed = await refreshDashboardCompilerVersions({
    workflows: { rows: Array.from({ length: 130 }, (_, index) => workflow(`workflow-${index}.md`)) },
  }, {
    request: async () => {
      reads++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return { status: 200, body: { gh_aw_version: "v0.92.0" } };
    },
    output: (...values) => diagnostics.push(values),
  });
  assert.equal(reads, 128);
  assert.equal(maximumActive, 8);
  assert.deepEqual(refreshed.workflows.rows.slice(128).map((row) => row["gh-aw-update-state"]), ["unknown", "unknown"]);
  assert.equal(diagnostics.length, 1);
});
