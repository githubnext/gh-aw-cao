import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveOverviewSources } from "../../src/overview-data.js";

describe("live Dashboard Language sources", () => {
  it("loads generated sources progressively and requires an explicit fixture opt-in", () => {
    const preview = readFileSync(resolve("index.html"), "utf8");

    expect(preview.indexOf('fetch("./dashboard.json", { cache: "no-store" })')).toBeLessThan(preview.indexOf("await loadCanonicalDashboardSources("));
    expect(preview.indexOf("startLoadingProgress(document)")).toBeLessThan(preview.indexOf('fetch("./dashboard.json", { cache: "no-store" })'));
    expect(preview).toContain('renderSources({}, "loading")');
    expect(preview).toContain("dashboard-loading-skeleton");
    expect(preview).not.toContain("Loading dashboard data…");
    expect(preview).toContain("startLoadingProgress(document)");
    expect(preview).toContain("loadingProgress.complete()");
    expect(preview).toContain('import { loadCanonicalDashboardPage, loadCanonicalDashboardSources } from "./src/data-processor.js"');
    expect(preview).toMatch(/await loadCanonicalDashboardSources\(\s*sourceUrl,\s*dashboardPageSourceNames\(dashboardDocument, initialPageId\),\s*dashboardContext/);
    expect(preview).not.toContain("loadDashboardSources(fetch, sourceUrl)");
    expect(preview).not.toContain("ingestDashboardSources(window.indexedDB, sources");
    expect(preview).not.toContain('./src/source-cache.js');
    expect(preview).not.toContain('Showing cached data.');
    expect(preview).toContain('loadCanonicalViewSources(window.indexedDB, sources, {');
    expect(preview).toContain('storage: navigator.storage');
    expect(preview).toContain('has("fixtures")');
    expect(preview).toContain("Unable to load live dashboard data:");
    expect(preview).toContain('window.addEventListener("dashboard-preview-update"');
    expect(preview).toContain('renderSources(renderedSources, "ready", renderedSourcesPrepared, renderedPageSourceLoader)');
    expect(preview).toContain('event: "preview.rendered"');
    expect(preview).toContain('get("local-preview")');
    expect(preview).toMatch(/previewMode\s*\?\s*await fetch\("\.\/viewer\.json"\)/);
    expect(preview).toContain('viewer: localViewer');
    expect(preview).toContain('new URL("./__dashboard_socket", window.location.href)');
    expect(preview).toContain('previewMode === "copilot"');
    expect(preview).toContain('await import("./src/copilot-prompt.js")');
    expect(preview).toContain('copilotPrompt = renderCopilotPrompt(dashboardSocket)');
    expect(preview).toContain('dashboard.classList.add("dashboard-copilot-enabled")');
    expect(preview).toContain('octicon(open ? "chevron-down" : "chevron-up")');
    expect(preview).toContain('panel.prepend(toggleButton)');
    expect(preview).toContain('sidebar?.append(toggleButton)');
    expect(preview).toContain('dashboard.append(panel)');
    expect(preview).not.toContain('dashboard.querySelector(".org-sidebar")?.append(copilotPrompt)');
    expect(preview).not.toContain("Retain the illustrative fixture data");
  });

  it("maps the operations report inputs into canonical logical sources", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "dashboard-language-sources-"));
    const inputs = {
      deployed: {
        generatedAt: "2026-08-30T12:00:00Z",
        discovery: { complete: true },
        runHealth: { available: true, complete: true, windowHours: 24 },
        bundles: [{
          repository: "githubnext/gh-aw-cao",
          path: "dependabot/aw.yml",
          name: "Dependabot",
          id: "dependabot",
          workflows: [{ lockPath: ".github/workflows/dependabot.lock.yml" }],
        }],
        workflows: [{
          repository: "githubnext/gh-aw-cao",
          path: ".github/workflows/dependabot.lock.yml",
          name: "Dependabot",
          role: "orchestrator",
          state: "active",
          updatedAt: "2026-08-30T11:00:00Z",
          ghAwMetadata: { strict: false },
          ghAwManifest: { actions: [{ repo: "actions/checkout", sha: "" }] },
          runHealth: {
            runRecords: [{
              runId: 42,
              status: "completed",
              conclusion: "action_required",
              event: "workflow_dispatch",
              startedAt: "2026-08-30T10:00:00Z",
              updatedAt: "2026-08-30T10:05:00Z",
              displayTitle: "Dependabot · review",
            }],
          },
        }],
      },
      usage: {
        generatedAt: "2026-08-30T12:00:00Z",
        available: true,
        complete: true,
        securityAvailable: true,
        securityComplete: true,
        securityRuns: [{
          repository: "githubnext/gh-aw-cao",
          runId: 42,
          workflowPath: ".github/workflows/dependabot.lock.yml",
          createdAt: "2026-08-30T10:00:00Z",
          security: {
            agenticAssessments: [{
              kind: "partially_reducible",
              severity: "low",
              summary: "Half of the turns could be deterministic.",
              evidence: "agentic_fraction=0.50 turns=8",
              recommendation: "Move data fetching into pre-steps.",
            }],
            threatDetection: {
              available: true,
              verdict: { promptInjection: true, secretLeak: false, maliciousPatch: false },
            },
          },
        }],
        runs: [{
          repository: "githubnext/gh-aw-cao",
          runId: 42,
          workflowPath: ".github/workflows/dependabot.lock.yml",
          mode: "review",
          createdAt: "2026-08-30T10:00:00Z",
          aic: 2.5,
        }],
      },
      operationalValues: {
        records: [{
          repository: "githubnext/gh-aw-cao",
          workflowId: "dependabot",
          workflowPath: ".github/workflows/dependabot.lock.yml",
          runId: 42,
          runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
          status: "pass",
          value: 0.75,
          deltaFromBaseline: 0.1,
          evaluatorDigest: "sha256:test",
          observation: {
            opportunityKey: "release-train",
            evidenceAt: "2026-08-30T10:05:00Z",
            maturesAt: "2026-09-01T10:05:00Z",
            mature: false,
            subject: { repository: "githubnext/gh-aw-cao" },
          },
        }],
      },
      report: {
        generatedAt: "2026-08-30T12:00:00Z",
        records: [{
          id: "githubnext/gh-aw-cao-issue-1",
          kind: "issue",
          state: "open",
          title: "Dependabot report",
          summary: "A release train needs attention.",
          repository: "githubnext/gh-aw-cao",
          workflowPath: ".github/workflows/dependabot.lock.yml",
          runUrl: "https://github.com/githubnext/gh-aw-cao/actions/runs/42",
          url: "https://github.com/githubnext/gh-aw-cao/issues/1",
          updatedAt: "2026-08-30T10:06:00Z",
          warning: true,
          conclusion: "failure",
        }],
      },
      inventory: {
        workflows: [],
        bundles: [{
          id: "dependabot",
          workflow: ".github/workflows/dependabot.md",
          compiled: false,
          missingWorkers: ["dependabot-worker"],
          workers: [],
        }],
      },
      controlSettings: {
        allowed_repositories: [
          "github/gh-aw",
          "github/gh-aw-firewall",
          "github/gh-aw-mcpg",
          "github/gh-aw-actions",
          "github/gh-aw-threat-detection",
          "githubnext/gh-aw-cao",
          "githubnext/gh-aw-workshop",
        ],
        packages: {
          dependabot: {
            mode: "review",
            rollout_percent: 100,
            target_policies: { "githubnext/gh-aw-cao": { mode: "live" } },
          },
        },
      },
    };
    for (const [name, value] of Object.entries(inputs)) {
      writeFileSync(join(temporaryDirectory, `${name}.json`), JSON.stringify(value));
    }
    const output = join(temporaryDirectory, "sources.json");
    try {
      execFileSync(process.execPath, [
        resolve("../../dashboard/report/dashboard-language-sources.mjs"),
      ], {
        env: {
          ...process.env,
          REPORT_DEPLOYED_WORKFLOWS: join(temporaryDirectory, "deployed.json"),
          REPORT_AIC_USAGE: join(temporaryDirectory, "usage.json"),
          REPORT_OPERATIONAL_VALUES: join(temporaryDirectory, "operationalValues.json"),
          REPORT_RECORDS: join(temporaryDirectory, "report.json"),
          REPORT_INVENTORY: join(temporaryDirectory, "inventory.json"),
          REPORT_CONTROL_SETTINGS: join(temporaryDirectory, "controlSettings.json"),
          REPORT_DASHBOARD_SOURCES: output,
        },
      });
      let sources = JSON.parse(readFileSync(output, "utf8"));
      const sourceManifest = JSON.parse(readFileSync(join(temporaryDirectory, "sources", "manifest.json"), "utf8"));
      const splitRuns = JSON.parse(readFileSync(join(temporaryDirectory, "sources", "runs.json"), "utf8"));

      expect(sourceManifest).toEqual({
        version: 1,
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
        sources: Object.keys(sources),
      });
      expect(splitRuns.metadata["artifact-generation"]).toBe(sourceManifest.generation);
      expect(splitRuns.rows).toHaveLength(sources.runs.rows.length);
      expect(splitRuns.rows.every((/** @type {Record<string, unknown>} */ row) => !("logs-payload" in row))).toBe(true);

      expect(sources.workflows.rows[0]).toMatchObject({
        organization: "githubnext",
        repository: "gh-aw-cao",
        package: "dependabot",
        "package-inventory-warnings": 2,
        "package-rollout-percent": 100,
        "package-targets": [
          { repository: "github/gh-aw", mode: "review" },
          { repository: "github/gh-aw-firewall", mode: "review" },
          { repository: "github/gh-aw-mcpg", mode: "review" },
          { repository: "github/gh-aw-actions", mode: "review" },
          { repository: "github/gh-aw-threat-detection", mode: "review" },
          { repository: "githubnext/gh-aw-cao", mode: "live" },
          { repository: "githubnext/gh-aw-workshop", mode: "review" },
        ],
        "workflow-active": "true",
        "rollout-mode": "live",
      });
      expect(sources.runs.rows[0]).toMatchObject({
        run: "42",
        event: "workflow_dispatch",
        "run-title": "Dependabot · review",
        "run-status": "completed",
        "run-conclusion": "action-required",
        "rollout-mode": "review",
      });
      expect(sources.runs.metadata).toMatchObject({
        "coverage-start": "2026-08-29T12:00:00.000Z",
        "coverage-end": "2026-08-30T12:00:00Z",
      });
      expect(sources.usage.rows[0]).toMatchObject({ run: "42", aic: 2.5 });
      expect(sources["security-findings"].rows).toContainEqual(expect.objectContaining({
        organization: "githubnext",
        repository: "gh-aw-cao",
        workflow: ".github/workflows/dependabot.md",
        run: "42",
        "smell-id": "threat-detection-prompt-injection",
        "smell-name": "Prompt injection detected",
        "smell-category": "trust-and-security",
        "smell-severity": "high",
      }));
      expect(sources["agent-smells"].rows).toContainEqual(expect.objectContaining({
        workflow: ".github/workflows/dependabot.md",
        run: "42",
        "smell-id": "partially-reducible",
        "smell-name": "Partially reducible",
        "smell-category": "design",
        "smell-severity": "low",
        "smell-evidence": "agentic_fraction=0.50 turns=8",
        "smell-recommendation": "Move data fetching into pre-steps.",
      }));
      expect(sources["workflow-smells"].rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          workflow: ".github/workflows/dependabot.md",
          "smell-id": "strict-disabled",
          "smell-severity": "high",
        }),
        expect.objectContaining({
          workflow: ".github/workflows/dependabot.md",
          "smell-id": "unpinned-dependencies",
          "smell-severity": "high",
        }),
      ]));
      expect(sources["control-plane-smells"].rows).toContainEqual(expect.objectContaining({
        "smell-id": "inventory-incomplete",
        "smell-severity": "high",
      }));
      expect(sources["control-plane-smells"].rows).toContainEqual(expect.objectContaining({
        organization: "githubnext",
        repository: "gh-aw-cao",
        "smell-id": "policy-diagnostic",
        "observed-at": "2026-08-30T12:00:00Z",
        "repository-link": expect.objectContaining({ href: "https://github.com/githubnext/gh-aw-cao" }),
      }));
      const overview = deriveOverviewSources(sources);
      expect(overview["overview-managed-packages"].rows).toContainEqual(expect.objectContaining({
        package: "dependabot",
        "repository-modes": expect.arrayContaining([{ repository: "githubnext/gh-aw-cao", mode: "live" }]),
        "rollout-live-repositories": 1,
        "rollout-repositories": 7,
        "rollout-percent": 100,
        "live-coverage-percent": 14,
      }));
      expect(sources.findings.rows[0]).toMatchObject({
        finding: "githubnext/gh-aw-cao-issue-1",
        "finding-kind": "authored-warning",
        "finding-severity": "medium",
        "finding-status": "open",
      });
      expect(sources.outcomes.rows[0]["outcome-state"]).toBe("pending");
      expect(sources.outcomes.rows[0]["run-conclusion"]).toBe("failure");
      expect(sources["operational-values"].rows[0]).toMatchObject({
        "operational-value": 0.75,
        "operational-value-definition": "dependabot",
        "maturity-status": "interim",
      });

      const rateLimitedReport = {
        ...inputs.report,
        records: [],
        error: "GitHub API rate limit exceeded; collection stopped.",
        errorStatus: 403,
      };
      writeFileSync(join(temporaryDirectory, "report.json"), JSON.stringify(rateLimitedReport));
      execFileSync(process.execPath, [
        resolve("../../dashboard/report/dashboard-language-sources.mjs"),
      ], {
        env: {
          ...process.env,
          REPORT_DEPLOYED_WORKFLOWS: join(temporaryDirectory, "deployed.json"),
          REPORT_AIC_USAGE: join(temporaryDirectory, "usage.json"),
          REPORT_OPERATIONAL_VALUES: join(temporaryDirectory, "operationalValues.json"),
          REPORT_RECORDS: join(temporaryDirectory, "report.json"),
          REPORT_INVENTORY: join(temporaryDirectory, "inventory.json"),
          REPORT_CONTROL_SETTINGS: join(temporaryDirectory, "controlSettings.json"),
          REPORT_DASHBOARD_SOURCES: output,
        },
      });
      sources = JSON.parse(readFileSync(output, "utf8"));
      expect(sources["coverage-diagnostics"].rows).toContainEqual(expect.objectContaining({
        kind: "github-api-rate-limit-403",
        title: "Durable output collection unavailable",
        effect: "Durable output evidence is partial because GitHub rate-limited collection.",
        "technical-detail": rateLimitedReport.error,
      }));
      expect(sources.findings.metadata).toMatchObject({
        availability: "unavailable",
        completeness: "partial",
      });
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
