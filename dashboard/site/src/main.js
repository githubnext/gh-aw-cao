      import { dashboardPageLazySourceNames, dashboardPageSourceNames, disposeDashboard, renderDashboard, updateWithViewTransition } from "./presenter.js";
      import { startLoadingProgress } from "./loading-progress.js";
      import { offerCancelCommand } from "./cancel-command.js";
      import { loadCanonicalDashboardPage, loadCanonicalDashboardSources, processDashboardQueries, refreshCanonicalDashboardSources, subscribeCanonicalDashboardView } from "./data-processor.js";
      import { loadCanonicalViewSources } from "./data/queries/view-sources.js";
      import { DATABASE_COUNT_SOURCE_NAMES } from "./database-counts.js";
      import { bindSourceContinuations, continuationRequests } from "./data/continuation.js";
      import { octicon } from "./octicons.js";
      import { renderRefreshError } from "./components/refresh-error.js";
      import { DASHBOARD_DATA_EVENT, emitDashboardDebugEvent } from "./debug-events.js";
      import { collectFullDiagnostics } from "./diagnostics.js";
      import { renderLoadingPlaceholderBlocks } from "./components/ui-primitives.js";
      import { startAutomaticDashboardDataUpdates } from "./dashboard-data-updates.js";
      import { renderCliActions, setDeclaredCliActions } from "./components/cli-actions.js";

      /** @type {Window & { collectFullDiagnostics?: typeof collectFullDiagnostics }} */ (window).collectFullDiagnostics =
        () => collectFullDiagnostics();

      /**
       * @param {string} id
       * @param {Partial<import('./presenter.js').SourceMetadata>} [overrides]
       * @returns {import('./presenter.js').SourceMetadata}
       */
      const metadata = (id, overrides = {}) => ({
        "source-id": id,
        "source-kind": "fixture",
        "as-of": "2026-08-29T19:00:00Z",
        "retrieved-at": "2026-08-29T19:01:00Z",
        completeness: "complete",
        freshness: "fresh",
        availability: "available",
        ...overrides,
      });
      /** @param {string} run */
      const runLink = (run) => ({
        relation: "run",
        href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`,
        label: `Run ${run}`,
      });
      const targetRepositories = [
        "github/gh-aw",
        "github/gh-aw-firewall",
        "github/gh-aw-mcpg",
        "github/gh-aw-actions",
        "github/gh-aw-threat-detection",
        "githubnext/gh-aw-workshop",
      ];
      const packageTargets = (liveRepository = "") => targetRepositories.map((repository) => ({
        repository,
        mode: repository === liveRepository ? "live" : "review",
      }));

      const loadingProgress = startLoadingProgress(document);
      /**
       * @template T
       * @param {() => Promise<T>} task
       * @returns {Promise<T>}
       */
      const runWithLoadingProgress = async (task) => {
        const progress = startLoadingProgress(document);
        try {
          return await task();
        } finally {
          progress.complete();
        }
      };
      const cancelCommand = offerCancelCommand(document);
      const dashboardSchema = await fetch("./dashboard.json", { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error(`Unable to load dashboard.json: ${response.status}`);
          return response.json();
        })
        .catch((error) => {
          loadingProgress.complete();
          cancelCommand.complete();
          throw error;
        });
      /** @type {import('./presenter.js').PresentationDocument} */
      let dashboardDocument = {
        languageVersion: dashboardSchema["language-version"],
        dashboard: dashboardSchema.dashboard,
      };
      const dashboardQueries = dashboardSchema.dashboard.queries ?? [];
      const root = document.querySelector("#root");
      if (!(root instanceof HTMLElement)) throw new Error("Dashboard root element is missing.");
      /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */
      let renderedSources = {};
      let renderedSourcesPrepared = false;
      /** @type {((pageId: string) => Promise<Record<string, import('./presenter.js').LogicalSourceInput>>) | undefined} */
      let renderedPageSourceLoader;
      /** @type {(() => Promise<Record<string, import('./presenter.js').LogicalSourceInput>>) | undefined} */
      let renderedHorizonSourceLoader;
      const previewMode = new URLSearchParams(window.location.search).get("local-preview");
      const localViewer = previewMode
        ? await fetch("./viewer.json")
          .then((response) => response.ok ? response.json() : null)
          .catch(() => null)
        : null;
      /** @type {WebSocket | undefined} */
      let dashboardSocket;
      if (previewMode) {
        const dashboardSocketUrl = new URL("./__dashboard_socket", window.location.href);
        dashboardSocketUrl.protocol = dashboardSocketUrl.protocol.replace(/^http/, "ws");
        dashboardSocket = new WebSocket(dashboardSocketUrl);
        dashboardSocket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message?.type === "dashboard-update" && message.dashboard) {
            window.dispatchEvent(new CustomEvent("dashboard-preview-update", {
              detail: { dashboard: message.dashboard, traceId: message.traceId },
            }));
          } else if (!message?.type) {
            window.dispatchEvent(new CustomEvent("dashboard-preview-update", {
              detail: { dashboard: message },
            }));
          }
        });
        console.log("Dashboard preview socket initialized.");
      }
      /** @type {HTMLFormElement | undefined} */
      let copilotPrompt;
      let copilotPanelOpen = false;
      if (previewMode === "copilot") {
        if (!dashboardSocket) throw new Error("Copilot mode requires the dashboard preview socket.");
        const { renderCopilotPrompt } = await import("./copilot-prompt.js");
        copilotPrompt = renderCopilotPrompt(dashboardSocket);
        console.log("Copilot dashboard prompt initialized.");
      }

      /** @param {HTMLElement} dashboard */
      const attachCopilotPanel = (dashboard) => {
        if (!copilotPrompt) return;
        const panel = document.createElement("aside");
        panel.id = "dashboard-copilot-panel";
        panel.className = "dashboard-copilot-panel";
        panel.setAttribute("aria-label", "Modify this view with Copilot");
        panel.hidden = !copilotPanelOpen;

        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.className = "copilot-panel-toggle";
        toggleButton.setAttribute("aria-controls", panel.id);
        toggleButton.setAttribute("aria-label", "Modify this view with Copilot");
        toggleButton.title = "Modify this view with Copilot";
        const toggleLabel = document.createElement("span");
        toggleLabel.textContent = "Modify this view";
        const sidebar = dashboard.querySelector(".org-sidebar");

        /** @param {boolean} open @param {boolean} [restoreFocus] */
        const setOpen = (open, restoreFocus = false) => {
          copilotPanelOpen = open;
          panel.hidden = !open;
          toggleButton.replaceChildren(
            octicon("sparkle"),
            toggleLabel,
            octicon(open ? "chevron-down" : "chevron-up")
          );
          if (open) {
            const triggerBounds = toggleButton.getBoundingClientRect();
            toggleButton.style.setProperty("--copilot-toggle-left", `${triggerBounds.left}px`);
            toggleButton.style.setProperty("--copilot-toggle-width", `${triggerBounds.width}px`);
            panel.prepend(toggleButton);
          } else {
            sidebar?.append(toggleButton);
          }
          toggleButton.setAttribute("aria-expanded", String(open));
          dashboard.classList.toggle("dashboard-copilot-panel-open", open);
          if (open) copilotPrompt.querySelector("textarea")?.focus();
          else if (restoreFocus) toggleButton.focus();
        };
        toggleButton.addEventListener("click", () => setOpen(!copilotPanelOpen, copilotPanelOpen));
        panel.addEventListener("keydown", (event) => {
          if (event.key === "Escape") setOpen(false, true);
        });

        panel.append(copilotPrompt);
  sidebar?.append(toggleButton);
        dashboard.append(panel);
        dashboard.classList.add("dashboard-copilot-enabled");
        setOpen(copilotPanelOpen);
      };

      /**
       * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
       * @param {'ready' | 'loading' | 'cached' | 'stale'} [state]
       * @param {boolean} [prepared]
       * @param {(pageId: string) => Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} [loadPageSources]
       * @param {() => Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} [loadHorizonSources]
       * @param {() => void} [retryRefresh]
       */
      const renderSources = (sources, state = "ready", prepared = false, loadPageSources, loadHorizonSources, retryRefresh) => {
        setDeclaredCliActions(previewMode === "canvas"
          ? dashboardDocument.dashboard["cli-actions"] ?? []
          : []);
        renderedSources = sources;
        renderedSourcesPrepared = prepared;
        renderedPageSourceLoader = loadPageSources;
        renderedHorizonSourceLoader = loadHorizonSources;
        const dashboard = renderDashboard({
          document: dashboardDocument,
          sources,
          viewer: localViewer,
          prepared,
          loading: state === "loading",
          loadPageSources,
          loadHorizonSources,
        });
        if (state === "loading") {
          dashboard.classList.add("dashboard-loading");
          dashboard.setAttribute("aria-busy", "true");

          const skeleton = document.createElement("div");
          skeleton.className = "dashboard-loading-skeleton";
          skeleton.setAttribute("aria-hidden", "true");
          for (const block of renderLoadingPlaceholderBlocks()) {
            skeleton.append(block);
          }
          dashboard.querySelector(".report-body")?.prepend(skeleton);
        } else if (state === "cached") {
          dashboard.classList.add("dashboard-refreshing");
          dashboard.setAttribute("aria-busy", "true");
        } else if (state === "stale") {
          dashboard.classList.add("dashboard-stale");
          if (retryRefresh) {
            dashboard.querySelector(".report-body")?.prepend(renderRefreshError(retryRefresh));
          }
        }
        attachCopilotPanel(dashboard);
        if (previewMode === "canvas") {
          const declaredActions = dashboardDocument.dashboard["cli-actions"] ?? [];
          /** @type {Record<string, string>} */
          const actionTemplateValues = {};
          if (typeof dashboardDocument.dashboard.repository === "string") {
            actionTemplateValues.repository = dashboardDocument.dashboard.repository;
          }
          const toolbarActions = renderCliActions(
            declaredActions.filter((action) => !["settings", "row"].includes(action.placement ?? "toolbar")),
            { templateValues: actionTemplateValues }
          );
          if (toolbarActions) dashboard.querySelector(".report-actions")?.prepend(toolbarActions);
          const settingsActions = renderCliActions(
            declaredActions.filter((action) => action.placement === "settings"),
            {
              presentation: "settings",
              templateValues: actionTemplateValues
            }
          );
          if (settingsActions) {
            const dialogs = [...settingsActions.querySelectorAll("dialog")];
            dashboard.querySelector(".account-menu-popover .reset-dashboard-control")
              ?.before(settingsActions);
            for (const dialog of dialogs) dashboard.append(dialog);
          }
        }
        const previousDashboard = root.firstElementChild;
        if (previousDashboard instanceof HTMLElement) disposeDashboard(previousDashboard);
        root.replaceChildren(dashboard);
        return dashboard;
      };
      window.addEventListener("dashboard-preview-update", (event) => {
        const previewEvent = /** @type {CustomEvent<{ dashboard: { 'language-version': string, dashboard: import('./presenter.js').PresentableDashboard }, traceId?: string }>} */ (event);
        const { dashboard: schema, traceId } = previewEvent.detail;
        const previousDashboardDocument = dashboardDocument;
        try {
          dashboardDocument = {
            languageVersion: schema["language-version"],
            dashboard: schema.dashboard,
          };
          updateWithViewTransition(document, () => renderSources(renderedSources, "ready", renderedSourcesPrepared, renderedPageSourceLoader, renderedHorizonSourceLoader));
          if (traceId && dashboardSocket?.readyState === WebSocket.OPEN) {
            dashboardSocket.send(JSON.stringify({
              type: "browser.trace",
              traceId,
              event: "preview.rendered",
              details: {
                pageCount: schema.dashboard.pages.length,
                activeHash: window.location.hash,
              },
            }));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorLog = error instanceof Error && error.stack ? error.stack : message;
          let recovered = false;
          let recoveryErrorLog = "";
          dashboardDocument = previousDashboardDocument;
          try {
            renderSources(renderedSources, "ready", renderedSourcesPrepared, renderedPageSourceLoader, renderedHorizonSourceLoader);
            recovered = true;
          } catch (recoveryError) {
            recoveryErrorLog = recoveryError instanceof Error && recoveryError.stack
              ? recoveryError.stack
              : String(recoveryError);
          }
          const combinedErrorLog = [
            errorLog,
            recoveryErrorLog ? `Preview recovery failed:\n${recoveryErrorLog}` : "",
          ].filter(Boolean).join("\n\n").slice(0, 6000);
          console.error("Dashboard preview hot reload failed.", {
            message,
            recovered,
          });
          if (traceId && dashboardSocket?.readyState === WebSocket.OPEN) {
            dashboardSocket.send(JSON.stringify({
              type: "browser.trace",
              traceId,
              event: "preview.render.failed",
              details: {
                message,
                errorLog: combinedErrorLog,
                recovered,
              },
            }));
          }
        }
      });

      const fixtureSources = /** @type {Record<string, import('./presenter.js').LogicalSourceInput>} */ ({
        "configuration-summary": {
          source: "configuration-summary",
          rows: [
            { status: "Valid", count: 1 },
            { status: "Guidance", count: 1 },
          ],
          metadata: metadata("configuration-summary-fixture"),
        },
        "configuration-policy": {
          source: "configuration-policy",
          rows: [{
            path: ".github/workflows/cao.json",
            document: {
              version: 1,
              "control-plane": {
                scope: { "allowed-owners": ["githubnext"], "allowed-repositories": ["githubnext/gh-aw-cao"] },
                defaults: { mode: "review", "max-repositories": 1, "rollout-percent": 100 },
                packages: { "self-care": { mode: "review", workers: { "dashboard-review": { workflow: "self-care-dashboard-review" } } } },
              },
            },
            raw: '{\n  "version": 1,\n  "control-plane": {\n    "scope": {\n      "allowed-owners": ["githubnext"],\n      "allowed-repositories": ["githubnext/gh-aw-cao"]\n    },\n    "defaults": {\n      "mode": "review",\n      "max-repositories": 1,\n      "rollout-percent": 100\n    }\n  }\n}',
            diagnostics: [
              { severity: "valid", path: ".github/workflows/cao.json", title: "Policy is valid", detail: "The runtime policy resolver accepted this revision." },
              { severity: "guidance", path: "control-plane.packages.self-care.mode", title: "self-care is review-only", detail: "Review mode produces proposals in the control repository and cannot mutate targets." },
            ],
          }],
          metadata: metadata("configuration-policy-fixture"),
        },
        "configuration-actions": {
          source: "configuration-actions",
          rows: [{
            action: "Promote self-care to live",
            path: "control-plane.packages.self-care.mode",
            current: "review",
            recommended: "live",
            prompt: 'Update .github/workflows/cao.json so control-plane.packages.self-care.mode is "live". Preserve all existing scope and rollout limits, verify target-owned authority, and validate the policy before committing.',
          }],
          metadata: metadata("configuration-actions-fixture"),
        },
        organizations: {
          source: "organizations",
          rows: [
            { organization: "github", "organization-name": "GitHub", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "octo-org", "organization-name": "Octo Org", "observed-at": "2026-08-29T10:00:00Z" },
          ],
          metadata: metadata("organizations-fixture"),
        },
        repositories: {
          source: "repositories",
          rows: [
            { organization: "github", repository: "gh-aw-cao", "repository-name": "Central Agentic Ops", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", "repository-name": "Central Agentic Ops", "rollout-mode": "review", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "github", repository: "mona-tools", "repository-name": "Mona Tools", "rollout-mode": "review", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "octo-org", repository: "octo-repo", "repository-name": "Octo Repo", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
          ],
          metadata: metadata("repositories-fixture"),
        },
        workflows: {
          source: "workflows",
          rows: [
            { organization: "githubnext", repository: "gh-aw-cao", package: "dependabot", "package-name": "Dependabot", "workflow-role": "orchestrator", workflow: ".github/workflows/dependabot.md", "workflow-name": "Repository selector", "workflow-active": "true", "rollout-mode": "review", "package-targets": packageTargets("github/gh-aw"), "max-ai-credits": 250, "package-aic-allowance": 850, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "dependabot", "package-name": "Dependabot", "workflow-role": "worker", workflow: ".github/workflows/dependabot-release-train-updater.md", "workflow-name": "Release train updater", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 600, "package-aic-allowance": 850, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "aw-doctor", "package-name": "AW Doctor", "workflow-role": "orchestrator", workflow: ".github/workflows/aw-doctor.md", "workflow-name": "Repository selector", "workflow-active": "true", "rollout-mode": "review", "package-targets": packageTargets(), "max-ai-credits": 250, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "aw-doctor", "package-name": "AW Doctor", "workflow-role": "worker", workflow: ".github/workflows/aw-maintenance-upgrade.md", "workflow-name": "Upgrade", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 500, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "aw-doctor", "package-name": "AW Doctor", "workflow-role": "worker", workflow: ".github/workflows/aw-maintenance-failures.md", "workflow-name": "Failures investigator", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 500, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "optimization", "package-name": "AW Optimization", "workflow-role": "orchestrator", workflow: ".github/workflows/optimization.md", "workflow-name": "Repository selector", "workflow-active": "true", "rollout-mode": "review", "package-targets": packageTargets(), "max-ai-credits": 250, "package-aic-allowance": 1900, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "optimization", "package-name": "AW Optimization", "workflow-role": "worker", workflow: ".github/workflows/optimization-ai-credit-optimizer.md", "workflow-name": "AI Credit optimizer", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 500, "package-aic-allowance": 1900, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "optimization", "package-name": "AW Optimization", "workflow-role": "worker", workflow: ".github/workflows/optimization-ai-credit-auditor.md", "workflow-name": "AI Credit auditor", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 350, "package-aic-allowance": 1900, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "optimization", "package-name": "AW Optimization", "workflow-role": "worker", workflow: ".github/workflows/optimization-agents-md-curator.md", "workflow-name": "AGENTS.md curator", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 400, "package-aic-allowance": 1900, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", package: "optimization", "package-name": "AW Optimization", "workflow-role": "worker", workflow: ".github/workflows/optimization-skills-curator.md", "workflow-name": "Skills curator", "workflow-active": "true", "rollout-mode": "review", "max-ai-credits": 400, "package-aic-allowance": 1900, "inventory-ready": true, "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "github", repository: "gh-aw-cao", "workflow-role": "standalone", workflow: ".github/workflows/daily.yml", "workflow-name": "Daily", "workflow-active": "true", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "github", repository: "mona-tools", "workflow-role": "standalone", workflow: ".github/workflows/review.yml", "workflow-name": "Review", "workflow-active": "true", "rollout-mode": "review", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "github", repository: "mona-tools", "workflow-role": "standalone", workflow: ".github/workflows/ci.yml", "workflow-name": "Build and test", "workflow-active": "true", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "github", repository: "mona-tools", "workflow-role": "standalone", workflow: ".github/workflows/codeql.yml", "workflow-name": "CodeQL", "workflow-active": "true", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "octo-org", repository: "octo-repo", "workflow-role": "standalone", workflow: ".github/workflows/nightly.yml", "workflow-name": "Nightly", "workflow-active": "true", "rollout-mode": "live", "observed-at": "2026-08-29T10:00:00Z" },
            { organization: "octo-org", repository: "octo-repo", "workflow-role": "standalone", workflow: ".github/workflows/release.yml", "workflow-name": "Release", "workflow-active": "false", "rollout-mode": "review", "observed-at": "2026-08-29T10:00:00Z" },
          ],
          metadata: metadata("workflows-fixture"),
        },
        runs: {
          source: "runs",
          rows: [
            { organization: "github", repository: "gh-aw-cao", workflow: ".github/workflows/daily.yml", run: "1001", "started-at": "2026-08-29T09:00:00Z", "run-status": "completed", "run-conclusion": "success", "rollout-mode": "live", engine: "gpt", "requested-model": "gpt-4o", "resolved-model": "gpt-4.1", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/1001", label: "View run 1001" } },
            { organization: "github", repository: "mona-tools", workflow: ".github/workflows/review.yml", run: "1002", "started-at": "2026-08-29T09:30:00Z", "run-status": "completed", "run-conclusion": "failure", "rollout-mode": "review", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "run-link": { relation: "run", href: "https://github.com/githubnext/mona-tools/actions/runs/1002", label: "View run 1002" } },
            { organization: "octo-org", repository: "octo-repo", workflow: ".github/workflows/nightly.yml", run: "2001", "started-at": "2026-08-29T08:00:00Z", "run-status": "in-progress", "run-conclusion": "unknown", "rollout-mode": "live", engine: "claude", "requested-model": "claude-3.5", "resolved-model": "claude-3.5", "run-link": { relation: "run", href: "https://github.com/octo-org/octo-repo/actions/runs/2001", label: "View run 2001" } },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/dependabot.md", run: "2002", event: "workflow_dispatch", "run-title": "Dependabot", "started-at": "2026-08-29T08:30:00Z", "run-status": "completed", "run-conclusion": "action-required", "rollout-mode": "review", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/2002", label: "View run 2002" } },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/aw-doctor.md", run: "2003", event: "workflow_dispatch", "run-title": "AW Doctor", "started-at": "2026-08-29T07:30:00Z", "run-status": "completed", "run-conclusion": "success", "rollout-mode": "review", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/2003", label: "View run 2003" } },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/dependabot-release-train-updater.md", run: "2004", event: "workflow_dispatch", "run-title": "Release train updater", "started-at": "2026-08-20T08:30:00Z", "run-status": "completed", "run-conclusion": "failure", "rollout-mode": "live", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/2004", label: "View run 2004" } },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/aw-maintenance-upgrade.md", run: "2005", event: "workflow_dispatch", "run-title": "AW Doctor Upgrade", "started-at": "2026-08-10T07:30:00Z", "run-status": "completed", "run-conclusion": "cancelled", "rollout-mode": "review", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/2005", label: "View run 2005" } },
          ],
          metadata: metadata("runs-fixture"),
        },
        "work-items": {
          source: "work-items",
          rows: [
            {
              "work-item-id": "dependabot:github/gh-aw:release-train-2026-09-05",
              objective: "Update the Dependabot release train",
              organization: "github",
              repository: "gh-aw",
              scope: "github/gh-aw",
              domain: "software-supply-chain",
              "work-type": "dependency-maintenance",
              "lifecycle-state": "review",
              phase: "verifying",
              reason: "Three required validations passed; security review remains pending.",
              "reason-evidence-class": "observed",
              "next-action": "Review the dependency update evidence",
              "next-actor": "security-reviewers",
              "waiting-on": "security-reviewers",
              "waiting-since": "2026-08-29T08:40:00Z",
              owner: "dependency-automation",
              "consequence-tier": "high",
              "verification-state": "pending",
              "outcome-state": "pending",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/gh-aw/pull/74", label: "Review dependency evidence" },
              "repository-link": { relation: "repository", href: "https://github.com/github/gh-aw", label: "Open github/gh-aw" },
              "run-link": runLink("2002"),
            },
            {
              "work-item-id": "aw-doctor:github/mona-tools:upgrade-2026-09-05",
              objective: "Upgrade agentic workflow dependencies",
              organization: "github",
              repository: "mona-tools",
              scope: "github/mona-tools",
              domain: "developer-infrastructure",
              "work-type": "workflow-maintenance",
              "lifecycle-state": "blocked",
              phase: "waiting",
              reason: "The target repository has not granted live authority.",
              "reason-evidence-class": "observed",
              "next-action": "Confirm target authority or retain review mode",
              "next-actor": "repository-owner",
              "waiting-on": "repository-owner",
              "waiting-since": "2026-08-29T07:30:00Z",
              owner: "developer-platform",
              "consequence-tier": "medium",
              "verification-state": "not-applicable",
              "outcome-state": "pending",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("2003"),
              "repository-link": { relation: "repository", href: "https://github.com/github/mona-tools", label: "Open github/mona-tools" },
              "run-link": runLink("2003"),
            },
            {
              "work-item-id": "optimization:githubnext/gh-aw-cao:aic-2026-09-05",
              objective: "Reduce AI Credit usage without reducing accepted outcomes",
              organization: "githubnext",
              repository: "gh-aw-cao",
              scope: "githubnext/gh-aw-cao",
              domain: "agentic-operations",
              "work-type": "resource-optimization",
              "lifecycle-state": "active",
              phase: "investigating",
              reason: "Usage attribution is partial for two worker runs.",
              "reason-evidence-class": "derived",
              "next-action": "Collect missing worker usage attribution",
              "next-actor": "ai-credit-optimizer",
              "waiting-on": "telemetry",
              "waiting-since": "2026-08-29T09:05:00Z",
              owner: "agentic-operations",
              "consequence-tier": "low",
              "verification-state": "pending",
              "outcome-state": "pending",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("1001"),
              "repository-link": { relation: "repository", href: "https://github.com/githubnext/gh-aw-cao", label: "Open githubnext/gh-aw-cao" },
              "run-link": runLink("1001"),
            },
          ],
          metadata: metadata("work-items-fixture"),
        },
        "attention-signals": {
          source: "attention-signals",
          rows: [
            {
              "attention-signal-id": "verification:dependabot:74",
              "signal-type": "verification-review",
              "work-item-id": "dependabot:github/gh-aw:release-train-2026-09-05",
              objective: "Update the Dependabot release train",
              scope: "github/gh-aw",
              reason: "Security verification requires human review.",
              action: "Review dependency evidence",
              "expected-actor": "security-reviewers",
              "age-seconds": 4800,
              "consequence-tier": "high",
              priority: 2,
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/gh-aw/pull/74", label: "Review dependency evidence" },
              "repository-link": { relation: "repository", href: "https://github.com/github/gh-aw", label: "Open github/gh-aw" },
              "run-link": runLink("2002"),
            },
            {
              "attention-signal-id": "authority:mona-tools:upgrade",
              "signal-type": "authority-gate",
              "work-item-id": "aw-doctor:github/mona-tools:upgrade-2026-09-05",
              objective: "Upgrade agentic workflow dependencies",
              scope: "github/mona-tools",
              reason: "Live target authority is unavailable.",
              action: "Confirm authority or retain review mode",
              "expected-actor": "repository-owner",
              "age-seconds": 9000,
              "consequence-tier": "medium",
              priority: 1,
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("2003"),
              "repository-link": { relation: "repository", href: "https://github.com/github/mona-tools", label: "Open github/mona-tools" },
              "run-link": runLink("2003"),
            },
          ],
          metadata: metadata("attention-signals-fixture"),
        },
        "agent-assignments": {
          source: "agent-assignments",
          rows: [
            {
              "assignment-id": "assignment:release-train-updater:74",
              "agent-id": "dependabot-release-train-updater",
              "agent-name": "Release train updater",
              "agent-state": "waiting",
              "work-item-id": "dependabot:github/gh-aw:release-train-2026-09-05",
              objective: "Update the Dependabot release train",
              "assignment-state": "active",
              "handoff-state": "waiting-for-review",
              "dependency-state": "clear",
              "conflict-state": "none",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("2002"),
              "repository-link": { relation: "repository", href: "https://github.com/github/gh-aw", label: "Open github/gh-aw" },
              "run-link": runLink("2002"),
            },
            {
              "assignment-id": "assignment:aw-doctor-upgrade:mona-tools",
              "agent-id": "aw-doctor-upgrade",
              "agent-name": "AW Doctor upgrade",
              "agent-state": "blocked",
              "work-item-id": "aw-doctor:github/mona-tools:upgrade-2026-09-05",
              objective: "Upgrade agentic workflow dependencies",
              "assignment-state": "active",
              "handoff-state": "none",
              "dependency-state": "blocked",
              "conflict-state": "none",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("2003"),
              "repository-link": { relation: "repository", href: "https://github.com/github/mona-tools", label: "Open github/mona-tools" },
              "run-link": runLink("2003"),
            },
            {
              "assignment-id": "assignment:aic-optimizer:gh-aw-cao",
              "agent-id": "ai-credit-optimizer",
              "agent-name": "AI Credit optimizer",
              "agent-state": "active",
              "work-item-id": "optimization:githubnext/gh-aw-cao:aic-2026-09-05",
              objective: "Reduce AI Credit usage without reducing accepted outcomes",
              "assignment-state": "active",
              "handoff-state": "none",
              "dependency-state": "waiting-on-telemetry",
              "conflict-state": "none",
              "observed-at": "2026-08-29T10:00:00Z",
              "evidence-link": runLink("1001"),
              "repository-link": { relation: "repository", href: "https://github.com/githubnext/gh-aw-cao", label: "Open githubnext/gh-aw-cao" },
              "run-link": runLink("1001"),
            },
          ],
          metadata: metadata("agent-assignments-fixture"),
        },
        "agent-smells": {
          source: "agent-smells",
          rows: [{
            "smell-observation-id": "agent:2004:partially-reducible",
            "smell-id": "partially-reducible",
            "smell-name": "Partially reducible",
            "smell-category": "design",
            "smell-severity": "medium",
            "smell-summary": "Most turns gather data that deterministic pre-steps could provide.",
            "smell-evidence": "agentic_fraction=0.18 turns=17",
            "smell-recommendation": "Move repository and alert collection into deterministic pre-steps.",
            organization: "githubnext",
            repository: "gh-aw-cao",
            workflow: ".github/workflows/dependabot-release-train-updater.md",
            run: "2004",
            "observed-at": "2026-08-29T09:40:00Z",
            "run-link": runLink("2004"),
          }],
          metadata: metadata("agent-smells-fixture"),
        },
        "workflow-smells": {
          source: "workflow-smells",
          rows: [{
            "smell-observation-id": "workflow:release:strict-disabled",
            "smell-id": "strict-disabled",
            "smell-name": "Strict mode disabled",
            "smell-category": "configuration",
            "smell-severity": "high",
            "smell-summary": "Workflow validation is not configured to fail closed.",
            "smell-recommendation": "Enable strict mode and recompile the workflow.",
            organization: "octo-org",
            repository: "octo-repo",
            workflow: ".github/workflows/release.yml",
            "observed-at": "2026-08-29T09:30:00Z",
            "repository-link": { relation: "repository", href: "https://github.com/octo-org/octo-repo", label: "Open octo-org/octo-repo" },
          }],
          metadata: metadata("workflow-smells-fixture"),
        },
        "security-findings": {
          source: "security-findings",
          rows: [{
            "smell-observation-id": "threat-detection:1002:prompt-injection",
            "smell-id": "threat-detection-prompt-injection",
            "smell-name": "Prompt injection detected",
            "smell-category": "trust-and-security",
            "smell-severity": "high",
            "smell-summary": "Threat detection reported untrusted instructions in workflow context.",
            "smell-recommendation": "Review the run evidence and remove the untrusted instruction path.",
            organization: "github",
            repository: "mona-tools",
            workflow: ".github/workflows/codeql.yml",
            run: "1002",
            "observed-at": "2026-08-29T09:20:00Z",
            "run-link": runLink("1002"),
          }],
          metadata: metadata("security-findings-fixture"),
        },
        "control-plane-smells": {
          source: "control-plane-smells",
          rows: [{
            "smell-observation-id": "control-plane:aw-doctor:inventory-incomplete",
            "smell-id": "inventory-incomplete",
            "smell-name": "Package inventory incomplete",
            "smell-category": "control-plane",
            "smell-severity": "high",
            "smell-recommendation": "Restore the worker source and compile its lock file.",
            organization: "githubnext",
            repository: "gh-aw-cao",
            workflow: ".github/workflows/aw-doctor.md",
            "observed-at": "2026-08-29T09:10:00Z",
            "repository-link": { relation: "repository", href: "https://github.com/githubnext/gh-aw-cao", label: "Open githubnext/gh-aw-cao" },
          }],
          metadata: metadata("control-plane-smells-fixture"),
        },
        "evidence-records": {
          source: "evidence-records",
          rows: [
            {
              "evidence-id": "evidence:dependabot:74:checks",
              "evidence-class": "observed",
              "evidence-kind": "verification",
              "work-item-id": "dependabot:github/gh-aw:release-train-2026-09-05",
              objective: "Update the Dependabot release train",
              claim: "Three required validations passed and security review is pending.",
              "verification-state": "pending",
              "provenance-state": "complete",
              "source-revision": "sha256:dependabot123",
              "observed-at": "2026-08-29T09:55:00Z",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/gh-aw/pull/74", label: "Review dependency evidence" },
              "repository-link": { relation: "repository", href: "https://github.com/github/gh-aw", label: "Open github/gh-aw" },
              "run-link": runLink("2002"),
            },
            {
              "evidence-id": "evidence:mona-tools:authority",
              "evidence-class": "observed",
              "evidence-kind": "authority",
              "work-item-id": "aw-doctor:github/mona-tools:upgrade-2026-09-05",
              objective: "Upgrade agentic workflow dependencies",
              claim: "No matching live target-authority declaration was observed.",
              "verification-state": "not-applicable",
              "provenance-state": "complete",
              "source-revision": "sha256:authority456",
              "observed-at": "2026-08-29T09:50:00Z",
              "evidence-link": runLink("2003"),
              "repository-link": { relation: "repository", href: "https://github.com/github/mona-tools", label: "Open github/mona-tools" },
              "run-link": runLink("2003"),
            },
            {
              "evidence-id": "evidence:aic:attribution",
              "evidence-class": "derived",
              "evidence-kind": "usage-attribution",
              "work-item-id": "optimization:githubnext/gh-aw-cao:aic-2026-09-05",
              objective: "Reduce AI Credit usage without reducing accepted outcomes",
              claim: "Usage attribution is partial for two worker runs.",
              "verification-state": "pending",
              "provenance-state": "partial",
              "source-revision": "sha256:usage789",
              "observed-at": "2026-08-29T09:45:00Z",
              "evidence-link": runLink("1001"),
              "repository-link": { relation: "repository", href: "https://github.com/githubnext/gh-aw-cao", label: "Open githubnext/gh-aw-cao" },
              "run-link": runLink("1001"),
            },
          ],
          metadata: metadata("evidence-records-fixture"),
        },
        outcomes: {
          source: "outcomes",
          rows: [
            { organization: "github", repository: "gh-aw", package: "dependabot", "runtime-repository": "githubnext/gh-aw-cao", workflow: ".github/workflows/dependabot.md", run: "2002", "safe-output": "dependabot-review", "outcome-state": "accepted", "rollout-mode": "review", "observed-at": "2026-08-29T08:40:00Z", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/2002", label: "View run 2002" } },
            { organization: "github", repository: "gh-aw-cao", workflow: ".github/workflows/daily.yml", run: "1001", "outcome-state": "pending", "run-link": { relation: "run", href: "https://github.com/githubnext/gh-aw-cao/actions/runs/1001", label: "View run 1001" } },
            { organization: "github", repository: "mona-tools", workflow: ".github/workflows/review.yml", run: "1002", "outcome-state": "rejected", "run-link": { relation: "run", href: "https://github.com/githubnext/mona-tools/actions/runs/1002", label: "View run 1002" } },
          ],
          metadata: metadata("outcomes-fixture"),
        },
        usage: {
          source: "usage",
          rows: [
            { organization: "github", repository: "gh-aw-cao", workflow: ".github/workflows/daily.yml", run: "1001", invocation: "u1", engine: "gpt", "requested-model": "gpt-4o", "resolved-model": "gpt-4.1", "rollout-mode": "live", "input-tokens": 100, "output-tokens": 50, "cache-read-tokens": 20, "cache-write-tokens": 10, "reasoning-tokens": 5, aic: 3.5, "observed-at": "2026-08-29T09:05:00Z" },
            { organization: "github", repository: "mona-tools", workflow: ".github/workflows/review.yml", run: "1002", invocation: "u2", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "rollout-mode": "review", "input-tokens": 200, "output-tokens": 80, "cache-read-tokens": 40, "cache-write-tokens": 15, "reasoning-tokens": 7, aic: 4.5, "observed-at": "2026-08-29T09:35:00Z" },
            { organization: "octo-org", repository: "octo-repo", workflow: ".github/workflows/nightly.yml", run: "2001", invocation: "u3", engine: "claude", "requested-model": "claude-3.5", "resolved-model": "claude-3.5", "rollout-mode": "live", "input-tokens": 150, "output-tokens": 60, "cache-read-tokens": 30, "cache-write-tokens": 12, "reasoning-tokens": 9, aic: 2.25, "observed-at": "2026-08-29T08:05:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/aw-doctor.md", run: "2003", invocation: "u4", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "rollout-mode": "review", "input-tokens": null, "output-tokens": null, "cache-read-tokens": null, "cache-write-tokens": null, "reasoning-tokens": null, aic: 23.9, "observed-at": "2026-08-29T07:35:00Z" },
            { organization: "githubnext", repository: "gh-aw-cao", workflow: ".github/workflows/dependabot.md", run: "2002", invocation: "u5", engine: "gpt", "requested-model": "gpt-4o-mini", "resolved-model": "gpt-4o-mini", "rollout-mode": "review", "input-tokens": null, "output-tokens": null, "cache-read-tokens": null, "cache-write-tokens": null, "reasoning-tokens": null, aic: 28.3, "observed-at": "2026-08-29T08:35:00Z" },
          ],
          metadata: metadata("usage-fixture", { completeness: "partial", "coverage-start": "2026-08-28T19:00:00Z", "coverage-end": "2026-08-29T19:00:00Z" }),
        },
        "coverage-diagnostics": {
          source: "coverage-diagnostics",
          rows: [
            { title: "Private repository discovery is off", effect: "Private repositories are excluded from workflow inventory and run-health totals." },
            { title: "AIC telemetry is partial", effect: "AI Credit totals exclude runs whose usage artifacts could not be collected." },
          ],
          metadata: metadata("coverage-diagnostics-fixture"),
        },
        findings: {
          source: "findings",
          rows: [
            {
              finding: "f-1",
              "finding-kind": "authored-warning",
              "finding-summary": "Workflow retried more than expected during rollout.",
              "finding-severity": "medium",
              "finding-status": "open",
              organization: "github",
              repository: "mona-tools",
              workflow: ".github/workflows/review.yml",
              "observed-at": "2026-08-29T09:40:00Z",
              "issue-link": { relation: "issue", href: "https://github.com/githubnext/mona-tools/issues/42", label: "View issue 42" },
              "external-link": { relation: "external", href: "https://github.com/githubnext/mona-tools/issues/42", label: "View warning output" },
            },
          ],
          metadata: metadata("findings-fixture"),
        },
        "grader-observations": {
          source: "grader-observations",
          rows: [
            { grader: "issue-resolution-rate", run: "1001", status: "pass", value: 0.82, "maturity-status": "matured", "baseline-value": 0.77, "delta-from-baseline": 0.05, "evaluator-digest": "sha256:abc123", "observed-at": "2026-08-29T09:10:00Z", "run-link": runLink("1001") },
            { grader: "issue-resolution-rate", run: "998", status: "pass", value: 0.58, "maturity-status": "matured", "baseline-value": 0.61, "delta-from-baseline": -0.03, "evaluator-digest": "sha256:def456", "observed-at": "2026-08-27T09:10:00Z", "run-link": runLink("998") },
            { grader: "issue-resolution-rate", run: "999", status: "pass", value: 0.71, "maturity-status": "matured", "baseline-value": 0.69, "delta-from-baseline": 0.02, "evaluator-digest": "sha256:ghi789", "observed-at": "2026-08-28T09:10:00Z", "run-link": runLink("999") },
            { grader: "review-quality", run: "1002", status: "pass", value: 0.76, "maturity-status": "interim", "baseline-value": 0.72, "delta-from-baseline": 0.04, "evaluator-digest": "sha256:jkl012", "observed-at": "2026-08-29T10:10:00Z", "run-link": runLink("1002") },
            { grader: "missing-value", run: "Unavailable", status: "unavailable", value: null, "maturity-status": "unavailable", "baseline-value": null, "delta-from-baseline": null, "evaluator-digest": "" },
          ],
          metadata: metadata("grader-observations-fixture"),
        },
        "operational-values": {
          source: "operational-values",
          rows: [
            {
              "observed-at": "2026-08-10T08:30:00Z",
              "operational-value": 0,
              "operational-value-definition": "validated-dependency-resolution",
              "operational-case": "dependency-pr:github/example-api:41",
              "evaluator-digest": "sha256:dependabot123",
              organization: "githubnext",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/dependabot-release-train-updater.md",
              run: "3001",
              "requested-evidence-at": "2026-07-27T08:30:00Z",
              "evidence-cutoff": "2026-08-10T08:30:00Z",
              "maturity-at": "2026-08-10T08:30:00Z",
              "maturity-status": "matured",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/example-api/pull/41", label: "View dependency pull request 41" },
              "run-link": runLink("3001"),
            },
            {
              "observed-at": "2026-08-17T08:30:00Z",
              "operational-value": 0,
              "operational-value-definition": "validated-dependency-resolution",
              "operational-case": "dependency-pr:github/example-web:52",
              "evaluator-digest": "sha256:dependabot123",
              organization: "githubnext",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/dependabot-release-train-updater.md",
              run: "3002",
              "requested-evidence-at": "2026-08-03T08:30:00Z",
              "evidence-cutoff": "2026-08-17T08:30:00Z",
              "maturity-at": "2026-08-17T08:30:00Z",
              "maturity-status": "matured",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/example-web/pull/52", label: "View dependency pull request 52" },
              "run-link": runLink("3002"),
            },
            {
              "observed-at": "2026-08-24T08:30:00Z",
              "operational-value": 1,
              "operational-value-definition": "validated-dependency-resolution",
              "operational-case": "dependency-pr:github/example-cli:63",
              "evaluator-digest": "sha256:dependabot123",
              organization: "githubnext",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/dependabot-release-train-updater.md",
              run: "3003",
              "requested-evidence-at": "2026-08-10T08:30:00Z",
              "evidence-cutoff": "2026-08-24T08:30:00Z",
              "maturity-at": "2026-08-24T08:30:00Z",
              "maturity-status": "matured",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/example-cli/pull/63", label: "View dependency pull request 63" },
              "run-link": runLink("3003"),
            },
            {
              "observed-at": "2026-08-31T08:30:00Z",
              "operational-value": 1,
              "operational-value-definition": "validated-dependency-resolution",
              "operational-case": "dependency-pr:github/example-sdk:74",
              "evaluator-digest": "sha256:dependabot123",
              organization: "githubnext",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/dependabot-release-train-updater.md",
              run: "3004",
              "requested-evidence-at": "2026-08-17T08:30:00Z",
              "evidence-cutoff": "2026-08-31T08:30:00Z",
              "maturity-at": "2026-08-31T08:30:00Z",
              "maturity-status": "matured",
              "evidence-link": { relation: "evidence", href: "https://github.com/github/example-sdk/pull/74", label: "View dependency pull request 74" },
              "run-link": runLink("3004"),
            },
            {
              "observed-at": "2026-08-29T09:10:00Z",
              "operational-value": 0.82,
              "operational-value-definition": "issue-resolution-rate",
              "operational-case": "triage",
              "evaluator-digest": "sha256:abc123",
              organization: "github",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/daily.yml",
              run: "1001",
              "requested-evidence-at": "2026-08-29T09:00:00Z",
              "evidence-cutoff": "2026-08-29T09:05:00Z",
              "maturity-at": "2026-08-29T09:15:00Z",
              "maturity-status": "matured",
              "delta-from-baseline": 0.05,
              "evidence-link": { relation: "evidence", href: "https://github.com/githubnext/gh-aw-cao/issues/201", label: "View evidence issue 201" },
              "run-link": runLink("1001"),
            },
            {
              "observed-at": "2026-08-27T09:10:00Z",
              "operational-value": 0.58,
              "operational-value-definition": "issue-resolution-rate",
              "operational-case": "triage",
              "evaluator-digest": "sha256:def456",
              organization: "github",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/daily.yml",
              run: "998",
              "requested-evidence-at": "2026-08-27T09:00:00Z",
              "evidence-cutoff": "2026-08-27T09:05:00Z",
              "maturity-at": "2026-08-27T09:15:00Z",
              "maturity-status": "matured",
              "delta-from-baseline": -0.03,
              "evidence-link": { relation: "evidence", href: "https://github.com/githubnext/gh-aw-cao/issues/198", label: "View evidence issue 198" },
              "run-link": runLink("998"),
            },
            {
              "observed-at": "2026-08-28T09:10:00Z",
              "operational-value": 0.71,
              "operational-value-definition": "issue-resolution-rate",
              "operational-case": "triage",
              "evaluator-digest": "sha256:ghi789",
              organization: "github",
              repository: "gh-aw-cao",
              workflow: ".github/workflows/daily.yml",
              run: "999",
              "requested-evidence-at": "2026-08-28T09:00:00Z",
              "evidence-cutoff": "2026-08-28T09:05:00Z",
              "maturity-at": "2026-08-28T09:15:00Z",
              "maturity-status": "matured",
              "delta-from-baseline": 0.02,
              "evidence-link": { relation: "evidence", href: "https://github.com/githubnext/gh-aw-cao/issues/199", label: "View evidence issue 199" },
              "run-link": runLink("999"),
            },
            {
              "observed-at": "2026-08-29T10:10:00Z",
              "operational-value": 0.76,
              "operational-value-definition": "review-quality",
              "operational-case": "review",
              "evaluator-digest": "sha256:jkl012",
              organization: "github",
              repository: "mona-tools",
              workflow: ".github/workflows/review.yml",
              run: "1002",
              "requested-evidence-at": "2026-08-29T10:00:00Z",
              "evidence-cutoff": "2026-08-29T10:05:00Z",
              "maturity-at": "2026-08-29T10:15:00Z",
              "maturity-status": "interim",
              "delta-from-baseline": 0.04,
              "evidence-link": { relation: "evidence", href: "https://github.com/githubnext/mona-tools/pull/43", label: "View evidence pull request 43" },
              "run-link": runLink("1002"),
            },
          ],
          metadata: metadata("operational-values-fixture"),
        },
      });

      /**
       * @param {Record<string, unknown>} sources
       * @param {boolean} [ingest]
       * @returns {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>}
       */
      async function withCanonicalViewSources(sources, ingest = false) {
        return /** @type {Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} */ (loadCanonicalViewSources(window.indexedDB, sources, {
          ingest,
          storage: navigator.storage,
        }));
      }

      if (new URLSearchParams(window.location.search).has("fixtures")) {
        const fixtureProjection = await withCanonicalViewSources(fixtureSources, true);
        renderSources({
          ...fixtureProjection,
          ...await processDashboardQueries(dashboardQueries, fixtureProjection),
        });
        loadingProgress.complete();
        cancelCommand.complete();
      } else {
        renderSources({}, "loading");
        const sourceUrl = new URL("./gh-aw-logs.jsonl", window.location.href).href;
        const stopAutomaticDataUpdates = startAutomaticDashboardDataUpdates([
          sourceUrl,
          new URL("./inventory-sources.json", sourceUrl).href,
        ]);
        window.addEventListener("pagehide", (event) => {
          if (!event.persisted) stopAutomaticDataUpdates();
        });
        /** @type {Record<string, import('./presenter.js').LogicalSourceInput> | null} */
        let cachedSources = null;

        try {
          const initialPageId = dashboardDocument.dashboard.pages.find((page) => page.id !== "configuration")?.id
            ?? dashboardDocument.dashboard.pages[0]?.id
            ?? "";
          const dashboardContext = {
            githubUrlBase: dashboardDocument.dashboard["github-url-base"],
            dashboardRepository: dashboardDocument.dashboard.repository,
            pages: dashboardDocument.dashboard.pages,
            queries: dashboardQueries,
          };
          /**
           * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
           * @param {string[]} sourceNames
           */
          const bindContinuations = (sources, sourceNames) => bindSourceContinuations(
            sources,
            sourceNames,
            (requested, pagination) => runWithLoadingProgress(
              () => loadCanonicalDashboardPage(requested, dashboardContext, pagination),
            ),
          );
          /** @param {string} pageId */
          const loadPageSources = async (pageId) => {
            const sourceNames = dashboardPageSourceNames(dashboardDocument, pageId);
            const lazySources = dashboardPageLazySourceNames(dashboardDocument, pageId);
            return runWithLoadingProgress(async () => bindContinuations(
              await loadCanonicalDashboardPage(
                sourceNames,
                dashboardContext,
                continuationRequests(lazySources),
              ),
              lazySources,
            ));
          };
          const initialSources = dashboardPageSourceNames(dashboardDocument, initialPageId);
          const initialLazySources = dashboardPageLazySourceNames(dashboardDocument, initialPageId);
          const loadHorizonSources = () => runWithLoadingProgress(
            () => loadCanonicalDashboardPage(
              DATABASE_COUNT_SOURCE_NAMES,
              dashboardContext,
            ),
          );
          /**
           * @param {(sourceNames: string[], pagination: Record<string, { limit: number, continuationToken?: string }>) => Promise<Record<string, import('./presenter.js').LogicalSourceInput>>} load
           */
          const loadInitialSources = async (load) => bindContinuations(
            await load(
              initialSources,
              continuationRequests(initialLazySources),
            ),
            initialLazySources,
          );
          try {
            cachedSources = await loadInitialSources(
              (requested, pagination) => loadCanonicalDashboardPage(requested, dashboardContext, pagination),
            );
          } catch {
            // An empty or incompatible database is rebuilt from the published sources below.
          }

          if (cachedSources) {
            const displayedSources = cachedSources;
            const refreshPagination = continuationRequests(initialLazySources);
            const refreshOwner = new AbortController();
            window.addEventListener("pagehide", (event) => {
              if (!event.persisted) refreshOwner.abort();
            });
            let refreshFailed = false;
            let refreshPending = false;
            /** @param {unknown} error */
            const showStaleSources = (error) => {
              if (refreshFailed) return;
              refreshFailed = true;
              refreshPending = false;
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Unable to refresh live dashboard data: ${message}`);
              emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
                kind: "refresh",
                status: "failed",
                message,
              });
              updateWithViewTransition(
                document,
                () => renderSources(displayedSources, "stale", true, loadPageSources, loadHorizonSources, refreshSources),
              );
            };
            const refreshSources = () => {
              if (refreshPending) return;
              refreshFailed = false;
              refreshPending = true;
              emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
                kind: "refresh",
                status: "started",
              });
              renderSources(displayedSources, "cached", true, loadPageSources, loadHorizonSources);
              void runWithLoadingProgress(() => refreshCanonicalDashboardSources(
                sourceUrl,
                initialSources,
                dashboardContext,
                refreshPagination,
              )).then(
                ({ changed }) => {
                  refreshPending = false;
                  emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
                    kind: "refresh",
                    status: "completed",
                    changed,
                  });
                  if (changed) return;
                  renderSources(displayedSources, "ready", true, loadPageSources, loadHorizonSources);
                },
                showStaleSources,
              );
            };
            refreshSources();
            loadingProgress.complete();
            cancelCommand.complete();
            subscribeCanonicalDashboardView(
              `page:${initialPageId}`,
              initialSources,
              dashboardContext,
              (sources) => updateWithViewTransition(
                document,
                () => renderSources(
                  bindContinuations(sources, initialLazySources),
                  "ready",
                  true,
                  loadPageSources,
                  loadHorizonSources,
                ),
              ),
              refreshPagination,
              { signal: refreshOwner.signal, onError: showStaleSources, emitCurrent: false },
            );
          } else {
            renderSources(
              await loadInitialSources(
                (requested, pagination) => loadCanonicalDashboardSources(
                  sourceUrl,
                  requested,
                  dashboardContext,
                  pagination,
                ),
              ),
              "ready",
              true,
              loadPageSources,
              loadHorizonSources,
            );
            emitDashboardDebugEvent(document, DASHBOARD_DATA_EVENT, {
              kind: "initial-load",
              status: "completed",
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = new Error(`Unable to load live dashboard data: ${message}`, { cause: error });
          root.textContent = failure.message;
          throw failure;
        } finally {
          if (!cachedSources) {
            loadingProgress.complete();
            cancelCommand.complete();
          }
        }
      }
