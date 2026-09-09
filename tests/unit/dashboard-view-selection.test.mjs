import assert from "node:assert/strict";
import { test } from "node:test";
import { changedDashboardPageIds, selectAffectedPageIds, sharedDashboardConfigurationChanged } from "../e2e/dashboard-view-selection.mjs";

const dashboard = {
  dashboard: {
    pages: [
      { id: "experiments", views: [{ element: "experiments-evaluation" }] },
      { id: "cost", views: [{ element: "summary-grid" }] },
    ],
  },
};

test("selects the page that uses a changed component", () => {
  assert.deepEqual(
    selectAffectedPageIds({
      dashboard,
      changedFiles: ["dashboard/site/src/components/experiments-evaluation.js"],
      baseRef: "unused",
    }),
    ["experiments"],
  );
});

test("selects every page for shared renderer changes", () => {
  assert.deepEqual(
    selectAffectedPageIds({
      dashboard,
      changedFiles: ["dashboard/site/src/presenter.js"],
      baseRef: "unused",
    }),
    ["experiments", "cost"],
  );
});

test("selects no pages for unrelated changes", () => {
  assert.deepEqual(
    selectAffectedPageIds({
      dashboard,
      changedFiles: ["docs/index.md"],
      baseRef: "unused",
    }),
    [],
  );
});

test("selects only changed and added dashboard pages", () => {
  assert.deepEqual(
    changedDashboardPageIds(
      {
        dashboard: {
          pages: [
            { id: "unchanged", title: "Same" },
            { id: "changed", title: "New" },
            { id: "added", title: "Added" },
          ],
        },
      },
      {
        dashboard: {
          pages: [
            { id: "unchanged", title: "Same" },
            { id: "changed", title: "Old" },
          ],
        },
      },
    ),
    ["changed", "added"],
  );
});

test("detects shared dashboard configuration changes", () => {
  assert.equal(
    sharedDashboardConfigurationChanged(
      {
        "language-version": "1",
        dashboard: { pages: [], defaults: { layout: "wide" } },
      },
      {
        "language-version": "1",
        dashboard: { pages: [], defaults: { layout: "full" } },
      },
    ),
    true,
  );
  assert.equal(
    sharedDashboardConfigurationChanged(
      { "language-version": "1", dashboard: { pages: [{ id: "new" }] } },
      { "language-version": "1", dashboard: { pages: [{ id: "old" }] } },
    ),
    false,
  );
});

test("selects every page for components with transitive consumers", () => {
  assert.deepEqual(
    selectAffectedPageIds({
      dashboard,
      changedFiles: ["dashboard/site/src/components/agent-marketplace-view.js"],
      baseRef: "unused",
    }),
    ["experiments", "cost"],
  );
});

test("selects every page when a referenced component was deleted", () => {
  assert.deepEqual(
    selectAffectedPageIds({
      dashboard: {
        dashboard: {
          pages: [
            {
              id: "deleted-consumer",
              views: [{ element: "deleted-component" }],
            },
            { id: "other", views: [] },
          ],
        },
      },
      changedFiles: ["dashboard/site/src/components/deleted-component.js"],
      baseRef: "unused",
    }),
    ["deleted-consumer", "other"],
  );
});
