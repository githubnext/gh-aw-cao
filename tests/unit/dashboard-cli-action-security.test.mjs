import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { maximumCliActionInputCharacters, maximumCliActionRequestBytes } from "../../dashboard/cli-action-contract.mjs";
import { nativeDashboardFixture, startNativeDashboard } from "../helpers/native-dashboard.mjs";
import { nativeCommandFixture } from "../helpers/native-command-fixture.mjs";

const document = JSON.parse(await readFile(new URL("../../dashboard/site/test/fixtures/query-editor.json", import.meta.url), "utf8"));
const declarations = [
  { id: "dispatch", label: "Dispatch", icon: "play", command: "gh workflow run maintenance.yml" },
  { id: "task", label: "Create task", icon: "copilot", command: "gh agent-task create --from-file -" },
  { id: "add-repository", label: "Enroll repository", icon: "plus", command: "gh workflow run enroll.yml --repo {{repository}}",
    selector: { label: "Repository", "debounce-ms": 300,
      query: { command: "gh search repos", fields: ["fullName", "description"], limit: 20 },
      mapping: { value: "fullName", label: "fullName", description: "description", target: "repository" } } },
];

async function fixture(t, { canvas = true, approve = async () => false } = {}) {
  const data = await nativeDashboardFixture();
  let commands;
  let server;
  t.after(async () => {
    await server?.close();
    commands?.close();
    await data.close();
  });
  commands = await nativeCommandFixture(join(data.workspace, "external-gh"), { hold: false });
  const base = structuredClone(document);
  base.dashboard["cli-actions"] = declarations;
  const dashboard = join(data.workspace, "dashboard.json");
  await writeFile(dashboard, JSON.stringify(base));
  const settings = { ...data, dashboard, canvas, ghExecutable: commands.ghExecutable,
    caoUrl: "https://ops.example.test/central/", approve };
  server = await startNativeDashboard(settings);
  return {
    commands,
    post(payload, path = "/__cli_commands", origin = new URL(server.url).origin) {
      return fetch(`${server.url}${path}`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(payload) });
    },
    get url() { return server.url; },
    close: () => server.close(),
    async restart() { await server.close(); server = await startNativeDashboard(settings); },
  };
}

test("native canvases deny absent, non-boolean and unavailable host approval without executing", async (t) => {
  for (const decision of [false, undefined, "true"]) {
    const server = await fixture(t, { approve: async () => decision });
    assert.equal((await server.post({ id: "dispatch" })).status, 403);
    assert.equal((await server.post({ id: "undeclared" })).status, 404);
    assert.equal(server.commands.runs, 0);
  }
  const missing = await fixture(t);
  assert.equal((await missing.post({ id: "dispatch" })).status, 403);
  const unavailable = await fixture(t, { approve: async () => { throw new Error("private approval details"); } });
  const denied = await unavailable.post({ id: "dispatch" });
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /private approval details/);
  assert.equal(unavailable.commands.runs, 0);
});

test("native selectors enforce declared identity, text bounds, Origin and canvas-only access", async (t) => {
  const server = await fixture(t, { approve: async () => assert.fail("A read-only selector cannot request approval.") });
  const search = { id: "add-repository", text: "octo" };
  const response = await server.post(search, "/__dialog_selector");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    options: [{ value: "octo/example", label: "octo/example", description: "" }],
  });
  for (const payload of [
    { ...search, text: "x" }, { ...search, text: "x".repeat(201) }, { ...search, text: "octo\nrepo" },
    { ...search, command: "gh api user" },
  ]) assert.equal((await server.post(payload, "/__dialog_selector")).status, 400);
  assert.equal((await server.post({ id: "dispatch", text: "octo" }, "/__dialog_selector")).status, 404);
  assert.equal((await server.post(search, "/__dialog_selector", "https://untrusted.test")).status, 403);
  assert.equal(server.commands.searches.length, 1);
  assert.equal(server.commands.runs, 0);
  const normal = await fixture(t, { canvas: false });
  for (const path of ["/__dialog_selector", "/__cli_commands", "/__cli_action"]) {
    assert.equal((await normal.post(search, path)).status, 404);
  }
});

test("native execution requires fresh host approval bound to repository selection and rejects concurrent approvals", async (t) => {
  const approvals = [];
  let decide;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const server = await fixture(t, {
    approve: async (request) => {
      approvals.push(request);
      if (approvals.length > 1) return false;
      entered();
      return new Promise((resolve) => { decide = resolve; });
    },
  });
  t.after(() => decide?.(false));
  const payload = { id: "add-repository", values: { repository: "octo/example" } };
  const pending = server.post(payload);
  await waiting;
  assert.equal((await server.post({ id: "dispatch" })).status, 409);
  assert.equal(server.commands.runs, 0);
  assert.equal(approvals[0].command, "gh workflow run enroll.yml --repo octo/example");
  assert.deepEqual(approvals[0].values, payload.values);
  decide(true);
  const admitted = await pending;
  assert.equal(admitted.status, 202);
  const job = await admitted.json();
  const output = await (await fetch(`${server.url}/__cli_commands/${job.id}/output`)).text();
  assert.match(output, /"ok":true/);
  assert.equal(server.commands.runs, 1);
  assert.equal((await server.post(payload)).status, 403);
  assert.equal(approvals.length, 2);
  assert.equal((await server.post({ ...payload, values: { repository: "octo/repo;evil" } })).status, 400);
  assert.equal((await server.post({ ...payload, command: "gh workflow run evil.yml" })).status, 400);
  assert.equal(approvals.length, 2);
});

test("native host approval receives full maximum escaped prompts while oversized requests fail before approval", async (t) => {
  let received;
  let calls = 0;
  const server = await fixture(t, { approve: async (request) => { calls++; received = request.input; return false; } });
  for (const input of ["x".repeat(32768), "x".repeat(65536), "\u0001".repeat(maximumCliActionInputCharacters)]) {
    assert.equal((await server.post({ id: "task", input })).status, 403);
    assert.equal(received, input);
  }
  assert.equal((await server.post({ id: "task", input: "x".repeat(maximumCliActionInputCharacters + 1) })).status, 400);
  assert.equal((await server.post({ id: "task", input: "x".repeat(maximumCliActionRequestBytes + 1) })).status, 413);
  assert.equal(calls, 3);
  assert.equal(server.commands.runs, 0);
});

test("closing a native preview revokes pending host approval instead of persisting an execution", async (t) => {
  let entered;
  let decide;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const server = await fixture(t, { approve: async () => {
    entered();
    return new Promise((resolve) => { decide = resolve; });
  } });
  const pending = server.post({ id: "dispatch" }).catch(() => null);
  await waiting;
  await server.close();
  decide(true);
  const response = await pending;
  if (response) assert.notEqual(response.status, 202);
  await server.restart();
  const history = await (await fetch(`${server.url}/__cli_commands`)).json();
  assert.equal(history.total, 0);
  assert.equal(server.commands.runs, 0);
});
