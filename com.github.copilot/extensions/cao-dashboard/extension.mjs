import {
  CanvasError,
  createCanvas,
  joinSession,
} from "@github/copilot-sdk/extension";

import { resolveDashboardUrl } from "./dashboard-url.mjs";

await joinSession({
  canvases: [
    createCanvas({
      id: "cao-dashboard",
      displayName: "Central Agentic Ops",
      description:
        "Open the deployed Central Agentic Ops Pages site for the current or a specified repository.",
      inputSchema: {
        type: "object",
        oneOf: [
          {
            properties: {
              url: {
                type: "string",
                format: "uri",
                minLength: 1,
                maxLength: 2_048,
                description: "Deployed HTTPS dashboard URL.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
          {
            properties: {
              repository: {
                type: "string",
                pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
                maxLength: 200,
                description:
                  "Optional GitHub repository in OWNER/REPOSITORY format. Defaults to the current repository.",
              },
              sitePath: {
                type: "string",
                pattern: "^[A-Za-z0-9._~/-]*$",
                maxLength: 1_024,
                description:
                  "Optional relative path within the repository's Pages site.",
              },
            },
            additionalProperties: false,
          },
        ],
      },
      open: async (context) => {
        try {
          const input = context.input ?? {};
          const url = await resolveDashboardUrl(input, {
            cwd: context.session?.workingDirectory ?? process.cwd(),
          });
          return {
            title: "Central Agentic Ops",
            status: new URL(url).hostname,
            url,
          };
        } catch (error) {
          throw new CanvasError(
            "cao_dashboard_url_unavailable",
            error instanceof Error
              ? error.message
              : "Could not resolve the deployed CAO dashboard URL.",
          );
        }
      },
    }),
  ],
});
