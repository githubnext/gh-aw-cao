import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { nativeDashboardFixture, startNativeDashboard } from "../helpers/native-dashboard.mjs";
import { nativeCommandFixture } from "../helpers/native-command-fixture.mjs";

const baseDocument = JSON.parse(await readFile(new URL("../../dashboard/site/test/fixtures/query-editor.json", import.meta.url), "utf8"));
const actions = [
  { id: "dispatch", label: "Dispatch", icon: "play", command: "gh workflow run maintenance.yml --repo {{repository}}",
    arguments: [{ id: "release", label: "Release", flag: "--ref release", default: false }] },
  { id: "copy", label: "Copy", icon: "copy", command: "gh workflow run maintenance.yml", "copy-only": true },
];

async function fixture(t, options = {}) {
  const data = await nativeDashboardFixture();
  let server;
  let commands;
  t.after(async () => {
    await server?.close();
    commands?.close();
    await data.close();
  });
  commands = await nativeCommandFixture(join(data.workspace, "external-gh"), options);
  const document = structuredClone(baseDocument);
  document.dashboard["cli-actions"] = actions;
  const dashboard = join(data.workspace, "dashboard.json");
  await writeFile(dashboard, JSON.stringify(document));
  const settings = { ...data, dashboard, admin: true, ghExecutable: commands.ghExecutable, caoUrl: "https://ops.example.test/central/" };
  server = await startNativeDashboard(settings);
  return {
    ...data, commands, document, dashboard,
    get url() { return server.url; },
    request(path = "", method = "GET", payload, headers = {}) {
      return fetch(`${server.url}${path}`, {
        method, headers: { "Content-Type": "application/json", Origin: new URL(server.url).origin, ...headers },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    },
    async restart() { await server.close(); server = await startNativeDashboard(settings); },
  };
}

const invocation = { id: "dispatch", values: { repository: "octo/example" } };
async function complete(server, id) {
  const response = await server.request(`/__cli_commands/${id}/output`);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "complete");
  return events;
}
async function until(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Native command did not reach the expected state.");
}

test("native queue API resolves declarations, rejects overrides, and enforces Origin and capability paths", async (t) => {
  const server = await fixture(t);
  for (const [payload, status] of [
    [{ id: "missing" }, 404], [{ id: "copy" }, 403],
    [{ ...invocation, command: "sh -c whoami" }, 400],
    [{ ...invocation, arguments: { unsafe: true } }, 400],
    [{ ...invocation, input: "unexpected" }, 400],
    [{ ...invocation, values: { repository: "octo/repo;whoami" } }, 400],
    ...["cao-url", "cao-repository", "cao-repository-url"].map((field) => [
      { ...invocation, values: { ...invocation.values, [field]: "attacker/override" } }, 400,
    ]),
  ]) assert.equal((await server.request("/__cli_commands", "POST", payload)).status, status, JSON.stringify(payload));
  assert.equal((await server.request("/__cli_commands", "POST", invocation, { Origin: "https://untrusted.test" })).status, 403);
  assert.equal((await server.request("/__cli_commands", "POST", invocation, { Origin: "" })).status, 403);
  assert.equal((await fetch(`${new URL(server.url).origin}/__cli_commands`)).status, 404);
  for (const query of ["limit=-1", "limit=301", "limit=1.5", "offset=01", "offset=-1", "status=queued,unknown", "status=queued,"]) {
    assert.equal((await server.request(`/__cli_commands?${query}`)).status, 400, query);
  }
  for (const suffix of ["", "/output", "/cancel", "/retry"]) {
    assert.equal((await server.request(`/__cli_commands/999999${suffix}`, suffix === "/cancel" || suffix === "/retry" ? "POST" : "GET",
      suffix === "/cancel" || suffix === "/retry" ? {} : undefined)).status, 404);
  }
  assert.equal(server.commands.runs, 0);
});

test("native output resumes by cursor and persists enterprise PR completion, ANSI and bounded history across restart", async (t) => {
  const server = await fixture(t, {
    initialOutput: [{ stream: "stdout", data: "https://github.com/octo/repo/pull/1\n" }],
    completionOutput: [
      { stream: "stderr", data: "\x1b[32mhttps://ghe.example.test:8443/github/team/project/pull/42\x1b[0m\n" },
      { stream: "stdout", data: "No more changes.\n" },
    ],
  });
  const headers = { "Idempotency-Key": "persistent-request" };
  const response = await server.request("/__cli_commands", "POST", { ...invocation, arguments: { release: true } }, headers);
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.command, "gh workflow run maintenance.yml --repo octo/example --ref release");
  assert.equal((await (await server.request("/__cli_commands", "POST", { ...invocation, arguments: { release: true } }, headers)).json()).id, job.id);
  assert.equal((await server.request("/__cli_commands", "POST", invocation, headers)).status, 409);
  // Separate pipes preserve stream order, not the order of writes across streams.
  await until(async () => {
    const detail = await (await server.request(`/__cli_commands/${job.id}`)).json();
    return detail.stdout?.includes("https://github.com/octo/repo/pull/1");
  });
  server.commands.finish();
  const events = await complete(server, job.id);
  const output = events.filter(({ type }) => type === "output");
  assert.ok(output.length >= 2);
  assert.deepEqual(output.map(({ sequence }) => sequence), output.map((_, index) => index + 1));
  const expected = "https://ghe.example.test:8443/github/team/project/pull/42";
  assert.equal(events.at(-1).result.pullRequestUrl, expected);
  assert.match(output.map(({ data }) => data).join(""), /\x1b\[32mhttps:\/\/ghe/);
  assert.equal(output.map(({ data }) => data).join("").match(/No more changes\./g).length, 1);
  const resumed = await server.request(`/__cli_commands/${job.id}/output?after=${output[0].sequence}`);
  const resumedEvents = (await resumed.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(resumedEvents.filter(({ type }) => type === "output"), output.slice(1));
  const history = await (await server.request("/__cli_commands?limit=1&offset=0")).json();
  assert.equal(history.total, 1);
  assert.equal(history.commands[0].result.pullRequestUrl, expected);
  assert.equal(history.commands[0].repository, invocation.values.repository);
  for (const key of ["input", "arguments", "values", "stdout", "stderr"]) assert.equal(Object.hasOwn(history.commands[0], key), false);
  assert.equal((await server.request(`/__cli_commands/${job.id}/retry`, "POST", {})).status, 409);
  await server.restart();
  const restored = await (await server.request(`/__cli_commands/${job.id}`)).json();
  assert.equal(restored.result.pullRequestUrl, expected);
  assert.deepEqual((await complete(server, job.id)).filter(({ type }) => type === "output"), output);
  assert.equal(server.commands.runs, 1);
});

test("native queue cancellation, status pagination, output detachment and shutdown preserve command lifetimes", async (t) => {
  const server = await fixture(t, { initialOutput: [{ stream: "stdout", data: "running\n" }] });
  const jobs = [];
  for (let index = 0; index < 6; index++) {
    const response = await server.request("/__cli_commands", "POST", invocation, { "Idempotency-Key": `queued-${index}` });
    assert.equal(response.status, 202);
    jobs.push(await response.json());
  }
  await until(async () => (await (await server.request("/__cli_commands")).json()).running === 4);
  assert.ok(server.commands.runs <= 4);
  const canceled = await server.request(`/__cli_commands/${jobs[5].id}/cancel`, "POST", {});
  assert.equal((await canceled.json()).status, "canceled");
  const filtered = await (await server.request("/__cli_commands?status=queued,canceled&limit=1&offset=0")).json();
  assert.equal(filtered.total, 2);
  assert.equal(filtered.commands[0].id, jobs[5].id);
  const detached = await server.request(`/__cli_commands/${jobs[0].id}/output`);
  await detached.body.cancel();
  assert.equal((await (await server.request(`/__cli_commands/${jobs[0].id}`)).json()).status, "running");
  assert.equal((await (await server.request(`/__cli_commands/${jobs[0].id}/cancel`, "POST", {})).json()).status, "canceled");
  server.commands.finish();
  for (const job of jobs.slice(1, 5)) assert.equal((await complete(server, job.id)).at(-1).result.ok, true);
  assert.equal((await (await server.request(`/__cli_commands/${jobs[0].id}`)).json()).status, "canceled");
  await server.restart();
  assert.equal((await (await server.request(`/__cli_commands/${jobs[5].id}`)).json()).status, "canceled");
});
