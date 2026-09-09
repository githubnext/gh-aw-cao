import assert from "node:assert/strict";
import test from "node:test";
import { previousIndexCanRetainRuns, previousIndexIsReusable, previousRunRecords } from "../../activity/run-health-snapshot.mjs";

const context = {
  organization: "githubnext",
  repositoryScope: "allowlist",
  includePrivate: false,
  runWindowHours: 168,
  allowedRepositories: ["githubnext/gh-aw-cao"],
};

function previousIndex(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T12:00:00Z",
    organization: "githubnext",
    repositoryScope: "allowlist",
    allowedRepositories: ["githubnext/gh-aw-cao"],
    includePrivate: false,
    runHealth: {
      available: true,
      complete: false,
      windowHours: 168,
      windowStart: "2026-08-28T12:00:00Z",
    },
    workflows: [],
    ...overrides,
  };
}

test("partial run snapshots are retained without enabling incremental refresh", () => {
  const snapshot = previousIndex();
  const windowStart = new Date("2026-08-28T13:00:00Z");

  assert.equal(previousIndexCanRetainRuns(snapshot, windowStart, context), true);
  assert.equal(previousIndexIsReusable(snapshot, windowStart, context), false);
  assert.equal(
    previousIndexIsReusable(
      previousIndex({
        runHealth: { ...snapshot.runHealth, complete: true },
      }),
      windowStart,
      context,
    ),
    true,
  );
});

test("retained run records stay bounded and require a current workflow registration", () => {
  const snapshot = previousIndex({
    workflows: [
      {
        repository: "githubnext/gh-aw-cao",
        id: 17,
        runHealth: {
          runRecords: [
            { runId: 101, createdAt: "2026-09-04T11:00:00Z" },
            { runId: 100, createdAt: "2026-08-27T11:00:00Z" },
          ],
        },
      },
      {
        repository: "githubnext/gh-aw-cao",
        id: 18,
        runHealth: {
          runRecords: [{ runId: 99, createdAt: "2026-09-04T10:00:00Z" }],
        },
      },
    ],
  });
  const registry = new Map([["githubnext/gh-aw-cao", new Map([["workflow", { id: 17 }]])]]);

  assert.deepEqual([...previousRunRecords(snapshot, registry, new Date("2026-08-28T13:00:00Z")).keys()], ["17:101"]);
});

test("run snapshots from a different collection scope are not retained", () => {
  const snapshot = previousIndex({ allowedRepositories: ["github/other"] });

  assert.equal(previousIndexCanRetainRuns(snapshot, new Date("2026-08-28T13:00:00Z"), context), false);
  assert.equal(
    previousIndexCanRetainRuns(previousIndex({ allowedRepositories: undefined }), new Date("2026-08-28T13:00:00Z"), {
      ...context,
      allowedRepositories: undefined,
    }),
    true,
  );
});
