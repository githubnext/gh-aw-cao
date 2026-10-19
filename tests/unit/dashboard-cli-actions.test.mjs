import assert from "node:assert/strict";
import test from "node:test";
import { composeDashboardDocuments } from "../../dashboard/report/compose-dashboard-documents.mjs";

// Native parsing, execution, credentials and terminal contracts live in server/internal/localops/*_test.go.
test("Actions dashboard composition merges CLI declarations and rejects duplicate ids", () => {
  const dashboard = (id, actionId) => ({
    "language-version": "0.1.0",
    dashboard: {
      id,
      title: id,
      pages: [{ id: `${id}-page`, kind: "custom", views: [] }],
      "cli-actions": [{ id: actionId, label: actionId, icon: "play", command: "gh aw compile" }],
    },
  });
  const composed = composeDashboardDocuments(dashboard("primary", "compile"), [dashboard("campaign", "upgrade")]);
  assert.deepEqual(composed.dashboard["cli-actions"].map(({ id }) => id), ["compile", "upgrade"]);
  assert.throws(() => composeDashboardDocuments(dashboard("primary", "compile"), [dashboard("campaign", "compile")]),
    /duplicate dashboard CLI action id/);
});
