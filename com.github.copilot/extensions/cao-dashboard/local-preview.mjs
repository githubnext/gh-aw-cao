import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Start the Go server; JavaScript handles only the canvas lifecycle and
 * trusted host approval, never server preparation, queries or command execution.
 * @param {{
 * workingDirectory: string, repository?: string, dataBackend?: "sqlite" | "indexeddb",
 * ghExecutable?: string, dataDirectory?: string,
 * approveCliAction: (action: {id: string, command: string, input?: string}) => Promise<boolean>
 * }} options
 */
export async function startLocalDashboardPreview({
  workingDirectory, repository, dataBackend = "sqlite", ghExecutable = "gh",
  dataDirectory, approveCliAction,
}) {
  if (typeof approveCliAction !== "function") {
    throw new Error("Canvas requires trusted CLI action approval.");
  }
  const workspace = await realpath(workingDirectory);
  const child = spawn(process.env.CAO_DASHBOARD_EXECUTABLE || "cao-dashboard", ["serve-local", "--workspace", workspace,
    "--canvas", "--control-stdio", "--host", "127.0.0.1", "--port", "0",
    "--data-backend", dataBackend, "--gh-executable", ghExecutable,
    ...(repository ? ["--repo", repository] : []),
    ...(dataDirectory ? ["--data", dataDirectory] : []),
  ], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stopping = false;
  let closing;
  let diagnostic = "";
  let accept;
  let reject;
  const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  child.stdin.on("error", (error) => {
    if (!stopping) reject(error);
  });
  const send = (message) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      reject(new Error("Invalid native dashboard response."));
      child.kill("SIGTERM");
      return;
    }
    if (message.event === "ready") {
      const address = new URL(message.url);
      if (address.protocol !== "http:" || address.hostname !== "127.0.0.1"
        || !/^\/[a-f0-9]{48}$/.test(address.pathname)) {
        reject(new Error("Invalid native dashboard address."));
        child.kill("SIGTERM");
      } else accept(message.url);
    } else if (message.id && message.operation === "approve") {
      const payload = message.payload;
      void Promise.resolve().then(() => approveCliAction(Object.freeze({
        id: payload.id ?? payload.actionId, command: payload.command,
        ...(payload.input === undefined ? {} : { input: payload.input }),
      }))).then((approved) => send({ id: message.id, result: !stopping && approved === true }),
        () => send({ id: message.id, result: false }));
    } else if (message.id) {
      send({ id: message.id, error: { status: 403, message: "Only trusted host approval is supported." } });
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-4096); });
  child.once("error", reject);
  const exited = new Promise((resolve) => child.once("close", (code, signal) => {
    lines.close();
    if (!stopping) reject(new Error(diagnostic.trim() || "Native dashboard stopped unexpectedly."));
    resolve({ code, signal });
  }));
  const finished = exited.then(({ code, signal }) => {
    if (!stopping) throw new Error(diagnostic.trim() || `Native dashboard stopped (${signal ?? code}).`);
  });
  void finished.catch(() => {});
  const close = () => {
    closing ??= (async () => {
      stopping = true;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 7500);
      force.unref();
      const { code, signal } = await exited;
      clearTimeout(force);
      if (code !== 0 && code !== 143 && signal !== "SIGTERM") throw new Error("Native dashboard shutdown failed.");
    })();
    return closing;
  };
  const timeout = setTimeout(() => {
    reject(new Error("Native dashboard did not become ready."));
    child.kill("SIGTERM");
  }, 120_000);
  timeout.unref();
  try {
    return { url: await ready, finished, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
