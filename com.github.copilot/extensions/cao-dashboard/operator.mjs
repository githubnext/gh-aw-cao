import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Transport only: validation, preparation and execution live in gh-cao.
 * @param {string[]} args
 * @param {{workingDirectory?: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv}} [options]
 */
export function spawnOperator(args, { workingDirectory = process.cwd(), signal, env } = {}) {
  return spawn(process.env.CAO_EXECUTABLE || "gh", [
    ...(process.env.CAO_EXECUTABLE ? [] : ["cao"]), ...args,
  ], {
    cwd: workingDirectory, signal, env, stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function callOperator(args, input, { workingDirectory, signal } = {}) {
  const child = spawnOperator(args, { workingDirectory, signal });
  let output = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (Buffer.byteLength(output) > 1_000_000) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-4096); });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve()
      : reject(new Error(diagnostic.trim() || "Native gh-cao command failed. Install or update the gh-cao extension.")));
  });
  if (Buffer.byteLength(output) > 1_000_000) throw new Error("Native command result exceeds 1 MB.");
  return output.trim();
}

/**
 * @param {{
 * command: string, input?: string, workingDirectory?: string, githubToken?: string,
 * signal?: AbortSignal, onOutput?: (event: {stream: "stdout" | "stderr", data: string}) => void
 * }} options
 */
export async function executeDashboardCommand({ command, input, workingDirectory = process.cwd(), githubToken, signal, onOutput }) {
  const env = githubToken === undefined ? undefined : {
    ...process.env, GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken,
  };
  const child = spawnOperator(["dashboard", "action", "--workspace", workingDirectory, "--command", command,
    ...(input === undefined ? [] : ["--input-file", "-"])], { workingDirectory, signal, env });
  const lines = createInterface({ input: child.stdout });
  let result;
  let protocolError;
  let diagnostic = "";
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "output" && ["stdout", "stderr"].includes(event.stream) && typeof event.data === "string") {
        onOutput?.({ stream: event.stream, data: event.data });
      } else if (event.type === "complete") {
        result = event.result;
      } else {
        throw new Error("Invalid native action response.");
      }
    } catch (error) {
      protocolError = error;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-4096); });
  child.stdin.on("error", () => {});
  child.stdin.end(input ?? "");
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      lines.close();
      if (protocolError) reject(protocolError);
      else if (code !== 0 || !result) reject(new Error(diagnostic.trim() || "Native dashboard action failed."));
      else resolve();
    });
  });
  return result;
}
