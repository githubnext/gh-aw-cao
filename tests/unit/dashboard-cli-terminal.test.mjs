import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runDashboardCommandStreaming } from "../../dashboard/cli-actions.mjs";

const run = (source, options = {}) => runDashboardCommandStreaming({
  ghExecutable: process.execPath, args: ["-e", source],
  workingDirectory: process.cwd(), terminal: true, timeoutMs: 10000, ...options,
});

test("terminal capture preserves split Unicode and ANSI and drains async output before exit", async () => {
  let output = "";
  const result = await run(`
    process.stdout.write(Buffer.from([0xe2]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0x9c, 0x93]));
      process.stdout.write("\\x1b[38;2;1;2;3m" + "x".repeat(300000) + "\\x1b[0m\\n");
      process.exitCode = 7;
    }, 20);
  `, { onOutput: async ({ data }) => { await delay(2); output += data; } });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(output.replaceAll("\r\n", "\n"), "\u2713\x1b[38;2;1;2;3m" + "x".repeat(300000) + "\x1b[0m\n");
});

for (const reason of ["cancelled", "timed-out", "persistence"]) {
  test(`terminal capture terminates its process group when ${reason}`, {
    skip: process.platform === "win32",
  }, async () => {
    const lifetime = new AbortController();
    let descendant;
    const source = `
      process.on("SIGTERM", () => {});
      process.stdout.write(String(process.pid) + "\\n");
      setInterval(() => {}, 1000);
    `;
    const result = await run(source, {
      signal: lifetime.signal,
      ...(reason === "timed-out" ? { timeoutMs: 1000 } : {}),
      onOutput: ({ data }) => {
        const pid = Number(data.trim());
        if (Number.isInteger(pid) && pid > 0) descendant ??= pid;
        if (reason === "cancelled") lifetime.abort();
        if (reason === "persistence") throw new Error("Test output persistence failure.");
      },
    });
    assert.ok(descendant);
    assert.equal(result.ok, false);
    assert.match(result.error, reason === "cancelled" ? /cancelled/ : reason === "timed-out" ? /time limit/ : /persisted/);
    const process = spawnSync("ps", ["-p", String(descendant), "-o", "stat="], { encoding: "utf8" });
    if (process.error) throw process.error;
    assert.ok(process.status === 1 || process.stdout.trim().startsWith("Z"), "The terminal descendant must stop.");
  });
}

test("terminal commands reject standard input instead of echoing prompts into captured output", () => {
  assert.throws(() => run("process.exit(0)", { input: "private prompt", onOutput: () => {} }), /cannot receive standard input/);
});

test("terminal command arguments are passed literally without shell evaluation", async () => {
  const argument = "$(printf unsafe); 'literal'";
  let output = "";
  const result = await runDashboardCommandStreaming({
    ghExecutable: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", argument],
    workingDirectory: process.cwd(), terminal: true, timeoutMs: 10000,
    onOutput: ({ data }) => { output += data; },
  });
  assert.equal(result.ok, true);
  assert.equal(output, argument);
});
