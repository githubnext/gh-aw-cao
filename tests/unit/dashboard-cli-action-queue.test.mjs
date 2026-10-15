import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createDashboardActionQueue } from "../../dashboard/cli-action-queue.mjs";
import { executeDashboardCommand, runDashboardCommandStreaming } from "../../dashboard/cli-actions.mjs";

const invocation = (index = 1) => ({
  actionId: `action-${index}`, command: `gh workflow run job-${index}.yml`,
  arguments: ["workflow"], values: { repository: "example/project" }, input: "safe prompt",
});
async function fixture(t) {
  const root = resolve(".queue-test-artifacts");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "queue-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: false }).catch(() => {});
  });
  return join(directory, "queue.sqlite");
}
async function until(predicate, message = "condition") {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${message}`);
}
const success = { ok: true, exitCode: 0 };

test("300 commands start FIFO at bounded concurrency and survive persistent IDs/idempotency", async (t) => {
  const filename = await fixture(t);
  let running = 0;
  let maximum = 0;
  const starts = [];
  let queue = createDashboardActionQueue({
    filename, maxConcurrency: 5,
    execute: async ({ actionId }) => {
      starts.push(actionId);
      maximum = Math.max(maximum, ++running);
      await delay(1);
      running -= 1;
      return success;
    },
  });
  t.after(() => queue.close());
  for (let index = 0; index < 300; index += 1) queue.enqueue(invocation(index), `key-${index}`);
  assert.equal(queue.enqueue(invocation(0), "key-0").id, 1);
  assert.throws(() => queue.enqueue(invocation(1), "key-0"), /conflicts/);
  await until(() => queue.list({ status: "completed", limit: 500 }).commands.length === 300, "300 completions");
  assert.deepEqual(starts, Array.from({ length: 300 }, (_, index) => `action-${index}`));
  assert.equal(maximum, 5);
  await queue.close();
  queue = createDashboardActionQueue({ filename, execute: async () => success });
  assert.equal(queue.enqueue(invocation(0), "key-0").id, 1);
  assert.equal(queue.enqueue(invocation(301)).id, 301);
});

test("admission fails closed, bounds concurrency, and cancellation wins running completion races", async (t) => {
  const filename = await fixture(t);
  let admitted = false;
  let starts = 0;
  let candidate;
  const queue = createDashboardActionQueue({
    filename, maxConcurrency: 3, admissionPollMs: 5,
    admission: async (invocation) => {
      candidate = invocation;
      if (!admitted) throw new Error("private admission diagnostics");
      return { concurrency: 1 };
    },
    execute: async ({ signal, onOutput }) => {
      starts += 1;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await onOutput({ stream: "stdout", data: "late output\n" });
      return success;
    },
  });
  t.after(() => queue.close());
  const first = queue.enqueue(invocation());
  const second = queue.enqueue(invocation(2));
  await delay(15);
  assert.equal(starts, 0);
  assert.equal(candidate.command, first.command);
  assert.equal(candidate.actionId, first.actionId);
  assert.match(queue.detail(first.id).reason, /blocked/);
  assert.equal(queue.cancel(second.id).status, "canceled");
  admitted = true;
  await until(() => starts === 1);
  assert.equal(queue.cancel(first.id).status, "canceled");
  await delay(10);
  assert.equal(queue.detail(first.id).status, "canceled");
  assert.equal(queue.output(first.id).chunks.length, 0);
  assert.equal(starts, 1);
});

test("deadline aborts executor, never frees its slot before termination, and retry is idempotent", async (t) => {
  const filename = await fixture(t);
  let calls = 0;
  const queue = createDashboardActionQueue({
    filename, timeoutMs: 15,
    execute: async ({ signal }) => {
      calls += 1;
      if (calls > 1) return success;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await delay(30);
      return success;
    },
  });
  t.after(() => queue.close());
  const first = queue.enqueue(invocation());
  await until(() => queue.detail(first.id).status === "timed-out");
  const retry = queue.retry(first.id, "retry-1");
  assert.equal(retry.retryOf, first.id);
  assert.equal(queue.retry(first.id, "retry-1").id, retry.id);
  await delay(5);
  assert.equal(calls, 1);
  await until(() => queue.detail(retry.id).status === "completed");
  assert.equal(queue.detail(first.id).result.ok, false);
});

test("output persists ordered independent streams, redacts split secrets and supports cursor resume", async (t) => {
  const filename = await fixture(t);
  const events = [];
  let queue = createDashboardActionQueue({
    filename, sensitiveValues: ["private-runtime-value"],
    execute: async ({ onOutput }) => {
      await onOutput({ stream: "stdout", data: "one\npassword=ab" });
      await onOutput({ stream: "stderr", data: "err\n" });
      await onOutput({ stream: "stdout", data: "cdef\nprivate-runtime-value\n" });
      await onOutput({ stream: "stdout", data: "ghp_abc" });
      await onOutput({ stream: "stdout", data: "defghi\nend" });
      return success;
    },
  });
  queue.subscribe((event) => events.push(event));
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  const first = queue.output(job.id, 0, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.chunks.map(({ stream, data }) => [stream, data]), [["stdout", "one\n"], ["stderr", "err\n"]]);
  const rest = queue.output(job.id, first.nextCursor);
  assert.deepEqual(rest.chunks.map(({ seq }) => seq), [3, 4, 5, 6]);
  assert.doesNotMatch(JSON.stringify(rest), /abcdef|private-runtime-value|ghp_/);
  assert.equal(events.filter(({ type }) => type === "output").length, 6);
  assert.equal(queue.detail(job.id).stderr, "err\n");
  assert.match(queue.detail(job.id).stdout, /REDACTED/);
  assert.equal(queue.detail(job.id).exitCode, 0);
  assert.equal(queue.list().total, 1);
  assert.ok(queue.list().revision > 0);
  await queue.close();
  queue = createDashboardActionQueue({ filename, execute: async () => success });
  assert.deepEqual(queue.output(job.id, first.nextCursor), rest);
  assert.doesNotMatch((await readFile(filename)).toString(), /private-runtime-value|ghp_abcdefghi/);
});

test("bounded output drops overlong lines, limits per-job and global bytes, and rejects secret input", async (t) => {
  const filename = await fixture(t);
  const queue = createDashboardActionQueue({
    filename, limits: { maxChunkBytes: 16, maxOutputBytes: 24, maxDatabaseOutputBytes: 32, maxOutputChunks: 3 },
    execute: async ({ onOutput }) => {
      await onOutput({ stream: "stdout", data: `${"x".repeat(100000)}\n` });
      for (let index = 0; index < 20; index += 1) await onOutput({ stream: "stderr", data: "1234567\n" });
      return success;
    },
  });
  t.after(() => queue.close());
  assert.throws(() => queue.enqueue({ ...invocation(), input: ["pass", "word"].join("") + "=" + "fixture-value" }), /Secret/);
  assert.throws(() => queue.enqueue({ ...invocation(), values: { github_token: "do-not-persist" } }), /Secret/);
  assert.throws(() => queue.enqueue({ ...invocation(), command: "gh aw run --github-token unsafe" }), /Secret/);
  const first = queue.enqueue(invocation());
  const second = queue.enqueue(invocation(2));
  await until(() => queue.detail(second.id).status === "completed");
  assert.equal(queue.detail(first.id).outputBytes, 24);
  assert.equal(queue.detail(second.id).outputBytes, 8);
  assert.equal(queue.detail(first.id).outputTruncated, true);
  assert.ok(queue.output(first.id).chunks.every(({ data }) => Buffer.byteLength(data) <= 16));
});

test("UTC Monday retention uses completion week and never deletes queued/running work", async (t) => {
  const filename = await fixture(t);
  let clock = Date.parse("2026-09-06T23:59:59Z");
  let allow = true;
  const queue = createDashboardActionQueue({
    filename, now: () => clock, limits: { retentionWeeks: 1 }, admissionPollMs: 5,
    admission: async () => ({ concurrency: allow ? 1 : 0 }), execute: async () => success,
  });
  t.after(() => queue.close());
  const old = queue.enqueue(invocation());
  await until(() => queue.detail(old.id).status === "completed");
  assert.equal(queue.detail(old.id).completionWeek, "2026-08-31");
  allow = false;
  const active = queue.enqueue(invocation(2));
  clock = Date.parse("2026-09-21T00:00:00Z");
  queue.enqueue(invocation(3));
  assert.equal(queue.detail(old.id), null);
  assert.equal(queue.detail(active.id).status, "queued");
  allow = true;
  await until(() => queue.detail(active.id).status === "completed");
  assert.equal(queue.detail(active.id).completionWeek, "2026-09-21");
});

test("single-owner lock rejects a second process and crash recovery fails running work without rerunning", async (t) => {
  const filename = await fixture(t);
  const source = `
    import { createDashboardActionQueue } from ${JSON.stringify(new URL("../../dashboard/cli-action-queue.mjs", import.meta.url).href)};
    const q=createDashboardActionQueue({filename:${JSON.stringify(filename)},execute:async()=>{console.log("ready");await new Promise(()=>{});}});
    q.enqueue(${JSON.stringify(invocation())});q.enqueue(${JSON.stringify(invocation(2))});
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  assert.throws(() => createDashboardActionQueue({ filename, execute: async () => success }), /already owned/);
  child.kill("SIGKILL");
  await once(child, "exit");
  const starts = [];
  const queue = createDashboardActionQueue({
    filename, execute: async ({ actionId }) => { starts.push(actionId); return success; },
  });
  t.after(() => queue.close());
  assert.equal(queue.detail(1).status, "failed");
  assert.match(queue.detail(1).result.error, /interrupted/);
  await until(() => queue.detail(2).status === "completed");
  assert.deepEqual(starts, ["action-2"]);
});

test("existing executor awaits asynchronous output persistence and terminates process groups on deadlines", async () => {
  const chunks = [];
  const result = await runDashboardCommandStreaming({
    ghExecutable: process.execPath, args: ["-e", "process.stdout.write('one\\n');process.stderr.write('two\\n');"],
    onOutput: async ({ stream, data }) => { await delay(10); chunks.push([stream, data]); },
  });
  assert.equal(result.ok, true);
  assert.equal(chunks.length, 2);
  const timeout = await runDashboardCommandStreaming({
    ghExecutable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 15, onOutput: async () => {},
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /time limit/);
  const failure = await runDashboardCommandStreaming({
    ghExecutable: process.execPath,
    args: ["-e", "process.stdout.write('output\\n');setInterval(()=>{},1000)"],
    onOutput: async () => { throw new Error("private storage diagnostics"); },
  });
  assert.equal(failure.ok, false);
  assert.match(failure.error, /could not be persisted/);
});

test("closing aborts current execution, preserves queued work, and is idempotent", async (t) => {
  const filename = await fixture(t);
  let started = false;
  let queue = createDashboardActionQueue({
    filename,
    execute: async ({ signal }) => {
      started = true;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return success;
    },
  });
  t.after(() => queue.close());
  queue.enqueue(invocation());
  queue.enqueue(invocation(2));
  await until(() => started);
  const closing = queue.close();
  assert.equal(queue.close(), closing);
  await closing;
  assert.throws(() => queue.enqueue(invocation(3)), /closed/);
  queue = createDashboardActionQueue({ filename, admission: async () => ({ concurrency: 0 }), execute: async () => success });
  assert.equal(queue.detail(1).status, "failed");
  assert.equal(queue.detail(2).status, "queued");
});

test("queue uses the existing command executor and sanitizes its failure diagnostics", async (t) => {
  const filename = await fixture(t);
  const queue = createDashboardActionQueue({
    filename,
    execute: (invocation) => executeDashboardCommand({
      ...invocation, githubToken: "fixture",
      streamCommand: async ({ onOutput }) => {
        await onOutput({ stream: "stdout", data: "worked\n" });
        return { ok: false, exitCode: 3, error: "******" };
      },
    }),
  });
  t.after(() => queue.close());
  const row = queue.enqueue(invocation());
  await until(() => queue.detail(row.id).status === "failed");
  assert.equal(queue.detail(row.id).result.exitCode, 3);
  assert.doesNotMatch(JSON.stringify(queue.detail(row.id)), /private-error/);
  assert.equal(queue.output(row.id).chunks[0].data, "worked\n");
});
