import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { gradeDashboardDocument, gradeDashboardView } from "../../dashboard/grader/view-grader.mjs";

const executeFile = promisify(execFile);

test("grades a dashboard view with interpretable normalized metrics", () => {
  const result = gradeDashboardView(
    {
      id: "run-health",
      title: "Run health",
      description: "Daily outcomes identify changes requiring attention.",
      data: { source: "runs" },
      mark: "chart",
      chart: "line",
      layout: "full",
      encoding: {
        x: { field: "day", type: "temporal" },
        y: { field: "run", type: "quantitative" },
        color: { field: "conclusion", type: "nominal" },
      },
    },
    {
      sources: {
        runs: {
          rows: [
            { day: "2026-09-01", run: 1, conclusion: "success" },
            { day: "2026-09-02", run: 1, conclusion: "failure" },
          ],
          metadata: { completeness: "complete", freshness: "fresh" },
        },
      },
      screenshots: [{ width: 1280, height: 720, clipped: false, overlap: false }],
    },
  );

  assert.equal(result.view, "run-health");
  assert.equal(result.scores.clarity, 1);
  assert.equal(result.scores.legibility, 1);
  assert.equal(result.observations.categorical.entropy, 1);
  assert.ok(result.overall >= 80 && result.overall <= 100);
  assert.deepEqual(result.findings, []);
});

test("returns only focused low-effort findings for observable problems", () => {
  const result = gradeDashboardView(
    {
      id: "busy",
      data: { source: "runs" },
      mark: "table",
      layout: "half",
      encoding: {
        columns: Array.from({ length: 12 }, (_, index) => ({
          field: `field-${index}`,
        })),
      },
    },
    {
      sources: { runs: { rows: [{ state: "success" }] } },
      screenshots: [{ width: 390, height: 844, clipped: true, overlap: false }],
    },
  );

  assert.deepEqual(
    result.findings.map(({ metric }) => metric),
    ["clarity", "legibility", "cognitive-economy", "clarity"],
  );
  assert.match(result.findings.find(({ metric }) => metric === "cognitive-economy").action, /existing detail disclosure|least useful field/);
  assert.doesNotMatch(JSON.stringify(result.findings), /redesign|new page|replace the view/i);
});

test("grades a document and the CLI writes the same report shape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-view-grader-"));
  const dashboardPath = path.join(root, "dashboard.json");
  const sourcesPath = path.join(root, "sources.json");
  const outputPath = path.join(root, "report.json");
  const document = {
    dashboard: {
      pages: [
        {
          id: "overview",
          kind: "custom",
          views: [
            {
              id: "summary",
              title: "Summary",
              description: "Current state.",
              data: { source: "summary" },
              mark: "metric",
              encoding: { value: { field: "value", type: "quantitative" } },
            },
          ],
        },
      ],
    },
  };
  try {
    await Promise.all([writeFile(dashboardPath, JSON.stringify(document)), writeFile(sourcesPath, JSON.stringify({ summary: { rows: [{ value: 2 }] } }))]);
    await executeFile(process.execPath, ["dashboard/grader/view-grader.mjs", "--dashboard", dashboardPath, "--sources", sourcesPath, "--output", outputPath], {
      cwd: path.resolve("."),
    });
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.summary.views, 1);
    assert.equal(report.views[0].view, "summary");
    assert.equal(report.methodology.references.length, 5);
    assert.deepEqual(Object.keys(gradeDashboardDocument(document).summary), ["views", "average", "findings", "highPriorityFindings"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed inputs", () => {
  assert.throws(() => gradeDashboardView(null), /view must be an object/);
  assert.throws(() => gradeDashboardDocument({}), /dashboard\.pages must be an array/);
});
