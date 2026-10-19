import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startDashboardServer } from "../helpers/native-dashboard.mjs";

/**
 * Own the editable site copy for the complete native server lifecycle.
 * @param {import("../helpers/native-dashboard.mjs").DashboardServerOptions} options
 */
export async function startDashboardSiteFixture(options) {
  const scratch = fileURLToPath(new URL("../../.tmp/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const workspace = await mkdtemp(join(scratch, "cao-dashboard-e2e-"));
  const source = fileURLToPath(new URL("../../dashboard/site/", import.meta.url));
  /** @type {Awaited<ReturnType<typeof startDashboardServer>> | undefined} */
  let server;
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => closing ??= (async () => {
    try {
      await server?.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  })();
  try {
    await cp(source, join(workspace, "site"), {
      recursive: true,
      filter: (path) => !["node_modules", "dist", ".tmp", "test", "test-results", "scripts"]
        .includes(relative(source, path).split(sep)[0]),
    });
    server = await startDashboardServer({
      ...options,
      workingDirectory: workspace,
      siteRoot: join(workspace, "site"),
    });
    return { url: server.url, workspace, close };
  } catch (error) {
    await close();
    throw error;
  }
}
