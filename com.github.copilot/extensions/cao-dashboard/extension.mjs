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
        properties: {
          repository: {
            type: "string",
            description:
              "Optional GitHub repository in OWNER/REPOSITORY format. Defaults to the current repository.",
          },
          sitePath: {
            type: "string",
            description:
              "Optional relative path within the repository's Pages site.",
          },
          url: {
            type: "string",
            format: "uri",
            description:
              "Optional deployed HTTPS site URL. Overrides repository and sitePath.",
          },
        },
        additionalProperties: false,
      },
      open: async (context) => {
        try {
          const input =
            context.input &&
            typeof context.input === "object" &&
            !Array.isArray(context.input)
              ? context.input
              : {};
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
