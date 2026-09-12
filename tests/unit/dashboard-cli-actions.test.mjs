import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureGhAwAvailable,
  executeGhAwCommand,
  parseGhAwCommand,
  resolveGhAwCompilerVersion,
} from "../../com.github.copilot/extensions/cao-dashboard/cli-actions.mjs";
import { composeDashboardDocuments } from "../../dashboard/report/compose-dashboard-documents.mjs";

test("CLI actions read the gh-aw compiler version from cao.json", async () => {
  assert.equal(await resolveGhAwCompilerVersion(), "v0.89.9");
});

test("CLI actions parse quoted gh aw arguments without a shell", () => {
  assert.deepEqual(
    parseGhAwCommand("gh aw compile --strict --name 'Release check'"),
    ["gh", "aw", "compile", "--strict", "--name", "Release check"],
  );
});

test("CLI actions reject commands outside gh aw", () => {
  assert.throws(() => parseGhAwCommand("gh api user"), /must be an explicit/);
  assert.throws(() => parseGhAwCommand("sh -c 'gh aw compile'"), /must be an explicit/);
  assert.throws(() => parseGhAwCommand("gh aw compile\nwhoami"), /single line/);
  assert.throws(() => parseGhAwCommand("gh aw compile '"), /incomplete/);
});

test("CLI actions execute gh directly with the approved token", async () => {
  const calls = [];
  const result = await executeGhAwCommand({
    command: "gh aw compile --strict",
    workingDirectory: "/workspace",
    githubToken: "token-value",
    execute: async (...args) => {
      calls.push(args);
      if (args[1][0] === "aw" && args[1][1] === "--help") {
        return { stdout: "usage", stderr: "" };
      }
      if (args[1][0] === "api") {
        return {
          stdout: JSON.stringify({
            login: "octocat",
            id: 1,
            name: "The Octocat",
            email: null,
          }),
          stderr: "",
        };
      }
      return { stdout: "compiled\n", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "compiled\n");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1], ["aw", "--help"]);
  assert.deepEqual(calls[1][1], ["api", "user"]);
  assert.equal(calls[2][0], "gh");
  assert.deepEqual(calls[2][1], ["aw", "compile", "--strict"]);
  assert.equal(calls[2][2].cwd, "/workspace");
  assert.equal(calls[2][2].env.GH_TOKEN, "token-value");
  assert.equal(calls[2][2].env.GIT_AUTHOR_NAME, "The Octocat");
  assert.equal(
    calls[2][2].env.GIT_AUTHOR_EMAIL,
    "1+octocat@users.noreply.github.com",
  );
  assert.equal(calls[2][2].env.GIT_COMMITTER_NAME, "The Octocat");
  assert.equal(
    calls[2][2].env.GIT_COMMITTER_EMAIL,
    "1+octocat@users.noreply.github.com",
  );
  assert.equal(calls[2][2].shell, undefined);
});

test("CLI actions fall back to the pinned curl installer", async () => {
  const calls = [];
  const fallback = [];
  let probes = 0;
  await ensureGhAwAvailable({
    githubToken: "token-value",
    execute: async (executable, args) => {
      calls.push([executable, args]);
      if (args[0] === "aw") {
        probes += 1;
        if (probes === 1) {
          throw Object.assign(new Error("missing"), {
            stderr: "gh aw is available as an official extension.",
          });
        }
        return { stdout: "usage", stderr: "" };
      }
      throw new Error("extension install failed");
    },
    installWithCurl: async (options) => fallback.push(options.githubToken),
  });

  assert.deepEqual(calls, [
    ["gh", ["aw", "--help"]],
    ["gh", ["extension", "install", "github/gh-aw", "--pin", "v0.89.9"]],
    ["gh", ["aw", "--help"]],
  ]);
  assert.deepEqual(fallback, ["token-value"]);
});

test("CLI actions use the authenticated gh token when no environment token is available", async () => {
  const calls = [];
  await executeGhAwCommand({
    command: "gh aw update",
    workingDirectory: "/workspace",
    execute: async (executable, args, options) => {
      calls.push([executable, args, options]);
      if (args[0] === "auth") return { stdout: "stored-token\n", stderr: "" };
      if (args[0] === "aw" && args[1] === "--help") return { stdout: "usage", stderr: "" };
      if (args[0] === "api") {
        return {
          stdout: JSON.stringify({ login: "octocat", id: 1 }),
          stderr: "",
        };
      }
      return { stdout: "updated\n", stderr: "" };
    },
  });

  assert.deepEqual(calls.map(([, args]) => args), [
    ["auth", "token"],
    ["aw", "--help"],
    ["api", "user"],
    ["aw", "update"],
  ]);
  assert.equal(calls[3][2].env.GH_TOKEN, "stored-token");
});

test("CLI actions stream command output when an output handler is provided", async () => {
  const output = [];
  const result = await executeGhAwCommand({
    command: "gh aw update",
    workingDirectory: "/workspace",
    githubToken: "token-value",
    execute: async (_executable, args) => {
      if (args[0] === "aw" && args[1] === "--help") return { stdout: "usage", stderr: "" };
      if (args[0] === "api") {
        return {
          stdout: JSON.stringify({ login: "octocat", id: 1 }),
          stderr: "",
        };
      }
      throw new Error("buffered execution should not run");
    },
    onOutput: (event) => output.push(event),
    streamCommand: async ({ onOutput, gitIdentity }) => {
      assert.deepEqual(gitIdentity, {
        name: "octocat",
        email: "1+octocat@users.noreply.github.com",
      });
      onOutput({ stream: "stdout", data: "updating\n" });
      onOutput({ stream: "stderr", data: "warning\n" });
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(output, [
    { stream: "stdout", data: "updating\n" },
    { stream: "stderr", data: "warning\n" },
  ]);
});

test("dashboard composition merges CLI actions and rejects duplicate ids", () => {
  const dashboard = (id, actionId) => ({
    "language-version": "0.1.0",
    dashboard: {
      id,
      title: id,
      pages: [{ id: `${id}-page`, kind: "custom", views: [] }],
      "cli-actions": [{
        id: actionId,
        label: actionId,
        icon: "play",
        command: "gh aw compile",
      }],
    },
  });
  const composed = composeDashboardDocuments(
    dashboard("primary", "compile"),
    [dashboard("package", "upgrade")],
  );
  assert.deepEqual(
    composed.dashboard["cli-actions"].map(({ id }) => id),
    ["compile", "upgrade"],
  );
  assert.throws(
    () => composeDashboardDocuments(
      dashboard("primary", "compile"),
      [dashboard("package", "compile")],
    ),
    /duplicate dashboard CLI action id/,
  );
});
