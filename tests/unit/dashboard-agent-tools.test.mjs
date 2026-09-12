import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  executeDashboardQueryRequest,
  readDashboardDataSpecification,
} from "../../com.github.copilot/extensions/cao-dashboard/dashboard-agent-tools.mjs";

const workingDirectory = fileURLToPath(new URL("../../", import.meta.url));

test("dashboard agent tool executes the canonical query engine", async () => {
  const output = JSON.parse(
    await executeDashboardQueryRequest({
      workingDirectory,
      queries: [
        {
          name: "failed-runs",
          from: "runs",
          filter: {
            predicates: [{ field: "conclusion", equals: "failure" }],
          },
          select: [{ field: "repository" }, { field: "conclusion" }],
          "order-by": [{ field: "repository", direction: "asc" }],
        },
      ],
      sources: {
        runs: [
          { repository: "zeta", conclusion: "success" },
          { repository: "beta", conclusion: "failure" },
          { repository: "alpha", conclusion: "failure" },
        ],
      },
      requested: ["failed-runs"],
    }),
  );

  assert.deepEqual(output["failed-runs"].rows, [
    { repository: "alpha", conclusion: "failure" },
    { repository: "beta", conclusion: "failure" },
  ]);
  assert.equal(output["failed-runs"].metadata.availability, "available");
});

test("dashboard agent tool reads bounded specification ranges", async () => {
  const output = JSON.parse(
    await readDashboardDataSpecification({
      workingDirectory,
      startLine: 1,
      endLine: 5,
    }),
  );

  assert.equal(output.startLine, 1);
  assert.equal(output.endLine, 5);
  assert.ok(output.totalLines > 5);
  assert.match(output.content, /1: ---/);
  assert.match(output.path, /specs\/dashboard-data\.md$/);
});

test("dashboard agent tool rejects oversized specification ranges", async () => {
  await assert.rejects(
    readDashboardDataSpecification({
      workingDirectory,
      startLine: 1,
      endLine: 401,
    }),
    /limited to 400 lines/,
  );
});
