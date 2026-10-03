import { joinSession } from "@github/copilot-sdk/extension";
import { createDashboardExtension } from "./dashboard-extension.mjs";
import { approveDashboardCommand } from "./approval.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession | undefined} */
let session;
const { config, closePreviews } = createDashboardExtension({
  approveCommand: (request) => approveDashboardCommand(session, request),
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void closePreviews().then(
    () => process.exit(0),
    () => {
      console.error("CAO dashboard preview cleanup failed.");
      process.exit(1);
    },
  );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

session = await joinSession(config);
