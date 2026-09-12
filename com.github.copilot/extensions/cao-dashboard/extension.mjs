import {
  CanvasError,
  createCanvas,
  joinSession,
} from "@github/copilot-sdk/extension";

import { startLocalDashboardPreview } from "./local-preview.mjs";

const previews = new Map();

await joinSession({
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
