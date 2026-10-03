import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDashboardServer } from "../../dashboard/local-server.mjs";
import { maximumCliActionInputCharacters, maximumCliActionRequestBytes } from "../../dashboard/cli-action-contract.mjs";

async function fixture(options) {
  const root = await mkdtemp(join(tmpdir(), "cao-cli-approval-"));
  await writeFile(join(root, "index.html"), "<!doctype html><body>preview</body>");
  await writeFile(join(root, "dashboard.json"), JSON.stringify({
    "language-version": "0.1.0",
    dashboard: {
      id: "preview",
      title: "Preview",
      "cli-actions": [
        { id: "compile", label: "Compile", icon: "play", command: "gh aw compile" },
        { id: "create-task", label: "Start task", icon: "copilot", command: "gh agent-task create --from-file -" },
      ],
      navigation: [{ label: "Preview", pages: ["preview"] }],
      pages: [{
        id: "preview", title: "Preview", kind: "custom",
        views: [{ id: "summary", title: "Summary", mark: "element", element: "summary-grid", data: { sources: ["repositories"] } }],
      }],
    },
  }));
  try {
    const preview = await startDashboardServer({
      workingDirectory: root, siteRoot: root, catalogRoot: null, port: 0, canvas: true,
      output: () => {}, requestOutput: () => {}, traceOutput: () => {},
      downloadData: async (destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "sources.json"), "{}");
      },
      ...options,
    });
    const base = new URL(`${preview.url}/`);
    return {
      preview,
      post: (payload) => fetch(new URL("__cli_action", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base.origin },
        body: JSON.stringify(payload),
      }),
      close: async () => { await preview.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("canvas mode cannot start without a trusted approval adapter", async () => {
  await assert.rejects(fixture({ executeCliAction: async () => {} }), /requires trusted CLI action approval/);
});

test("direct same-origin requests cannot execute without strict trusted approval", async () => {
  for (const approval of [false, undefined, "true"]) {
    let executions = 0;
    const testCase = await fixture({
      approveCliAction: async () => approval,
      executeCliAction: async () => { executions += 1; },
    });
    try {
      const response = await testCase.post({ id: "compile" });
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /not approved/);
      assert.equal(executions, 0);
    } finally { await testCase.close(); }
  }
});

test("unavailable approval is explicit and does not execute commands", async () => {
  let executions = 0;
  const testCase = await fixture({
    approveCliAction: async () => { throw new Error("Trusted approval is unavailable."); },
    executeCliAction: async () => { executions += 1; },
  });
  try {
    const response = await testCase.post({ id: "compile" });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Trusted approval is unavailable/);
    assert.equal(executions, 0);
  } finally { await testCase.close(); }
});

test("every command has a fresh bound approval and concurrent requests are rejected", { timeout: 10_000 }, async () => {
  let approve;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  let secondEntered;
  const secondWaiting = new Promise((resolve) => { secondEntered = resolve; });
  const approvals = [];
  const executions = [];
  const testCase = await fixture({
    approveCliAction: async (request) => {
      approvals.push(request);
      assert.ok(Object.isFrozen(request));
      entered();
      if (approvals.length === 2) secondEntered();
      return new Promise((resolve) => { approve = resolve; });
    },
    executeCliAction: async ({ onOutput, ...request }) => { executions.push(request); return { ok: true }; },
  });
  try {
    const first = testCase.post({ id: "create-task", input: "exact approved input" });
    await waiting;
    const concurrent = await testCase.post({ id: "compile" });
    assert.equal(concurrent.status, 409);
    assert.equal(executions.length, 0);
    approve(true);
    const response = await first;
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(executions[0], approvals[0]);
    const second = testCase.post({ id: "compile" });
    await secondWaiting;
    approve(false);
    assert.equal((await second).status, 403);
    assert.equal(executions.length, 1);
  } finally { approve?.(false); await testCase.close(); }
});

test("large valid prompts, including worst-case JSON escaping, reach approval intact", async () => {
  const received = [];
  const testCase = await fixture({
    approveCliAction: async () => true,
    executeCliAction: async ({ input }) => { received.push(input); return { ok: true }; },
  });
  try {
    for (const prompt of ["x".repeat(23_898), "\u0001".repeat(maximumCliActionInputCharacters)]) {
      const response = await testCase.post({ id: "create-task", input: prompt });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(received.at(-1), prompt);
    }
    assert.equal((await testCase.post({ id: "create-task", input: "x".repeat(maximumCliActionInputCharacters + 1) })).status, 400);
    assert.equal((await testCase.post({ id: "create-task", input: "x".repeat(maximumCliActionRequestBytes + 1) })).status, 413);
    assert.equal(received.length, 2);
  } finally { await testCase.close(); }
});

test("closing a preview cancels the execution authority of pending approval", { timeout: 10_000 }, async () => {
  let approve;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  let executions = 0;
  const testCase = await fixture({
    approveCliAction: async () => {
      entered();
      return new Promise((resolve) => { approve = resolve; });
    },
    executeCliAction: async () => { executions += 1; },
  });
  try {
    const request = testCase.post({ id: "compile" }).catch((error) => error);
    await waiting;
    await testCase.preview.close();
    approve(true);
    const response = await request;
    assert.ok(response instanceof Error);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 0);
  } finally { approve?.(false); await testCase.close(); }
});
