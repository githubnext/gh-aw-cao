import {
  CanvasError,
  createCanvas,
  joinSession,
} from "@github/copilot-sdk/extension";

import {
  executeDashboardQueryRequest,
  readDashboardDataSpecification,
} from "./dashboard-agent-tools.mjs";
import { startLocalDashboardPreview } from "./local-preview.mjs";

const previews = new Map();
let dashboardWorkingDirectory = process.cwd();

await joinSession({
  tools: [
    {
      name: "cao_dashboard_execute_query",
      description:
        "Execute declarative Dashboard Language queries with the canonical CAO dashboard query engine against supplied logical source rows.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            minItems: 1,
            description:
              "Dashboard Language query definitions in dependency order.",
            items: { type: "object" },
          },
          sources: {
            type: "object",
            minProperties: 1,
            description:
              "Logical sources keyed by source name. Each value may be a row array or an object containing rows and optional metadata.",
            additionalProperties: {
              oneOf: [
                { type: "array", items: { type: "object" } },
                {
                  type: "object",
                  properties: {
                    source: { type: "string" },
                    rows: { type: "array", items: { type: "object" } },
                    metadata: { type: "object" },
                  },
                  required: ["rows"],
                  additionalProperties: true,
                },
              ],
            },
          },
          requested: {
            type: "array",
            uniqueItems: true,
            items: { type: "string" },
            description:
              "Optional query names to execute. Dependencies are resolved automatically.",
          },
        },
        required: ["queries", "sources"],
        additionalProperties: false,
      },
      handler: async (input) =>
        executeDashboardQueryRequest({
          workingDirectory: dashboardWorkingDirectory,
          ...input,
        }),
    },
    {
      name: "cao_dashboard_read_data_specification",
      description:
        "Read a numbered line range from the canonical CAO dashboard data architecture specification.",
      parameters: {
        type: "object",
        properties: {
          startLine: {
            type: "integer",
            minimum: 1,
            description: "First line to read. Defaults to 1.",
          },
          endLine: {
            type: "integer",
            minimum: 1,
            description:
              "Last line to read, inclusive. Defaults to 200 lines after startLine and is limited to 400 lines per call.",
          },
        },
        additionalProperties: false,
      },
      handler: async (input) =>
        readDashboardDataSpecification({
          workingDirectory: dashboardWorkingDirectory,
          ...input,
        }),
    },
  ],
  hooks: {
    onSessionStart: async (input) => {
      dashboardWorkingDirectory = input.workingDirectory;
      return {
        additionalContext:
          "For CAO dashboard data-model or query work, read the relevant sections of the canonical dashboard data specification with cao_dashboard_read_data_specification before making architectural assumptions. Use cao_dashboard_execute_query to evaluate Dashboard Language queries instead of reimplementing query semantics.",
      };
    },
  },
  canvases: [
    createCanvas({
      id: "cao-dashboard",
      displayName: "Central Agentic Ops",
      description:
        "Open a local Central Agentic Ops dashboard preview for the current or a specified repository.",
      inputSchema: {
        type: "object",
        properties: {
          repository: {
            type: "string",
            pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
            maxLength: 200,
            description:
              "Optional GitHub repository in OWNER/REPOSITORY format. Defaults to the current repository.",
          },
        },
        additionalProperties: false,
      },
      open: async (context) => {
        try {
          dashboardWorkingDirectory =
            context.session?.workingDirectory ?? dashboardWorkingDirectory;
          const existing = previews.get(context.instanceId);
          if (existing) {
            return {
              title: "Central Agentic Ops",
              status: "Local preview",
              url: existing.url,
            };
          }

          const input = context.input ?? {};
          const preview = await startLocalDashboardPreview({
            workingDirectory:
              context.session?.workingDirectory ?? process.cwd(),
            repository: input.repository,
          });
          previews.set(context.instanceId, preview);
          return {
            title: "Central Agentic Ops",
            status: "Local preview",
            url: preview.url,
          };
        } catch (error) {
          throw new CanvasError(
            "cao_dashboard_preview_unavailable",
            error instanceof Error
              ? error.message
              : "Could not start the local CAO dashboard preview.",
          );
        }
      },
      onClose: async (context) => {
        const preview = previews.get(context.instanceId);
        if (!preview) return;

        previews.delete(context.instanceId);
        await preview.close();
      },
    }),
  ],
});

process.once("exit", () => {
  for (const preview of previews.values()) void preview.close();
});
