import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function startLocalDashboardPreview({
  workingDirectory,
  repository,
}) {
  const localServerPath = await findLocalServer(workingDirectory);
  const localServer = await import(pathToFileURL(localServerPath).href);
  if (typeof localServer.startDashboardServer !== "function") {
    throw new Error(
      "dashboard/local-server.mjs does not export startDashboardServer.",
    );
  }

  return localServer.startDashboardServer({
    workingDirectory,
    repository,
    port: 0,
    output: () => {},
    requestOutput: () => {},
    traceOutput: () => {},
  });
}

async function findLocalServer(workingDirectory) {
  const extensionDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(workingDirectory, "dashboard", "local-server.mjs"),
    join(workingDirectory, ".github", "aw", "dashboard", "local-server.mjs"),
    resolve(extensionDirectory, "../../../dashboard/local-server.mjs"),
  ];

  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported installation layout.
    }
  }
  throw new Error(
    "Could not find dashboard/local-server.mjs in the workspace or installed plugin.",
  );
}
