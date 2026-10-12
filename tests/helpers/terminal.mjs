import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export function runTerminal(command, arguments_, { cwd, env, timeout = 30_000, onOutput, input } = {}) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = process.platform === "darwin" ? "python3" : "script";
  const scriptArguments = process.platform === "darwin"
    ? [`${import.meta.dirname}/terminal.py`, command, ...arguments_]
    : ["-q", "-e", "-c", `stty rows 32 cols 100 && exec ${[command, ...arguments_].map(quote).join(" ")}`, "/dev/null"];
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, scriptArguments, { cwd, env, timeout, detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      onOutput?.(stripVTControlCharacters(stdout), (value) => child.stdin.write(value));
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code, signal) => resolve({
      code, signal, stdout: stripVTControlCharacters(stdout), stderr,
    }));
    if (input !== undefined) child.stdin.end(input);
  });
}
