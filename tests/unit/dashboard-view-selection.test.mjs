import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedDashboardPageIds,
  maximumSelectedDashboardPageCount,
  rankDashboardPageIds,
  selectAffectedPageIds,
  sharedDashboardConfigurationChanged,
} from "../e2e/dashboard-view-selection.mjs";

const dashboard = {
  dashboard: {
    pages: [
      { id: "experiments", views: [{ mark: "table" }] },
      { id: "cost", views: [{ element: "link-button-list" }] },
    ],
  },
};

test("selects the page that uses a changed component", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard,
    changedFiles: ["dashboard/site/src/components/link-button-list.js"],
    baseRef: "unused",
  }), ["cost"]);
});

test("selects every page for shared renderer changes", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard,
    changedFiles: ["dashboard/site/src/presenter.js"],
    baseRef: "unused",
  }), ["experiments", "cost"]);
});

test("selects every page for dashboard assessment data changes", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard,
    changedFiles: ["tests/e2e/dashboard-view-data.mjs"],
    baseRef: "unused",
  }), ["experiments", "cost"]);
});

test("selects no pages for unrelated changes", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard,
    changedFiles: ["docs/index.md"],
    baseRef: "unused",
  }), []);
});

test("selects only changed and added dashboard pages", () => {
  assert.deepEqual(changedDashboardPageIds(
    { dashboard: { pages: [
      { id: "unchanged", title: "Same" },
      { id: "changed", title: "New" },
      { id: "added", title: "Added" },
    ] } },
    { dashboard: { pages: [
      { id: "unchanged", title: "Same" },
      { id: "changed", title: "Old" },
    ] } },
  ), ["changed", "added"]);
});

test("detects shared dashboard configuration changes", () => {
  assert.equal(sharedDashboardConfigurationChanged(
    { "language-version": "1", dashboard: { pages: [], defaults: { layout: "wide" } } },
    { "language-version": "1", dashboard: { pages: [], defaults: { layout: "full" } } },
  ), true);
  assert.equal(sharedDashboardConfigurationChanged(
    { "language-version": "1", dashboard: { pages: [{ id: "new" }] } },
    { "language-version": "1", dashboard: { pages: [{ id: "old" }] } },
  ), false);
});

test("selects every page for components with transitive consumers", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard,
    changedFiles: ["dashboard/site/src/components/agent-marketplace-view.js"],
    baseRef: "unused",
  }), ["experiments", "cost"]);
});

test("selects every page when a referenced component was deleted", () => {
  assert.deepEqual(selectAffectedPageIds({
    dashboard: {
      dashboard: {
        pages: [
          { id: "deleted-consumer", views: [{ element: "deleted-component" }] },
          { id: "other", views: [] },
        ],
      },
    },
    changedFiles: ["dashboard/site/src/components/deleted-component.js"],
    baseRef: "unused",
  }), ["deleted-consumer", "other"]);
});

test("never selects ignored dashboard pages", () => {
  const dashboardWithIgnoredPages = {
    dashboard: {
      pages: [
        { id: "operations", views: [{ element: "link-button-list" }] },
        { id: "readiness", views: [{ mark: "table" }] },
        { id: "cost", views: [{ mark: "table" }] },
      ],
    },
  };
  assert.deepEqual(selectAffectedPageIds({
    dashboard: dashboardWithIgnoredPages,
    changedFiles: ["dashboard/site/src/presenter.js"],
    baseRef: "unused",
  }), ["cost"]);
  assert.deepEqual(selectAffectedPageIds({
    dashboard: dashboardWithIgnoredPages,
    changedFiles: ["dashboard/site/src/components/link-button-list.js"],
    baseRef: "unused",
  }), []);
});

test("ranks and caps broad dashboard changes to five likely pages", () => {
  const broadDashboard = {
    dashboard: {
      pages: [
        { id: "overview", title: "Overview", views: [] },
        { id: "cost", title: "Cost", views: [] },
        { id: "campaigns", title: "Campaigns", views: [] },
        { id: "repositories", title: "Repositories", views: [] },
        { id: "workflow-runtime", title: "Workflow runtime", views: [] },
        {
          id: "operational-value",
          title: "Operational Value",
          views: [{ source: "operational-value-history" }],
        },
      ],
    },
  };
  const selected = selectAffectedPageIds({
    dashboard: broadDashboard,
    changedFiles: ["dashboard/site/src/components/measure-history.js"],
    baseRef: "unused",
  });
  assert.equal(selected.length, maximumSelectedDashboardPageCount);
  assert.equal(selected[0], "operational-value");
  assert.deepEqual(selected, [
    "operational-value",
    "overview",
    "cost",
    "campaigns",
    "repositories",
  ]);
});

test("ranks page ids by changed file terms while preserving dashboard order ties", () => {
  const rankedDashboard = {
    dashboard: {
      pages: [
        { id: "overview", title: "Overview", views: [] },
        { id: "cost", title: "Cost", views: [] },
        { id: "operational-value", title: "Operational Value", views: [] },
        { id: "workflow-runtime", title: "Workflow runtime", views: [] },
        { id: "repositories", title: "Repositories", views: [] },
        { id: "campaigns", title: "Campaigns", views: [] },
      ],
    },
  };
  const pageIds = [
    "overview",
    "cost",
    "operational-value",
    "workflow-runtime",
    "repositories",
    "campaigns",
  ];
  assert.deepEqual(rankDashboardPageIds({
    dashboard: rankedDashboard,
    pageIds,
    changedFiles: [
      "dashboard/site/src/data/queries/operational-value.js",
      "dashboard/site/src/components/workflow-runtime.js",
    ],
  }), [
    "operational-value",
    "workflow-runtime",
    "overview",
    "cost",
    "repositories",
  ]);
  assert.deepEqual(rankDashboardPageIds({
    dashboard: rankedDashboard,
    pageIds,
    changedFiles: [
      "dashboard/site/src/data/queries/operational-value.js",
      "dashboard/site/src/components/workflow-runtime.js",
    ],
    limit: 2,
  }), ["operational-value", "workflow-runtime"]);
  assert.deepEqual(rankDashboardPageIds({
    dashboard: rankedDashboard,
    pageIds: [
      "overview",
      "cost",
      "operational-value",
      "workflow-runtime",
      "repositories",
      "campaigns",
    ],
    changedFiles: ["unrelated/no-match.txt"],
  }), [
    "overview",
    "cost",
    "operational-value",
    "workflow-runtime",
    "repositories",
  ]);
});
