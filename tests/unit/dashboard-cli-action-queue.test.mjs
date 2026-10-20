import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { chmod, link, mkdir, mkdtemp, rm, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCliActionQueue } from "../../dashboard/cli-action-queue.mjs";
import { executeDashboardCommand, runDashboardCommandStreaming } from "../../dashboard/cli-actions.mjs";
import { maximumCliActionInputCharacters } from "../../dashboard/cli-action-contract.mjs";

const invocation = (index = 1) => ({
  actionId: `action-${index}`, command: `gh workflow run job-${index}.yml`,
  arguments: { confirm: true }, values: { repository: "example/project" }, input: "safe prompt",
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

test("the last sanitized PR URL survives split chunks, preview limits, and queue restart", async (t) => {
  const filename = await fixture(t);
  let queue = createCliActionQueue({
    filename, limits: { maxPreviewBytes: 32 },
    execute: async ({ onOutput }) => {
      await onOutput({ stream: "stdout", data: "https://github.com/octo/repo/pull/1\n" });
      await onOutput({ stream: "stderr", data: "\x1b[32mhttps://ghe.example.test:8443/github/team/" });
      await onOutput({ stream: "stderr", data: "project/pull/42\x1b[0m\n" });
      await onOutput({ stream: "stdout", data: "https://user:password@ghe.example.test/team/project/pull/99\n" });
      await onOutput({ stream: "stdout", data: "https://ghe.example.test/team/project/issues/100" });
      return success;
    },
  });
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  const expected = { ...success, pullRequestUrl: "https://ghe.example.test:8443/github/team/project/pull/42" };
  assert.deepEqual(queue.detail(job.id).result, expected);
  assert.deepEqual(queue.list().commands[0].result, expected);
  const coloredOutput = queue.output(job.id).filter(({ stream }) => stream === "stderr");
  assert.equal(coloredOutput.map(({ data }) => data).join(""),
    "\x1b[32mhttps://ghe.example.test:8443/github/team/project/pull/42\x1b[0m\n");
  await queue.close();
  queue = createCliActionQueue({ filename, execute: async () => success });
  assert.deepEqual(queue.detail(job.id).result, expected);
  assert.deepEqual(queue.output(job.id).filter(({ stream }) => stream === "stderr"), coloredOutput);
});

test("commands without a PR URL retain their original result shape", async (t) => {
  const filename = await fixture(t);
  const queue = createCliActionQueue({
    filename, execute: async () => ({ ...success, stdout: "No changes needed.\n" }),
  });
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  assert.deepEqual(queue.detail(job.id).result, success);
});

test("existing queues backfill PR results from retained output in order", async (t) => {
  const filename = await fixture(t);
  let queue = createCliActionQueue({
    filename, execute: async () => ({
      ...success,
      stdout: "https://github.com/octo/repo/pull/1\nhttps://ghe.example.test/team/project/pull/42\n",
    }),
  });
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  await queue.close();
  const database = new DatabaseSync(filename);
  try {
    database.exec("ALTER TABLE jobs DROP COLUMN pull_request_url");
  } finally {
    database.close();
  }
  queue = createCliActionQueue({ filename, execute: async () => success });
  assert.equal(queue.detail(job.id).result.pullRequestUrl, "https://ghe.example.test/team/project/pull/42");
});

test("300 commands start FIFO at bounded concurrency and survive persistent IDs/idempotency", async (t) => {
  const filename = await fixture(t);
  let running = 0;
  let maximum = 0;
  const starts = [];
  let queue = createCliActionQueue({
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
  queue = createCliActionQueue({ filename, execute: async () => success });
  assert.equal(queue.enqueue(invocation(0), "key-0").id, 1);
  assert.equal(queue.enqueue(invocation(301)).id, 301);
});

test("admission fails closed, bounds concurrency, and cancellation wins running completion races", async (t) => {
  const filename = await fixture(t);
  let admitted = false;
  let starts = 0;
  let candidate;
  const queue = createCliActionQueue({
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
  assert.equal(candidate.running, 0);
  assert.match(queue.detail(first.id).reason, /blocked/);
  assert.equal(queue.cancel(second.id).status, "canceled");
  admitted = true;
  await until(() => starts === 1);
  assert.equal(queue.cancel(first.id).status, "canceled");
  await delay(10);
  assert.equal(queue.detail(first.id).status, "canceled");
  assert.equal(queue.detail(first.id).exitCode, 0);
  assert.equal(queue.detail(first.id).result.ok, false);
  assert.equal(queue.output(first.id).length, 0);
  assert.equal(starts, 1);
});

test("deadline aborts executor, never frees its slot before termination, and retry is idempotent", async (t) => {
  const filename = await fixture(t);
  let calls = 0;
  const termination = Promise.withResolvers();
  const queue = createCliActionQueue({
    filename, timeoutMs: 15,
    execute: async ({ signal }) => {
      calls += 1;
      if (calls > 1) return success;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      await termination.promise;
      return success;
    },
  });
  t.after(() => {
    termination.resolve();
    return queue.close();
  });
  const first = queue.enqueue(invocation());
  await until(() => queue.detail(first.id).status === "timed-out");
  const retry = queue.retry(first.id, "retry-1");
  assert.equal(retry.retryOf, first.id);
  assert.equal(queue.retry(first.id, "retry-1").id, retry.id);
  await delay(5);
  assert.equal(calls, 1);
  assert.equal(queue.detail(retry.id).status, "queued");
  termination.resolve();
  await until(() => queue.detail(retry.id).status === "completed");
  assert.equal(queue.detail(first.id).result.ok, false);
});

test("output persists ordered independent streams, redacts split secrets and supports cursor resume", async (t) => {
  const filename = await fixture(t);
  const events = [];
  let queue = createCliActionQueue({
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
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(({ stream, data }) => [stream, data]), [["stdout", "one\n"], ["stderr", "err\n"]]);
  const cursor = first.at(-1).sequence;
  const rest = queue.output(job.id, cursor);
  assert.deepEqual(rest.map(({ sequence }) => sequence), [3, 4, 5, 6]);
  assert.doesNotMatch(JSON.stringify(rest), /abcdef|private-runtime-value|ghp_/);
  assert.equal(events.filter(({ type }) => type === "output").length, 6);
  assert.equal(queue.detail(job.id).stderr, "err\n");
  assert.match(queue.detail(job.id).stdout, /REDACTED/);
  assert.equal(queue.detail(job.id).exitCode, 0);
  assert.equal(queue.list().total, 1);
  assert.ok(queue.list().revision > 0);
  await queue.close();
  queue = createCliActionQueue({ filename, execute: async () => success });
  assert.deepEqual(queue.output(job.id, cursor), rest);
  assert.doesNotMatch((await readFile(filename)).toString(), /private-runtime-value|ghp_abcdefghi/);
});

test("bounded output drops overlong lines, limits per-job and global bytes, and rejects secret input", async (t) => {
  const filename = await fixture(t);
  const queue = createCliActionQueue({
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
  assert.ok(queue.output(first.id).every(({ data }) => Buffer.byteLength(data) <= 16));
});

test("UTC Monday retention uses completion week and never deletes queued/running work", async (t) => {
  const filename = await fixture(t);
  let clock = Date.parse("2026-09-06T23:59:59Z");
  let allow = true;
  const queue = createCliActionQueue({
    filename, now: () => clock, retentionDays: 7, admissionPollMs: 5,
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

for (const cancelBeforeCrash of [false, true]) test(`single-owner crash recovery blocks unverified ${cancelBeforeCrash ? "canceled" : "running"} subprocesses`, async (t) => {
  const filename = await fixture(t);
  const source = `
    import { createCliActionQueue } from ${JSON.stringify(new URL("../../dashboard/cli-action-queue.mjs", import.meta.url).href)};
    const q=createCliActionQueue({filename:${JSON.stringify(filename)},execute:async()=>{${cancelBeforeCrash ? "q.cancel(1);" : ""}console.log("ready");await new Promise(()=>{});}});
    q.enqueue(${JSON.stringify(invocation())});q.enqueue(${JSON.stringify(invocation(2))});
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  assert.throws(() => createCliActionQueue({ filename, execute: async () => success }), /already owned/);
  child.kill("SIGKILL");
  await once(child, "exit");
  const starts = [];
  let queue = createCliActionQueue({
    filename, execute: async ({ actionId }) => { starts.push(actionId); return success; },
  });
  t.after(() => queue.close());
  assert.equal(queue.detail(1).status, cancelBeforeCrash ? "canceled" : "failed");
  assert.match(queue.detail(1).result.error, cancelBeforeCrash ? /canceled/ : /interrupted/);
  await delay(20);
  assert.equal(queue.detail(2).status, "queued");
  assert.match(queue.list().pausedReason, /unverified.*Operator reconciliation/);
  assert.deepEqual(starts, []);
  await queue.close();
  queue = createCliActionQueue({ filename, execute: async () => { assert.fail("Recovery uncertainty must survive another restart."); } });
  await delay(20);
  assert.equal(queue.detail(2).status, "queued");
  assert.match(queue.list().pausedReason, /recovery is blocked/);
  await queue.close();
  queue = createCliActionQueue({
    filename, acknowledgeRecovery: true,
    execute: async ({ actionId }) => { starts.push(actionId); return success; },
  });
  await until(() => queue.detail(2).status === "completed");
  assert.deepEqual(starts, ["action-2"]);
  assert.equal(queue.detail(1).status, cancelBeforeCrash ? "canceled" : "failed");
  assert.equal(queue.list().pausedReason, null);
  await queue.close();
  queue = createCliActionQueue({ filename, execute: async () => success });
  assert.equal(queue.list().pausedReason, null);
});

test("streamed output is not duplicated by returned transcripts, with fallback per stream", async (t) => {
  const queue = createCliActionQueue({
    filename: await fixture(t),
    execute: async ({ onOutput }) => {
      await onOutput({ stream: "stdout", data: "one\npartial" });
      return { ...success, stdout: "one\npartial", stderr: "returned stderr\n" };
    },
  });
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  assert.equal(queue.detail(job.id).stdout, "one\npartial");
  assert.equal(queue.detail(job.id).stderr, "returned stderr\n");
});

test("idle retention expires history without enqueueing and publishes a revision", async (t) => {
  let clock = Date.parse("2026-09-06T23:59:59Z");
  const queue = createCliActionQueue({
    filename: await fixture(t), now: () => clock,
    retentionDays: 7, retentionIntervalMs: 5, execute: async () => success,
  });
  t.after(() => queue.close());
  const job = queue.enqueue(invocation());
  await until(() => queue.detail(job.id).status === "completed");
  const revision = queue.list().revision;
  clock = Date.parse("2026-09-14T00:00:00Z");
  await until(() => queue.detail(job.id) === null);
  assert.equal(queue.list().total, 0);
  assert.ok(queue.list().revision > revision);
});

test("multiple statuses are filtered before pagination and counted together", async (t) => {
  const queue = createCliActionQueue({
    filename: await fixture(t), admission: async () => ({ concurrency: 0 }), execute: async () => success,
  });
  t.after(() => queue.close());
  const first = queue.enqueue(invocation());
  const second = queue.enqueue(invocation(2));
  queue.cancel(first.id);
  assert.equal(queue.list({ status: "queued,canceled", limit: 1 }).total, 2);
  assert.equal(queue.list({ status: "queued,canceled", limit: 1 }).commands[0].id, second.id);
  assert.equal(queue.list({ status: "queued,canceled", limit: 1, offset: 1 }).commands[0].id, first.id);
  assert.equal(queue.list({ status: "failed,timed-out" }).total, 0);
  for (const status of ["queued,unknown", "queued,", "", null]) {
    assert.throws(() => queue.list({ status }), /Invalid queue status/);
  }
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
  let queue = createCliActionQueue({
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
  queue = createCliActionQueue({ filename, admission: async () => ({ concurrency: 0 }), execute: async () => success });
  assert.equal(queue.detail(1).status, "failed");
  assert.equal(queue.detail(2).status, "queued");
});

test("queue uses the existing command executor and sanitizes its failure diagnostics", async (t) => {
  const filename = await fixture(t);
  const queue = createCliActionQueue({
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
  assert.equal(queue.output(row.id)[0].data, "worked\n");
});

test("admission reservations reconcile once on cancellation races and after subprocess exit", async (t) => {
  const filename = await fixture(t);
  let releaseAdmission;
  let candidateReady = false;
  const completions = [];
  const observed = [];
  let calls = 0;
  const queue = createCliActionQueue({
    filename, maxConcurrency: 2,
    admission: async () => {
      calls += 1;
      if (calls === 1) {
        candidateReady = true;
        await new Promise((resolve) => { releaseAdmission = resolve; });
      }
      return {
        concurrency: 2,
        onOutput: ({ data }) => observed.push(data),
        complete: (result) => completions.push(result),
      };
    },
    execute: async ({ onOutput }) => {
      await onOutput({ stream: "stdout", data: "output\n" });
      return success;
    },
  });
  t.after(() => queue.close());
  const first = queue.enqueue(invocation());
  const second = queue.enqueue(invocation(2));
  await until(() => candidateReady);
  queue.cancel(first.id);
  releaseAdmission();
  await until(() => queue.detail(second.id).status === "completed" && completions.length === 2);
  assert.deepEqual(completions.map(({ started }) => started), [false, true]);
  assert.equal(completions[1].result.ok, true);
  assert.deepEqual(observed, ["output\n"]);
});

test("close waits for pending admission to return and release an unclaimed reservation", async (t) => {
  const filename = await fixture(t);
  let ready = false;
  let release;
  let reconciled = false;
  const queue = createCliActionQueue({
    filename,
    admission: async () => {
      ready = true;
      await new Promise((resolve) => { release = resolve; });
      return {
        concurrency: 1,
        release: () => { reconciled = true; },
        complete: () => assert.fail("Unclaimed reservations use release when provided."),
      };
    },
    execute: async () => assert.fail("Closed queue must not execute a claimed action."),
  });
  queue.enqueue(invocation());
  await until(() => ready);
  const closing = queue.close();
  await delay(5);
  assert.equal(reconciled, false);
  release();
  await closing;
  assert.equal(reconciled, true);
});

test("boolean argument mappings and maximum escaped prompts survive persistence and retry", async (t) => {
  const filename = await fixture(t);
  let queue = createCliActionQueue({
    filename, admission: async () => ({ concurrency: 0 }), execute: async () => success,
  });
  t.after(() => queue.close());
  const input = "\u0001".repeat(maximumCliActionInputCharacters);
  const original = queue.enqueue({
    ...invocation(), command: "gh agent-task create --from-file -",
    arguments: { safe: true, optional: false }, input,
  });
  assert.deepEqual(original.arguments, { safe: true, optional: false });
  assert.equal(original.input, input);
  queue.cancel(original.id);
  const retry = queue.retry(original.id, "mapped-retry");
  assert.deepEqual(retry.arguments, original.arguments);
  assert.throws(() => queue.enqueue({ ...invocation(), arguments: ["flag"] }), /Invalid/);
  assert.throws(() => queue.enqueue({ ...invocation(), input: input + "x" }), /Invalid/);
  await queue.close();
  queue = createCliActionQueue({
    filename, admission: async () => ({ concurrency: 0 }), execute: async () => success,
  });
  assert.equal(queue.detail(retry.id).input, input);
});

test("default 30-day retention drops only fully expired UTC weeks and protects running rows", async (t) => {
  const filename = await fixture(t);
  let clock = Date.parse("2026-08-31T00:00:00Z");
  let release;
  const queue = createCliActionQueue({
    filename, now: () => clock,
    execute: async ({ actionId }) => {
      if (actionId === "action-2") await new Promise((resolve) => { release = resolve; });
      return success;
    },
  });
  t.after(() => queue.close());
  const expired = queue.enqueue(invocation());
  await until(() => queue.detail(expired.id).status === "completed");
  const running = queue.enqueue(invocation(2));
  await until(() => queue.detail(running.id).status === "running");
  clock = Date.parse("2026-10-06T00:00:00Z");
  queue.enqueue(invocation(3));
  assert.equal(queue.detail(expired.id).status, "completed", "A partially expired completion week must remain.");
  clock = Date.parse("2026-10-07T00:00:00Z");
  queue.enqueue(invocation(4));
  assert.equal(queue.detail(expired.id), null, "The completion week expires once its end reaches the cutoff.");
  assert.equal(queue.detail(running.id).status, "running");
  release();
  await until(() => queue.detail(running.id).status === "completed");
  assert.equal(queue.detail(running.id).completionWeek, "2026-10-05");
  assert.throws(() => createCliActionQueue({ filename, retentionDays: 6, execute: async () => success }), /retentionDays/);
  assert.throws(() => createCliActionQueue({ filename, retentionDays: 3651, execute: async () => success }), /retentionDays/);
});

test("database, ownership and SQLite sidecars reject symbolic/hard links without touching their target", async (t) => {
  const filename = await fixture(t);
  const target = `${filename}.unrelated`;
  await writeFile(target, "must remain untouched");
  for (const prefix of [filename, `${filename}.owner.sqlite`]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const candidate = `${prefix}${suffix}`;
      await symlink(target, candidate);
      assert.throws(() => createCliActionQueue({ filename, execute: async () => success }), /single-link/);
      await unlink(candidate);
      await link(target, candidate);
      assert.throws(() => createCliActionQueue({ filename, execute: async () => success }), /single-link/);
      await unlink(candidate);
      assert.equal(await readFile(target, "utf8"), "must remain untouched");
    }
  }
  const directory = resolve(filename, "..");
  await chmod(directory, 0o755);
  assert.throws(() => createCliActionQueue({ filename, execute: async () => success }), /owner-only/);
});

test("blocked admission exposes bounded sanitized helper diagnostics", async (t) => {
  const filename = await fixture(t);
  const queue = createCliActionQueue({
    filename, admission: async () => ({
      concurrency: 0, reason: "unknown",
      message: "GitHub quota helper is unavailable. Install cao-cli-quota on PATH.",
    }),
    execute: async () => assert.fail("Missing quota evidence cannot authorize execution."),
  });
  t.after(() => queue.close());
  queue.enqueue(invocation());
  await until(() => Boolean(queue.list().pausedReason));
  assert.match(queue.list().pausedReason, /unknown: GitHub quota helper is unavailable/);
});
