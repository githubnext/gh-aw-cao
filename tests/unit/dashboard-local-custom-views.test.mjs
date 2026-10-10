import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLocalCustomViews, materializeLocalCustomView, saveLocalCustomView } from "../../dashboard/local-custom-views.mjs";
import { validateDashboardDocument } from "../../dashboard/site/src/validator.js";

const content = await readFile(new URL("../../dashboard/site/test/fixtures/query-editor.json", import.meta.url), "utf8");

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "cao-local-custom-views-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("custom views persist validated documents, deduplicate saves, and isolate references without changing labels", async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await loadLocalCustomViews(root), []);
  const saved = await saveLocalCustomView(root, content);
  assert.match(saved.path, /^\.cao\/dashboard\/custom-views\/local-[a-f0-9]{24}\.json$/);
  assert.deepEqual(await saveLocalCustomView(root, content), saved);
  assert.equal((await readdir(join(root, ".cao/dashboard/custom-views"))).length, 1);
  const restored = await loadLocalCustomViews(root);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].document, JSON.parse(content));
  const materialized = materializeLocalCustomView(restored[0].document, saved.id);
  assert.equal(materialized.dashboard.pages[0].id, saved.id);
  assert.equal(materialized.dashboard.queries[0].name, `${saved.id}-failure-counts`);
  assert.equal(materialized.dashboard.queries[0].from, "runs");
  assert.equal(materialized.dashboard.pages[0].views[0].data.source, `${saved.id}-failure-counts`);
  assert.equal(materialized.dashboard.pages[0].views[0].title, "Run conclusions");
  assert.equal(validateDashboardDocument(JSON.stringify(materialized)).ok, true);
});

test("saved view composition isolates dependent queries, filter sources, cards, units, and section references", async (t) => {
  const root = await workspace(t);
  const authored = JSON.parse(content);
  const dashboard = authored.dashboard;
  dashboard.units = { native: { name: "Native count", symbol: "runs", significant: 1, format: "number" } };
  dashboard["card-templates"] = [{
    id: "conclusion", icon: "workflow",
    title: { field: "run-conclusion" }, labels: [],
    details: [{ field: "runs", unit: "native" }]
  }];
  dashboard.queries.push({
    name: "display-counts", subject: "Native conclusion counts", from: "failure-counts", limit: 200,
    joins: [{
      source: "failure-counts", type: "left",
      on: [{ left: "run-conclusion", right: "run-conclusion" }],
      fields: [{ field: "runs", as: "joined-runs" }]
    }]
  });
  const page = dashboard.pages[0];
  page.views[0].data.source = "display-counts";
  page.views[0].encoding.y.unit = "native";
  const filters = {
    filters: [{
      id: "conclusions", label: "Conclusion",
      groups: [{ label: "Conclusions", field: "run-conclusion", source: "failure-counts", "value-field": "run-conclusion" }]
    }]
  };
  page.views.push({
    id: "cards", mark: "list", title: "Native conclusion cards",
    data: { source: "display-counts", limit: 200 },
    encoding: { columns: [{ field: "run-conclusion", type: "nominal" }, { field: "runs", type: "quantitative", unit: "native" }] },
    "filter-bar": filters,
    list: { style: "entity-cards", card: "conclusion", icon: "workflow" }
  });
  page.sections = [{ id: "results", title: "Results", layout: "full", views: ["failures", "cards"] }];
  const saved = await saveLocalCustomView(root, JSON.stringify(authored));
  const [restored] = await loadLocalCustomViews(root);
  const materialized = materializeLocalCustomView(restored.document, saved.id);
  const isolated = materialized.dashboard;
  assert.equal(validateDashboardDocument(JSON.stringify(materialized)).ok, true);
  assert.equal(isolated.queries[1].from, `${saved.id}-failure-counts`);
  assert.equal(isolated.queries[1].joins[0].source, `${saved.id}-failure-counts`);
  assert.equal(isolated.pages[0].views[1]["filter-bar"].filters[0].groups[0].source, `${saved.id}-failure-counts`);
  assert.equal(isolated.pages[0].views[0].encoding.y.unit, `${saved.id}-native`);
  assert.equal(isolated.pages[0].views[1].list.card, `${saved.id}-conclusion`);
  assert.equal(isolated["card-templates"][0].details[0].unit, `${saved.id}-native`);
  assert.ok(isolated.units[`${saved.id}-native`]);
  assert.deepEqual(isolated.pages[0].sections[0].views, [`${saved.id}-failures`, `${saved.id}-cards`]);
  assert.equal(isolated.pages[0].views[0].encoding.y.field, "runs");
});

test("simultaneous identical saves expose only one complete document", async (t) => {
  const root = await workspace(t);
  const saved = await Promise.all(Array.from({ length: 8 }, () => saveLocalCustomView(root, content)));
  assert.ok(saved.every(({ id }) => id === saved[0].id));
  assert.equal((await loadLocalCustomViews(root)).length, 1);
  assert.deepEqual(await readdir(join(root, ".cao/dashboard/custom-views")), [`${saved[0].id}.json`]);
});

test("custom view storage fails closed on invalid drafts, corrupt files, and symlinked directories", async (t) => {
  const root = await workspace(t);
  await assert.rejects(saveLocalCustomView(root, "[invalid"));
  assert.deepEqual(await loadLocalCustomViews(root), []);
  const saved = await saveLocalCustomView(root, content);
  const changed = JSON.parse(content);
  changed.dashboard.title = "Different accepted view";
  await writeFile(join(root, saved.path), JSON.stringify(changed));
  await assert.rejects(loadLocalCustomViews(root), /identity does not match/);
  await assert.rejects(saveLocalCustomView(root, content), /identity does not match/);
  await writeFile(join(root, saved.path), "[invalid");
  await assert.rejects(loadLocalCustomViews(root));
  const linked = await workspace(t);
  const outside = await workspace(t);
  await mkdir(join(outside, "dashboard"));
  await symlink(outside, join(linked, ".cao"), "dir");
  await assert.rejects(saveLocalCustomView(linked, content), /not symlinks/);
  assert.deepEqual(await readdir(join(outside, "dashboard")), []);
});
