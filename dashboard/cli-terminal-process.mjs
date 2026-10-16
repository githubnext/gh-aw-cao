import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("./site/package.json", import.meta.url));

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env: NodeJS.ProcessEnv }} options
 */
export function spawnTerminalCommand(executable, args, { cwd, env }) {
  /** @type {typeof import("node-pty")} */
  let pty;
  try {
    pty = require("node-pty");
  } catch (cause) {
    throw new Error("Colored CLI output requires node-pty. Run npm ci in dashboard/site.", { cause });
  }
  const terminal = pty.spawn(process.execPath, [
    fileURLToPath(new URL("./cli-terminal-child.mjs", import.meta.url)), executable, ...args,
  ], {
    cwd, env, name: "xterm-256color", cols: 80, rows: 24,
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: terminal.pid,
    stdout,
    stderr,
    kill(signal) { terminal.kill(signal); },
  });
  stdout.on("pause", () => terminal.pause());
  stdout.on("resume", () => terminal.resume());
  terminal.onData((data) => {
    if (!stdout.write(data)) terminal.pause();
  });
  terminal.onExit(({ exitCode, signal }) => {
    const drained = Promise.all([once(stdout, "end"), once(stderr, "end")]);
    stdout.end();
    stderr.end();
    void drained.then(
      () => child.emit("close", signal ? 128 + signal : exitCode),
      (error) => child.emit("error", error),
    );
  });
  return child;
}
