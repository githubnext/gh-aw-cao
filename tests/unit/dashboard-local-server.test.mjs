import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isWithinCopilotFileRoots,
  shellPermissionRejection,
  startDashboardServer,
} from "../../dashboard/local-server.mjs";

const dashboard = (pageId, cliActions) => JSON.stringify({
  "language-version": "0.1.0",
  dashboard: {
    id: "preview",
    title: "Preview",
    ...(cliActions ? { "cli-actions": cliActions } : {}),
    navigation: [{ label: "Preview", pages: [pageId] }],
    pages: [{
      id: pageId,
      title: pageId,
      kind: "custom",
      views: [{
        id: "summary",
        title: "Summary",
        mark: "element",
        element: "summary-grid",
        data: { sources: ["repositories"] },
      }],
    }],
  },
}, null, 2);

function shellPermission(fullCommandText, identifiers) {
  return {
    fullCommandText,
    hasWriteFileRedirection: false,
    possiblePaths: [],
    possibleUrls: [],
    commands: identifiers.map((identifier) => ({ identifier, readOnly: true })),
    commandSegments: identifiers.map((identifier) => ({ identifier, fullCommandText })),
  };
}

test("Copilot shell policy allows safe text tools and rejects mutating sed", () => {
  assert.equal(shellPermissionRejection(shellPermission("echo ready", ["echo"])), null);
  assert.equal(shellPermissionRejection(shellPermission("cat dashboard.json", ["cat"])), null);
  assert.equal(
    shellPermissionRejection(shellPermission("sed -n '1,20p' dashboard.json", ["sed"])),
    null,
  );
  assert.match(
    shellPermissionRejection(shellPermission("sed -i 's/old/new/' dashboard.json", ["sed"])),
    /in-place/,
  );
  assert.match(
    shellPermissionRejection(shellPermission("sed 's/old/new/w output.json' dashboard.json", ["sed"])),
    /file-writing/,
  );
  assert.match(
    shellPermissionRejection({
      ...shellPermission("echo changed > dashboard.json", ["echo"]),
      hasWriteFileRedirection: true,
    }),
    /redirection/,
  );
});

test("Copilot file roots include the workspace and system temporary directory", () => {
  assert.equal(isWithinCopilotFileRoots("/workspace", "/tmp", "/workspace/dashboard.json"), true);
  assert.equal(isWithinCopilotFileRoots("/workspace", "/tmp", "/tmp/copilot-notes.json"), true);
  assert.equal(isWithinCopilotFileRoots("/workspace", "/tmp", "/etc/passwd"), false);
});

async function openDashboardSocket(previewUrl) {
  const url = new URL(previewUrl);
  url.protocol = "ws:";
  url.pathname += "/__dashboard_socket";
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

async function nextDashboard(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function nextSocketMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      resolve(message);
    };
    const onError = (error) => {
      socket.removeEventListener("message", onMessage);
      reject(error);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

async function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("local dashboard server composes package dashboards and reloads after updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const siteRoot = path.join(root, "site");
  const packageRoot = path.join(root, "packages");
  const packageDirectory = path.join(packageRoot, "example");
  const stalePreviewDirectory = path.join(packageRoot, ".cao-dashboard-preview-stale");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(stalePreviewDirectory, { recursive: true });
  await mkdir(siteRoot, { recursive: true });
  const syntheticToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  await writeFile(path.join(siteRoot, "index.html"), `<!doctype html><body>preview ${syntheticToken}</body>`);
  await writeFile(path.join(siteRoot, "guide.md"), `# Guide\n\n${syntheticToken}\n`);
  await writeFile(path.join(siteRoot, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(siteRoot, "private.txt"), "must not be served");
  await writeFile(path.join(siteRoot, "private"), "must not be served");
  const builtInDashboard = JSON.parse(dashboard("built-in"));
  builtInDashboard.dashboard.description = syntheticToken;
  await writeFile(path.join(siteRoot, "dashboard.json"), JSON.stringify(builtInDashboard));
  await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-one"));
  await writeFile(path.join(stalePreviewDirectory, "dashboard.json"), dashboard("built-in"));
  const downloadData = async (destination) => {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "sources.json"), JSON.stringify({
      repositories: {
        rows: [{
          token: syntheticToken,
          note: ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_"),
          detail: "x".repeat(2_048),
        }],
      },
    }));
  };
  const requestLogs = [];

  const preview = await startDashboardServer({
    siteRoot,
    catalogRoot: packageRoot,
    installedDashboardsDirectory: path.join(root, "installed-dashboards"),
    downloadData,
    loadViewer: async () => ({
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    }),
    allowMissingOrigin: true,
    workingDirectory: root,
    requestOutput: (message) => requestLogs.push(message),
    port: 0,
  });
  try {
    const indexResponse = await fetch(`${preview.url}/`);
    assert.equal(indexResponse.status, 200);
    assert.equal(new URL(indexResponse.url).searchParams.get("local-preview"), "enabled");
    const index = await indexResponse.text();
    assert.doesNotMatch(index, /location\.reload/);
    assert.doesNotMatch(index, /<script[^>]+src=.*copilot-prompt/);
    assert.doesNotMatch(index, new RegExp(syntheticToken));
    assert.match(index, /\[REDACTED\]/);
    const markdownResponse = await fetch(`${preview.url}/guide.md`);
    assert.equal(markdownResponse.status, 200);
    assert.equal(markdownResponse.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.doesNotMatch(await markdownResponse.text(), new RegExp(syntheticToken));
    const imageResponse = await fetch(`${preview.url}/image.png`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal((await fetch(`${preview.url}/private.txt`)).status, 404);
    assert.equal((await fetch(`${preview.url}/private`)).status, 404);
    assert.ok(requestLogs.some((message) => /^GET \/ 302 \d+ms$/.test(message)));

    const dashboardResponse = await fetch(`${preview.url}/dashboard.json`);
    assert.equal(dashboardResponse.headers.get("cache-control"), "no-store");
    const browserDashboard = await dashboardResponse.json();
    assert.ok(requestLogs.some((message) => /^GET \/dashboard\.json 200 \d+ms$/.test(message)));
    assert.deepEqual(
      browserDashboard.dashboard.pages.map(({ id }) => id),
      ["built-in", "package-one"],
    );
    assert.equal(browserDashboard.dashboard.description, "[REDACTED]");
    const sourcesResponse = await fetch(`${preview.url}/sources.json`);
    assert.deepEqual(await sourcesResponse.json(), {
      repositories: {
        rows: [{ token: "[REDACTED]", note: "[REDACTED]", detail: "x".repeat(2_048) }],
      },
    });
    const splitSourceResponse = await fetch(`${preview.url}/sources/repositories.json`);
    assert.equal(splitSourceResponse.headers.get("content-encoding"), "gzip");
    assert.deepEqual(await splitSourceResponse.json(), {
      rows: [{ token: "[REDACTED]", note: "[REDACTED]", detail: "x".repeat(2_048) }],
  });
    const viewerResponse = await fetch(`${preview.url}/viewer.json`);
    assert.deepEqual(await viewerResponse.json(), {
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    });

    test("repository skill discovery includes supported workspace skill directories", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-skills-"));
      await mkdir(path.join(root, ".github", "skills"), { recursive: true });
      await mkdir(path.join(root, ".agents", "skills"), { recursive: true });
      try {
        const { repositorySkillDirectories } = await import("../../dashboard/local-server.mjs");
        assert.deepEqual(await repositorySkillDirectories(root), [
          path.join(root, ".github", "skills"),
          path.join(root, ".agents", "skills"),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    const traversalResponse = await fetch(`${preview.url}/..%2Foutside.txt`);
    assert.equal(traversalResponse.status, 404);
    assert.equal(await requestWithHost(`${preview.url}/sources.json`, "attacker.example"), 400);
    const unprotectedUrl = new URL(preview.url);
    unprotectedUrl.pathname = "/sources.json";
    assert.equal((await fetch(unprotectedUrl)).status, 404);

    const socket = await openDashboardSocket(preview.url);
    const update = nextDashboard(socket);
    await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-two"));
    assert.deepEqual(
      (await update).dashboard.pages.map(({ id }) => id),
      ["built-in", "package-two"],
    );
    socket.close();

    const updatedResponse = await fetch(`${preview.url}/dashboard.json`);
    assert.deepEqual(
      (await updatedResponse.json()).dashboard.pages.map(({ id }) => id),
      ["built-in", "package-two"],
    );
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local dashboard server fails when dashboard data cannot be downloaded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in"));

  try {
    await assert.rejects(
      startDashboardServer({
        siteRoot: root,
        catalogRoot: null,
        installedDashboardsDirectory: path.join(root, "dashboards"),
        downloadData: async () => {
          throw new Error("artifact unavailable");
        },
        workingDirectory: root,
        port: 0,
      }),
      /artifact unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canvas dashboard executes only declared CLI actions through the provided executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-canvas-actions-"));
  const calls = [];
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in", [
    {
      id: "compile-workflows",
      label: "Compile workflows",
      icon: "play",
      command: "gh aw compile --strict",
      arguments: [{
        id: "pre-releases",
        label: "Include pre-releases",
        type: "boolean",
        flag: "--pre-releases",
        default: false,
      }],
    },
    {
      id: "upgrade-repository",
      label: "Upgrade repository",
      icon: "download",
      command: "gh aw upgrade --repo {{repository}}",
      arguments: [{
        id: "create-pull-request",
        label: "Create pull request",
        type: "boolean",
        flag: "--create-pull-request",
        default: true,
      }],
    },
    {
      id: "update-target-repository",
      label: "Update repository",
      icon: "sync",
      command: "gh aw update --repo {{repository}}",
      placement: "row",
      arguments: [{
        id: "create-pull-request",
        label: "Create pull request",
        type: "boolean",
        flag: "--create-pull-request",
        default: true,
      }],
    },
    {
      id: "upgrade-target-repository",
      label: "Upgrade repository",
      icon: "download",
      command: "gh aw upgrade --repo {{repository}}",
      placement: "row",
      arguments: [{
        id: "create-pull-request",
        label: "Create pull request",
        type: "boolean",
        flag: "--create-pull-request",
        default: true,
      }],
    },
  ]));

  const preview = await startDashboardServer({
    siteRoot: root,
    catalogRoot: null,
    installedDashboardsDirectory: path.join(root, "dashboards"),
    downloadData: async (destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "sources.json"), "{}");
    },
    canvas: true,
    executeCliAction: async ({ onOutput, ...action }) => {
      calls.push(action);
      onOutput({ stream: "stdout", data: "comp" });
      onOutput({ stream: "stdout", data: "iled\n" });
      return { ok: true, exitCode: 0, stdout: "compiled\n", stderr: "" };
    },
    allowMissingOrigin: true,
    workingDirectory: root,
    repository: "octo/example",
    port: 0,
  });
  try {
    const previewUrl = new URL(`${preview.url}/`);
    const origin = previewUrl.origin;
    const servedDashboard = await fetch(new URL("dashboard.json", previewUrl));
    assert.equal(servedDashboard.status, 200);
    assert.equal((await servedDashboard.json()).dashboard.repository, "octo/example");
    const response = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "compile-workflows",
        arguments: { "pre-releases": true },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.text()).trim().split("\n").map((line) => JSON.parse(line)),
      [
        { type: "output", stream: "stdout", data: "comp" },
        { type: "output", stream: "stdout", data: "iled\n" },
        {
          type: "complete",
          result: {
            ok: true,
            exitCode: 0,
            stdout: "compiled\n",
            stderr: "",
          },
        },
      ],
    );
    assert.deepEqual(calls, [{
      id: "compile-workflows",
      command: "gh aw compile --strict --pre-releases",
    }]);

    const upgrade = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "upgrade-repository",
        values: { repository: "octo/example" },
      }),
    });
    assert.equal(upgrade.status, 200);
    await upgrade.text();
    assert.deepEqual(calls.at(-1), {
      id: "upgrade-repository",
      command: "gh aw upgrade --repo octo/example --create-pull-request",
    });

    const templated = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "update-target-repository",
        values: { repository: "octo/example" },
      }),
    });
    assert.equal(templated.status, 200);
    await templated.text();
    assert.deepEqual(calls.at(-1), {
      id: "update-target-repository",
      command: "gh aw update --repo octo/example --create-pull-request",
    });

    const targetUpgrade = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "upgrade-target-repository",
        values: { repository: "octo/example" },
      }),
    });
    assert.equal(targetUpgrade.status, 200);
    await targetUpgrade.text();
    assert.deepEqual(calls.at(-1), {
      id: "upgrade-target-repository",
      command: "gh aw upgrade --repo octo/example --create-pull-request",
    });

    const unsafeTemplate = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "update-target-repository",
        values: { repository: "octo/example --force" },
      }),
    });
    assert.equal(unsafeTemplate.status, 400);
    assert.equal(calls.length, 4);

    const undeclared = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ id: "not-declared" }),
    });
    assert.equal(undeclared.status, 404);
    assert.equal(calls.length, 4);

    const invalidArgument = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "compile-workflows",
        arguments: { arbitrary: true },
      }),
    });
    assert.equal(invalidArgument.status, 400);
    assert.equal(calls.length, 4);
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local dashboard server optionally prompts Copilot to update the active view", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const packageRoot = path.join(root, "packages");
  const packageDirectory = path.join(packageRoot, "example");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<!doctype html><body><div id=\"root\"></div></body>");
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in"));
  await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-one"));
  const prompts = [];
  const promptGate = Promise.withResolvers();
  let runtimeClosed = false;
  let runtimeStopped = false;
  const disconnectedSessions = [];

  const preview = await startDashboardServer({
    siteRoot: root,
    catalogRoot: packageRoot,
    installedDashboardsDirectory: path.join(root, "dashboards"),
    downloadData: async (destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "sources.json"), "{}");
    },
    copilot: true,
    allowMissingOrigin: true,
    createCopilotRuntime: async () => ({
      prompt: async (payload) => {
        prompts.push(payload);
        payload.onEvent({ type: "assistant-delta", content: "Updating dashboard…" });
        await promptGate.promise;
        if (runtimeStopped) return { aborted: true };
        let source = JSON.stringify(JSON.parse(dashboard("package-one")));
        if (payload.request === "Produce invalid JSON") {
          source = "{ invalid";
        } else if (payload.request === "Produce invalid dashboard") {
          const invalidDashboard = JSON.parse(source);
          invalidDashboard.dashboard.pages[0].views[0].mark = "invalid-mark";
          source = JSON.stringify(invalidDashboard);
        } else if (payload.request === "Fail after valid write") {
          const updatedDashboard = JSON.parse(source);
          updatedDashboard.dashboard.pages[0].title = "Updated despite SDK failure";
          source = JSON.stringify(updatedDashboard);
          await writeFile(payload.viewDashboardPath, source);
          throw new Error("late SDK failure");
        }
        await writeFile(payload.viewDashboardPath, source);
        return { aborted: false };
      },
      stop: async () => {
        runtimeStopped = true;
        promptGate.resolve();
        return true;
      },
      disconnect: async (sessionKey) => {
        disconnectedSessions.push(sessionKey);
        return true;
      },
      close: async () => {
        runtimeClosed = true;
      },
    }),
    workingDirectory: root,
    port: 0,
  });
  try {
    const indexResponse = await fetch(`${preview.url}/`);
    assert.equal(new URL(indexResponse.url).searchParams.get("local-preview"), "copilot");
    const index = await indexResponse.text();
    assert.doesNotMatch(index, /Ask Copilot to update this view/);
    assert.doesNotMatch(index, /<script[^>]+src=.*copilot-prompt/);
    assert.doesNotMatch(index, /eval\(/);

    const socket = await openDashboardSocket(preview.url);
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Add a failure trend",
    }));
    while (prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const concurrentError = nextSocketMessage(socket, (message) =>
      message.type === "error" && /already running/.test(message.message));
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Change the summary",
    }));
    assert.equal((await concurrentError).type, "error");
    const stoppedMessage = nextSocketMessage(socket, (message) => message.type === "stopped");
    socket.send(JSON.stringify({ type: "copilot.stop" }));
    assert.equal((await stoppedMessage).type, "stopped");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].view, "package-one");
    assert.equal(prompts[0].request, "Add a failure trend");
    assert.match(prompts[0].sessionKey, /^[a-f0-9]{32}$/);
    const expectedViewDashboardPath = await realpath(path.join(packageDirectory, "dashboard.json"));
    assert.equal(prompts[0].viewDashboardPath, expectedViewDashboardPath);
    assert.deepEqual(prompts[0].editableDashboardPaths, [
      await realpath(path.join(root, "dashboard.json")),
      expectedViewDashboardPath,
    ]);
    assert.match(prompts[0].bundledDashboardPath, /cao-dashboard-preview-.*dashboard\.json$/);
    assert.equal(
      await readFile(path.join(packageDirectory, "dashboard.json"), "utf8"),
      dashboard("package-one"),
    );

    runtimeStopped = false;
    const invalidJsonError = nextSocketMessage(socket, (message) =>
      message.type === "error" && /could not update/.test(message.message));
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Produce invalid JSON",
    }));
    assert.equal((await invalidJsonError).type, "error");
    await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-one"));

    const invalidDashboardError = nextSocketMessage(socket, (message) =>
      message.type === "error" && /could not update/.test(message.message));
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Produce invalid dashboard",
    }));
    assert.equal((await invalidDashboardError).type, "error");
    await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-one"));

    const recoveredUpdate = nextSocketMessage(socket, (message) =>
      message.type === "dashboard-update");
    const recoveredDone = nextSocketMessage(socket, (message) => message.type === "done");
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Fail after valid write",
    }));
    const recoveredDashboard = await recoveredUpdate;
    socket.send(JSON.stringify({
      type: "browser.trace",
      traceId: recoveredDashboard.traceId,
      event: "preview.rendered",
      details: {},
    }));
    assert.equal((await recoveredDone).type, "done");
    assert.equal(
      JSON.parse(await readFile(path.join(packageDirectory, "dashboard.json"), "utf8"))
        .dashboard.pages[0].title,
      "Updated despite SDK failure",
    );
    await writeFile(path.join(packageDirectory, "dashboard.json"), dashboard("package-one"));

    const dashboardUpdate = nextSocketMessage(socket, (message) =>
      message.type === "dashboard-update");
    const reloadError = nextSocketMessage(socket, (message) =>
      message.type === "error" && /preview could not reload/.test(message.message));
    socket.send(JSON.stringify({
      type: "copilot.start",
      view: "package-one",
      request: "Fail hot reload",
    }));
    const update = await dashboardUpdate;
    socket.send(JSON.stringify({
      type: "browser.trace",
      traceId: update.traceId,
      event: "preview.render.failed",
      details: {
        message: "Test render failure",
        errorLog: "Error: Test render failure\n    at renderSources (index.html:140:11)",
        recovered: true,
      },
    }));
    const reloadFailure = await reloadError;
    assert.equal(reloadFailure.details.phase, "hot-reload");
    assert.equal(reloadFailure.details.recovered, true);
    assert.match(reloadFailure.details.errorLog, /renderSources/);
    assert.match(reloadFailure.message, /previous dashboard was restored/);
    assert.equal(
      await readFile(path.join(packageDirectory, "dashboard.json"), "utf8"),
      dashboard("package-one"),
    );

    socket.close();
    while (disconnectedSessions.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(prompts.every((prompt) => prompt.sessionKey === prompts[0].sessionKey));
    assert.deepEqual(disconnectedSessions, [prompts[0].sessionKey]);
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(runtimeClosed, true);
});

test("local dashboard server rejects non-loopback Copilot hosts", async () => {
  await assert.rejects(
    startDashboardServer({
      copilot: true,
      host: "0.0.0.0",
      downloadData: async () => {
        throw new Error("download should not start");
      },
    }),
    /Copilot mode requires a loopback --host/,
  );
});

test("local dashboard server rejects paths outside its workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const workspace = path.join(root, "workspace");
  const siteRoot = path.join(workspace, "site");
  const outside = path.join(root, "outside");
  await mkdir(siteRoot, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in"));
  await writeFile(path.join(siteRoot, "dashboard.json"), dashboard("built-in"));
  try {
    await assert.rejects(
      startDashboardServer({
        siteRoot: root,
        catalogRoot: null,
        installedDashboardsDirectory: path.join(workspace, "dashboards"),
        workingDirectory: workspace,
      }),
      /paths must remain within the workspace/,
    );
    await symlink(outside, path.join(workspace, "dashboards"));
    await assert.rejects(
      startDashboardServer({
        siteRoot,
        catalogRoot: null,
        installedDashboardsDirectory: path.join(workspace, "dashboards"),
        workingDirectory: workspace,
      }),
      /paths must remain within the workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local dashboard CLI runs directly without a permission sandbox relaunch", () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const result = spawnSync(process.execPath, ["dashboard/local-server.mjs", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: local-server\.mjs/);
  assert.match(result.stdout, /--canvas/);
  assert.match(result.stdout, /--replace-existing/);
});

test("dashboard local server declares canvas readiness output", async () => {
  const source = await readFile(
    new URL("../../dashboard/local-server.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /options\.canvas \? 0 : 4173/);
  assert.match(source, /CAO_CANVAS_READY \$\{preview\.url\}\//);
});

test("local dashboard server downloads dashboard-build data with GitHub CLI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const ghExecutable = path.join(root, "gh");
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in"));
  await writeFile(ghExecutable, `#!/bin/sh
if [ "$1" = "api" ]; then
  if [ "$2" = "repos/acme/control" ]; then
    printf 'main\\n'
    exit
  fi
  if [ "$2" = "repos/acme/control/actions/artifacts?name=central-agentic-ops-dashboard&per_page=100" ]; then
    printf '42\\n'
    exit
  fi
  if [ "$2" = "repos/acme/control/actions/runs/42" ]; then
    printf 'success\\tmain\\t.github/workflows/dashboard-build.yml\\n'
    exit
  fi
  exit 2
fi
[ "$1" = "run" ] &&
  [ "$2" = "download" ] &&
  [ "$3" = "42" ] &&
  [ "$4" = "--name" ] &&
  [ "$5" = "central-agentic-ops-dashboard" ] &&
  [ "$6" = "--dir" ] &&
  [ "$8" = "--repo" ] &&
  [ "$9" = "acme/control" ] || exit 3
mkdir -p "$7/cao"
printf '%s\n' '{"schema_version":2,"repository":"acme/control"}' > "$7/cao/gh-aw-logs.jsonl"
printf '{"repositories":{"rows":[{"repository":"control"}]}}' > "$7/cao/inventory-sources.json"
`);
  await chmod(ghExecutable, 0o755);

  const preview = await startDashboardServer({
    siteRoot: root,
    catalogRoot: null,
    installedDashboardsDirectory: path.join(root, "dashboards"),
    repository: "acme/control",
    ghExecutable,
    workingDirectory: root,
    port: 0,
  });
  try {
    const logsResponse = await fetch(`${preview.url}/gh-aw-logs.jsonl`);
    assert.equal(logsResponse.status, 200);
    assert.equal(logsResponse.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.deepEqual(JSON.parse((await logsResponse.text()).trim()), {
      schema_version: 2,
      repository: "acme/control",
    });
    const inventoryResponse = await fetch(`${preview.url}/inventory-sources.json`);
    assert.deepEqual(await inventoryResponse.json(), {
      repositories: { rows: [{ repository: "control" }] },
    });
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
});
