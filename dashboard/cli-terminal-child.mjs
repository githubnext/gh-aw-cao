import { spawn } from "node:child_process";

const [executable, ...args] = process.argv.slice(2);
// Keep the group leader alive until the command is reaped or the host escalates.
if (process.platform !== "win32") process.on("SIGTERM", () => {});
// Inherit terminal output, but never expose an interactive stdin to approved work.
const child = spawn(executable, args, {
  stdio: ["ignore", "inherit", "inherit"], shell: false, windowsHide: true,
});
child.once("error", () => {
  console.error("Could not start the CLI action executable.");
  process.exitCode = 127;
});
child.once("close", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 127);
});
