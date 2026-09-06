import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("generate-dashboard-ir corpus is indexed and valid", () => {
  execFileSync("npm", ["--prefix", "dashboard/site", "run", "validate:corpus"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
});

test("every production dashboard page starts with an executive summary or prescribed attention view", () => {
  const executiveSummaryCharts = new Set(["pie", "line", "dot", "histogram", "scatter", "swimlane"]);
  const dashboardFiles = [
    join(root, "dashboard/site/dashboard.json"),
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name, "dashboard.json"))
      .filter((path) => existsSync(path)),
  ];

  for (const path of dashboardFiles) {
    const document = JSON.parse(readFileSync(path, "utf8"));
    for (const page of document.dashboard.pages) {
      const views = page.kind === "built-in" ? page.definition?.views : page.views;
      const summary = views?.[0];
      assert.ok(summary, `${path}: page "${page.id}" must contain a view`);
      const isSummaryTable = summary.mark === "table"
        && summary.encoding?.columns?.some((column) => typeof column.aggregate === "string");
      const isSummaryGrid = summary.mark === "element" && summary.element === "summary-grid";
      const isExperimentsEvaluation = page.id === "experiments"
        && summary.mark === "element"
        && summary.element === "experiments-evaluation";
      const isConfigurationPolicy = page.id === "configuration"
        && summary.mark === "element"
        && summary.element === "configuration-policy";
      const isAgentsMarketplace = page.id === "agents"
        && summary.mark === "element"
        && summary.element === "agent-marketplace-view";
      const isAttentionFirstHome = page.id === "home"
        && page["class-name"] === "dashboard-next-home-page"
        && summary.id === "home-attention"
        && summary.mark === "element"
        && summary.element === "signal-list"
        && summary.data?.sources?.includes("attention-signals");
      if (isAttentionFirstHome) {
        assert.deepEqual(
          views.map((view) => view.id),
          ["home-attention", "home-work", "home-outcomes", "home-operational-pulse"],
          `${path}: page "home" must preserve its prescribed attention-first region order`,
        );
      }
      assert.ok(
        (summary.mark === "chart" && executiveSummaryCharts.has(summary.chart))
          || isSummaryTable
          || isSummaryGrid
          || isExperimentsEvaluation
          || isConfigurationPolicy
          || isAgentsMarketplace
          || isAttentionFirstHome,
        `${path}: page "${page.id}" must start with an executive summary or its prescribed attention view`,
      );
    }
  }
});
