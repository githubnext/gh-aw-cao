import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLocalDashboardPreview } from "../../com.github.copilot/extensions/cao-dashboard/local-preview.mjs";

const extensionUrl = new URL("../../com.github.copilot/extensions/cao-dashboard/extension.mjs", import.meta.url);

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "cao-canvas-test-")));
  const ghExecutable = join(workspace, "gh");
  await writeFile(ghExecutable, `#!${process.execPath}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.cwd() !== ${JSON.stringify(workspace)}) process.exit(4);
const args = process.argv.slice(2);
if (args[0] === "api") {
  if (args[1].endsWith("/actions/runs/42")) {
    process.stdout.write("success\\tmain\\t.github/workflows/cao-dashboard.yml\\n");
  } else if (args[1].includes("/actions/artifacts?")) {
    process.stdout.write("42\\n");
  } else {
    process.stdout.write("main\\n");
  }
} else if (args[0] === "run" && args[1] === "download") {
  const destination = args[args.indexOf("--dir") + 1];
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "sources.json"), JSON.stringify({
    repositories: { rows: [{ repository: "acme/control" }] }
  }));
} else {
  process.exit(3);
}
`);
  // Node treats an extensionless executable as CommonJS unless the fixture declares ESM.
  await writeFile(join(workspace, "package.json"), '{"type":"module"}');
  await chmod(ghExecutable, 0o755);
  return { workspace, ghExecutable };
}

async function previewDirectories(workspace) {
  return (await readdir(workspace)).filter((name) => name.startsWith(".cao-dashboard-preview-"));
}

test("plugin canvas stages its site inside a foreign workspace and cleans up", {
  skip: process.platform === "win32",
}, async () => {
  const { workspace, ghExecutable } = await fixture();
  let preview;
  try {
    preview = await startLocalDashboardPreview({
      workingDirectory: workspace,
      repository: "acme/control",
      executeCliAction: async () => {},
      approveCliAction: async () => false,
      ghExecutable,
    });
    assert.equal(new URL(preview.url).hostname, "127.0.0.1");
    const response = await fetch(preview.url);
    assert.equal(response.status, 200);
    assert.equal(new URL(response.url).searchParams.get("local-preview"), "canvas");
    assert.match(await response.text(), /src\/main\.js/);
    const base = new URL(`${preview.url}/`);
    assert.equal((await fetch(new URL("src/main.js", base))).status, 200);
    const document = await (await fetch(new URL("dashboard.json", base))).json();
    assert.equal(document.dashboard.repository, "acme/control");
    assert.ok(document.dashboard.pages.length > 0);
    assert.deepEqual(await (await fetch(new URL("sources/repositories.json", base))).json(), {
      rows: [{ repository: "acme/control" }],
    });
    assert.equal((await previewDirectories(workspace)).length, 2);
    await preview.close();
    await preview.close();
    assert.deepEqual(await previewDirectories(workspace), []);
    await assert.rejects(fetch(preview.url));
  } finally {
    await preview?.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

for (const layout of ["dashboard", ".github/aw/dashboard"]) {
  test(`canvas ignores executable code and site assets in the ${layout} workspace layout`, {
    skip: process.platform === "win32",
  }, async () => {
    const { workspace, ghExecutable } = await fixture();
    const dashboardDirectory = join(workspace, layout);
    let preview;
    try {
      await mkdir(dashboardDirectory, { recursive: true });
      await mkdir(join(dashboardDirectory, "site"), { recursive: true });
      await writeFile(join(dashboardDirectory, "site", "index.html"), "workspace site must not be served");
      await writeFile(join(dashboardDirectory, "local-server.mjs"), `
throw new Error("Workspace server must never execute.");
`);
      preview = await startLocalDashboardPreview({
        workingDirectory: workspace,
        executeCliAction: async () => {},
        approveCliAction: async () => false,
        ghExecutable,
      });
      const response = await fetch(preview.url);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /workspace site must not be served/);
      assert.equal((await previewDirectories(workspace)).length, 2);
      await preview.close();
      assert.deepEqual(await previewDirectories(workspace), []);
    } finally {
      await preview?.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test("failed plugin canvas startup removes staged assets", {
  skip: process.platform === "win32",
}, async () => {
  const { workspace, ghExecutable } = await fixture();
  try {
    await writeFile(ghExecutable, `#!${process.execPath}\nprocess.exit(2);\n`);
    await assert.rejects(startLocalDashboardPreview({
      workingDirectory: workspace,
      executeCliAction: async () => {},
      approveCliAction: async () => false,
      ghExecutable,
    }), /Unable to query the dashboard data artifact/);
    assert.deepEqual(await previewDirectories(workspace), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("extension SIGTERM closes live previews before exiting", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async () => {
  const { workspace } = await fixture();
  const sdkUrl = import.meta.resolve("@github/copilot-sdk/extension");
  const shim = `export { CanvasError, createCanvas } from ${JSON.stringify(sdkUrl)};
export async function joinSession(config) {
  const preview = await config.canvases[0].open({
    sessionId: "test", extensionId: "test:cao", canvasId: "cao-dashboard",
    instanceId: "preview", session: { workingDirectory: process.cwd() }
  });
  setImmediate(() => process.stdout.write(JSON.stringify(preview) + "\\n"));
}`;
  const shimUrl = `data:text/javascript,${encodeURIComponent(shim)}`;
  const preload = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  return specifier === "@github/copilot-sdk/extension"
    ? { url: ${JSON.stringify(shimUrl)}, shortCircuit: true }
    : next(specifier, context);
} });`;
  const child = spawn(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(extensionUrl),
  ], {
    cwd: workspace,
    env: { ...process.env, PATH: `${workspace}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  let exited = false;
  const exit = once(child, "exit").then((result) => { exited = true; return result; });
  try {
    const line = await Promise.race([
      once(lines, "line").then(([line]) => line),
      exit.then(() => { throw new Error(`Extension exited before opening: ${stderr}`); }),
    ]);
    const { url } = JSON.parse(line);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await previewDirectories(workspace)).length, 2);
    child.kill("SIGTERM");
    const [code, signal] = await exit;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.deepEqual(await previewDirectories(workspace), []);
  } finally {
    lines.close();
    if (!exited) {
      child.kill("SIGTERM");
      await exit;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
