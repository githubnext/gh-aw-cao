import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runGoDashboardServer, startDashboardServer } from "../../dashboard/local-server.mjs";

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

test("local dashboard server composes campaign dashboards and reloads after updates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const siteRoot = path.join(root, "site");
  const campaignRoot = path.join(root, "campaigns");
  const campaignDirectory = path.join(campaignRoot, "example");
  const campaignFeatureDirectory = path.join(campaignDirectory, "features");
  const stalePreviewDirectory = path.join(campaignRoot, ".cao-dashboard-preview-stale");
  await mkdir(campaignDirectory, { recursive: true });
  await mkdir(campaignFeatureDirectory, { recursive: true });
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
  await writeFile(path.join(campaignDirectory, "dashboard.json"), JSON.stringify({
    "language-version": "0.1.0",
    fragments: ["features/campaign.json"],
    dashboard: { id: "campaign", title: "Campaign" },
  }));
  const campaignOne = JSON.parse(dashboard("campaign-one")).dashboard;
  delete campaignOne.id;
  delete campaignOne.title;
  await writeFile(
    path.join(campaignFeatureDirectory, "campaign.json"),
    JSON.stringify(campaignOne),
  );
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
    catalogRoot: campaignRoot,
    downloadData,
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
      ["built-in", "campaign-one"],
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
    const traversalResponse = await fetch(`${preview.url}/..%2Foutside.txt`);
    assert.equal(traversalResponse.status, 404);
    assert.equal(await requestWithHost(`${preview.url}/sources.json`, "attacker.example"), 400);
    const unprotectedUrl = new URL(preview.url);
    unprotectedUrl.pathname = "/sources.json";
    assert.equal((await fetch(unprotectedUrl)).status, 404);

    const socket = await openDashboardSocket(preview.url);
    const update = nextDashboard(socket);
    const campaignTwo = JSON.parse(dashboard("campaign-two")).dashboard;
    delete campaignTwo.id;
    delete campaignTwo.title;
    await writeFile(
      path.join(campaignFeatureDirectory, "campaign.json"),
      JSON.stringify(campaignTwo),
    );
    assert.deepEqual(
      (await update).dashboard.pages.map(({ id }) => id),
      ["built-in", "campaign-two"],
    );
    socket.close();

    const updatedResponse = await fetch(`${preview.url}/dashboard.json`);
    assert.deepEqual(
      (await updatedResponse.json()).dashboard.pages.map(({ id }) => id),
      ["built-in", "campaign-two"],
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

test("local dashboard server serves repository memory from canonical dashboard data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-memory-"));
  const siteRoot = path.join(root, "site");
  await mkdir(siteRoot, { recursive: true });
  await writeFile(path.join(siteRoot, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(path.join(siteRoot, "dashboard.json"), dashboard("built-in"));
  const preview = await startDashboardServer({
    siteRoot,
    catalogRoot: null,
    downloadData: async (destination) => {
      const dataRoot = path.join(destination, "cao");
      await mkdir(path.join(dataRoot, "gh-aw-logs-runs"), { recursive: true });
      await mkdir(path.join(dataRoot, "memory", "ambient-context"), { recursive: true });
      await writeFile(path.join(dataRoot, "inventory-sources.json"), "{}");
      await writeFile(path.join(dataRoot, "memory", "manifest.json"), JSON.stringify({ version: 1 }));
      await writeFile(
        path.join(dataRoot, "memory", "ambient-context", "notes.md"),
        "token ghp_abcdefghijklmnopqrstuvwxyz123456",
      );
    },
    workingDirectory: root,
    port: 0,
  });
  try {
    assert.deepEqual(await (await fetch(`${preview.url}/memory/manifest.json`)).json(), { version: 1 });
    assert.equal(
      await (await fetch(`${preview.url}/memory/ambient-context/notes.md`)).text(),
      "token [REDACTED]",
    );
  } finally {
    await preview.close();
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
    {
      id: "create-agent-task",
      label: "Start agent task",
      icon: "copilot",
      command: "gh agent-task create --from-file -",
      placement: "row",
    },
    {
      id: "copy-package-command",
      label: "Copy add command",
      icon: "copy",
      command: "./cao.sh add octo/packages/demo@abc123",
      placement: "row",
      "copy-only": true,
    },
  ]));

  const preview = await startDashboardServer({
    siteRoot: root,
    catalogRoot: null,
    downloadData: async (destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "sources.json"), "{}");
    },
    canvas: true,
    approveCliAction: async () => true,
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

    const prompt = "Investigate this failure.\n\nUntrusted context: {}";
    const agentTask = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "create-agent-task",
        arguments: {},
        input: prompt,
      }),
    });
    assert.equal(agentTask.status, 200);
    await agentTask.text();
    assert.deepEqual(calls.at(-1), {
      id: "create-agent-task",
      command: "gh agent-task create --from-file -",
      input: prompt,
    });

    const copyOnly = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ id: "copy-package-command" }),
    });
    assert.equal(copyOnly.status, 403);
    assert.deepEqual(await copyOnly.json(), { error: "CLI action is copy-only." });
    assert.equal(calls.length, 5);

    const rejectedInput = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "compile-workflows",
        arguments: {},
        input: prompt,
      }),
    });
    assert.equal(rejectedInput.status, 400);

    const unsafeTemplate = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "update-target-repository",
        values: { repository: "octo/example --force" },
      }),
    });
    assert.equal(unsafeTemplate.status, 400);
    assert.equal(calls.length, 5);

    const undeclared = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ id: "not-declared" }),
    });
    assert.equal(undeclared.status, 404);
    assert.equal(calls.length, 5);

    const invalidArgument = await fetch(new URL("__cli_action", previewUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        id: "compile-workflows",
        arguments: { arbitrary: true },
      }),
    });
    assert.equal(invalidArgument.status, 400);
    assert.equal(calls.length, 5);
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
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
        workingDirectory: workspace,
      }),
      /paths must remain within the workspace/,
    );
    await writeFile(path.join(outside, "dashboard.json"), dashboard("outside"));
    await symlink(outside, path.join(workspace, "example"));
    await assert.rejects(
      startDashboardServer({
        siteRoot,
        catalogRoot: workspace,
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
  assert.match(result.stdout, /--operational-store redis\|memory/);
  assert.match(result.stdout, /matching reviewed host policy/);
});

test("local dashboard CLI rejects invalid or incompatible Go mode flags", () => {
  for (const [arguments_, message] of [
    [["--operational-store"], /requires a value/],
    [["--operational-store", "postgres"], /must be redis or memory/],
    [["--operational-store", "memory", "--policy", "--port", "8080"], /--policy requires a value/],
    [["--operational-store", "redis", "--canvas"], /--canvas cannot be used/],
    [["--operational-store", "memory", "--repo", "acme/control"], /--repo cannot be used/],
    [["--operational-store", "redis", "--replace-existing"], /--replace-existing cannot be used/],
    [["--operational-store", "memory", "--trace-file", "trace.jsonl"], /--trace-file cannot be used/],
    [["--operational-store", "memory", "--cert", "cert.pem"], /--cert and --key/],
    [["--policy", "cao.json"], /require --operational-store/],
    [["--operational-store", "memory", "--port", "0"], /--port must be an integer/],
  ]) {
    const result = spawnSync(process.execPath, ["dashboard/local-server.mjs", ...arguments_], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, message);
  }
});

test("Go local launcher selects either backend without modifying policy or environment", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-go-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const operationalStore of ["redis", "memory"]) {
    const calls = [];
    const policyPath = path.join(root, `${operationalStore}.json`);
    const policy = JSON.stringify({ fixture: operationalStore });
    await writeFile(policyPath, policy);
    const environment = { CAO_POLICY_PATH: "ignored.json", CAO_POSTGRES_URL: "postgres://fixture" };
    await runGoDashboardServer({
      operationalStore,
      policyPath,
      workingDirectory: root,
      environment,
      host: "::1",
      port: 8443,
      siteRoot: "built",
      certFile: "cert.pem",
      keyFile: "key.pem",
      runCommand: async (executable, arguments_, options) => {
        calls.push({ executable, arguments_, options });
        if (executable === "go") await writeFile(arguments_[2], "build fixture");
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].executable, "go");
    assert.deepEqual(calls[0].arguments_.slice(0, 2), ["build", "-o"]);
    assert.equal(calls[0].arguments_.at(-1), "./cmd/cao-dashboard");
    assert.equal(calls[1].executable, calls[0].arguments_[2]);
    assert.deepEqual(calls[1].arguments_, [
      "serve-hosted", "--operational-store", operationalStore,
      "--listen", "[::1]:8443", "--site", path.join(root, "built"),
      "--cert", path.join(root, "cert.pem"), "--key", path.join(root, "key.pem"),
    ]);
    assert.equal(calls[1].options.env.CAO_POLICY_PATH, policyPath);
    assert.equal(calls[1].options.env.CAO_POSTGRES_URL, environment.CAO_POSTGRES_URL);
    assert.equal(environment.CAO_POLICY_PATH, "ignored.json");
    assert.equal(await readFile(policyPath, "utf8"), policy);
    await assert.rejects(stat(calls[1].executable), { code: "ENOENT" });
  }
});

test("Go local launcher respects policy environment precedence", async () => {
  for (const [environment, expected] of [
    [{ CAO_POLICY_PATH: "primary.json", CAO_MARKETPLACE_POLICY_PATH: "secondary.json" }, "primary.json"],
    [{ CAO_POLICY_PATH: " ", CAO_MARKETPLACE_POLICY_PATH: "secondary.json" }, "secondary.json"],
    [{}, path.resolve(import.meta.dirname, "../../.github/workflows/cao.json")],
  ]) {
    let selected;
    await runGoDashboardServer({
      operationalStore: "memory",
      environment,
      runCommand: async (_executable, _arguments, options) => { selected = options.env.CAO_POLICY_PATH; },
    });
    assert.equal(selected, path.resolve(expected));
  }
});

test("Go local launcher reports build failure and removes its temporary binary", async () => {
  const failure = new Error("Go build failed");
  let executable;
  await assert.rejects(runGoDashboardServer({
    operationalStore: "memory",
    runCommand: async (_command, arguments_) => {
      executable = arguments_[2];
      await writeFile(executable, "partial build");
      throw failure;
    },
  }), failure);
  await assert.rejects(stat(executable), { code: "ENOENT" });
});

test("dashboard local server declares canvas readiness output", async () => {
  const source = await readFile(
    new URL("../../dashboard/local-server.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /options\.canvas \? 0 : 4173/);
  assert.match(source, /CAO_CANVAS_READY \$\{preview\.url\}\//);
});

test("local dashboard server downloads dashboard-build data with GitHub CLI", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dashboard-local-server-"));
  const ghExecutable = path.join(root, "gh");
  await writeFile(path.join(root, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(path.join(root, "dashboard.json"), dashboard("built-in"));
  await writeFile(ghExecutable, `#!/bin/sh
[ "$(pwd -P)" = ${JSON.stringify(await realpath(root))} ] || exit 4
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
    printf 'success\\tmain\\t.github/workflows/cao-dashboard.yml\\n'
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
mkdir -p "$7/cao/gh-aw-logs-runs"
printf '%s\n' '{"schema_version":2,"repository":"acme/control","token":"sensitive"}' > "$7/cao/gh-aw-logs-runs/logs-1.jsonl"
printf '{"repositories":{"rows":[{"repository":"control"}]}}' > "$7/cao/inventory-sources.json"
`);
  await chmod(ghExecutable, 0o755);

  const preview = await startDashboardServer({
    siteRoot: root,
    catalogRoot: null,
    repository: "acme/control",
    ghExecutable,
    workingDirectory: root,
    port: 0,
  });
  try {
    const logsResponse = await fetch(`${preview.url}/gh-aw-logs-runs/logs-1.jsonl`);
    assert.equal(logsResponse.status, 200);
    assert.equal(logsResponse.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    const logsContent = await logsResponse.text();
    assert.deepEqual(JSON.parse(logsContent.trim()), {
      schema_version: 2,
      repository: "acme/control",
      token: "[REDACTED]",
    });
    const hashesResponse = await fetch(`${preview.url}/payload-hashes.json`);
    assert.deepEqual(await hashesResponse.json(), {
      "gh-aw-logs-runs/logs-1.jsonl": createHash("sha256").update(logsContent).digest("hex"),
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
