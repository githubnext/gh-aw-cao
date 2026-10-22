import { joinSession } from "@github/copilot-sdk/extension";
import { createDashboardExtension } from "./dashboard-extension.mjs";
import { approveDashboardCommand } from "./approval.mjs";

const { config, closePreviews } = createDashboardExtension({
  approveCommand: approveDashboardCommand,
  executeSessionTool: (request) => session.rpc.tools.execute(request),
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

const session = await joinSession(config);
