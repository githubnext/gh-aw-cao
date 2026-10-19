import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnTerminalCommand } from "./cli-terminal-process.mjs";
import { environmentDefaultsCommand } from "./site/src/environment-defaults.js";
import { executeEnvironmentDefaults } from "./environment-defaults.mjs";

const maximumOutputBytes = 1024 * 1024;
const timeoutMilliseconds = 15 * 60 * 1000;
const timeoutErrorMessage = "The CLI action exceeded its time limit.";
const ghAwInstallerUrl =
  "https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh";
const ghAwVersionPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const caoConfigurationPath = join(".github", "workflows", "cao.json");
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const workflowInputPattern = /^[A-Za-z_][A-Za-z0-9_-]*=.*$/s;

/** @param {{ pid?: number, kill: (signal: NodeJS.Signals) => unknown }} child @param {NodeJS.Signals} signal */
function signalCommand(child, signal) {
  if (process.platform === "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/**
 * @param {string} executable
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptions & { input?: string, terminal?: boolean }} options
 */
async function executeFile(executable, args, options) {
  let stdout = "";
  let stderr = "";
  const outputLimit = new AbortController();
  const result = await runDashboardCommandStreaming({
    ghExecutable: executable, args, workingDirectory: options.cwd, env: options.env,
    input: options.input,
    terminal: options.terminal,
    timeoutMs: options.timeout ?? timeoutMilliseconds,
    signal: options.signal ? AbortSignal.any([options.signal, outputLimit.signal]) : outputLimit.signal,
    onOutput: ({ stream, data }) => {
      if (outputLimit.signal.aborted) return;
      const next = (stream === "stdout" ? stdout : stderr) + data;
      if (Buffer.byteLength(next) > (options.maxBuffer ?? maximumOutputBytes)) {
        outputLimit.abort();
      } else if (stream === "stdout") stdout = next;
      else stderr = next;
    },
  });
  options.signal?.throwIfAborted();
  if (!result.ok) {
    throw Object.assign(new Error(outputLimit.signal.aborted
      ? "The CLI action exceeded its output buffer limit."
      : result.error), {
      code: result.exitCode, killed: result.error === timeoutErrorMessage, stdout, stderr,
    });
  }
  return { stdout, stderr };
}

function validWorkflowDispatchArguments(args) {
  if (!args[0] || args[0].startsWith("-")) return false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo" || argument === "-R") {
      if (!repositoryPattern.test(args[index + 1] ?? "")) return false;
      index += 1;
    } else if (argument.startsWith("--repo=")) {
      if (!repositoryPattern.test(argument.slice("--repo=".length))) return false;
    } else if (argument === "--ref") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) return false;
      index += 1;
    } else if (argument.startsWith("--ref=")) {
      if (argument.length === "--ref=".length) return false;
    } else if (argument === "--raw-field" || argument === "-f") {
      if (!workflowInputPattern.test(args[index + 1] ?? "")) return false;
      index += 1;
    } else if (argument.startsWith("--raw-field=")) {
      if (!workflowInputPattern.test(argument.slice("--raw-field=".length))) return false;
    } else {
      return false;
    }
  }
  return true;
}

const allowedCommandPrefixes = [
  {
    tokens: ["gh", "cao"],
    minimumArguments: 1,
    usage: "gh cao <command>",
  },
  {
    tokens: ["gh", "aw"],
    minimumArguments: 1,
    usage: "gh aw <command>",
  },
  {
    tokens: ["gh", "workflow", "run"],
    minimumArguments: 1,
    validateArguments: validWorkflowDispatchArguments,
    usage: "gh workflow run <workflow>",
  },
  {
    // https://cli.github.com/manual/gh_agent-task_create
    tokens: ["gh", "agent-task", "create"],
    minimumArguments: 2,
    validateArguments: (args) =>
      args.length === 2
      && args[0] === "--from-file"
      && args[1] === "-",
    usage: "gh agent-task create --from-file -",
  },
];

export async function resolveGhAwCompilerVersion(workingDirectory = process.cwd()) {
  let configuration;
  try {
    configuration = JSON.parse(await readFile(join(workingDirectory, caoConfigurationPath), "utf8"));
  } catch {
    throw new Error("Could not read the gh-aw compiler version from .github/workflows/cao.json.");
  }
  const version = configuration["gh-aw-version"];
  if (typeof version !== "string" || !ghAwVersionPattern.test(version)) {
    throw new Error("The gh-aw compiler version in .github/workflows/cao.json is invalid.");
  }
  return version;
}

export function parseDashboardCommand(command) {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("CLI action command must be a non-empty string.");
  }
  if (/[\r\n\u0000]/.test(command)) {
    throw new Error("CLI action command must be a single line without null characters.");
  }

  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  let tokenStarted = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaping || quote) throw new Error("CLI action command contains an incomplete escape or quote.");
  if (tokenStarted) tokens.push(token);
  const isAllowed = allowedCommandPrefixes.some((allowed) => {
    const commandArguments = tokens.slice(allowed.tokens.length);
    return allowed.tokens.every((token, index) => tokens[index] === token)
      && commandArguments.length >= allowed.minimumArguments
      && (!allowed.validateArguments || allowed.validateArguments(commandArguments));
  });
  if (!isAllowed) {
    const allowedCommandUsage = allowedCommandPrefixes
      .map(({ usage }) => `"${usage}"`)
      .join(" or ");
    throw new Error(
      `CLI action command must be an explicit ${allowedCommandUsage} invocation.`,
    );
  }
  return tokens;
}

const gitIdentityEnvironmentKeys = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

function commandEnvironment(githubToken, gitIdentity) {
  const environment = { ...process.env };
  if (!gitIdentity) {
    for (const key of gitIdentityEnvironmentKeys) delete environment[key];
  }
  return {
    ...environment,
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
    ...(gitIdentity ? {
      GIT_AUTHOR_NAME: gitIdentity.name,
      GIT_AUTHOR_EMAIL: gitIdentity.email,
      GIT_COMMITTER_NAME: gitIdentity.name,
      GIT_COMMITTER_EMAIL: gitIdentity.email,
    } : {}),
  };
}

function terminalCommandEnvironment(githubToken, gitIdentity) {
  const environment = commandEnvironment(githubToken, gitIdentity);
  delete environment.NO_COLOR;
  return {
    ...environment,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: "3",
    GH_FORCE_TTY: "80",
    GH_PAGER: "cat",
    PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
  };
}

function ghAwUnavailable(error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return /gh aw is available as an official extension|unknown command ["']?aw|executable file not found/i.test(output);
}

export async function installGhAwWithCurl({
  githubToken,
  workingDirectory,
  execute = executeFile,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
}) {
  const ghAwVersion = await resolveGhAwCompilerVersion(workingDirectory);
  const directory = await mkdtemp(join(tmpdir(), "cao-gh-aw-install-"));
  const installerPath = join(directory, "install-gh-aw.sh");
  const options = {
    env: commandEnvironment(githubToken),
    maxBuffer: maximumOutputBytes,
    timeout: timeoutMilliseconds,
    windowsHide: true,
    signal,
  };
  try {
    await execute("curl", ["-fsSL", ghAwInstallerUrl, "-o", installerPath], options);
    await execute("bash", [installerPath, ghAwVersion], options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function ensureGhAwAvailable({
  githubToken,
  workingDirectory,
  ghExecutable = "gh",
  execute = executeFile,
  installWithCurl = installGhAwWithCurl,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
}) {
  const options = {
    env: commandEnvironment(githubToken),
    maxBuffer: maximumOutputBytes,
    timeout: timeoutMilliseconds,
    windowsHide: true,
    signal,
  };
  try {
    await execute(ghExecutable, ["aw", "--help"], options);
    return;
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === "ENOENT") {
      throw new Error("GitHub CLI is required to run dashboard actions.");
    }
    if (!ghAwUnavailable(error)) throw error;
  }

  const ghAwVersion = await resolveGhAwCompilerVersion(workingDirectory);
  try {
    await execute(ghExecutable, ["extension", "install", "github/gh-aw", "--pin", ghAwVersion], options);
  } catch {
    signal?.throwIfAborted();
    await installWithCurl({ githubToken, workingDirectory, execute, signal });
  }

  try {
    await execute(ghExecutable, ["aw", "--help"], options);
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Could not install GitHub Agentic Workflows ${ghAwVersion}.`);
  }
}

async function resolveGithubToken({
  githubToken,
  ghExecutable,
  execute,
  signal,
}) {
  if (typeof githubToken === "string" && githubToken.length > 0) return githubToken;
  try {
    const result = await execute(ghExecutable, ["auth", "token"], {
      env: commandEnvironment(),
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMilliseconds,
      windowsHide: true,
      signal,
    });
    const token = result.stdout.trim();
    if (token) return token;
  } catch {
    signal?.throwIfAborted();
    // Report one stable authentication error below.
  }
  throw new Error("Authenticate GitHub CLI before running dashboard actions.");
}

async function resolveGitIdentity({
  githubToken,
  ghExecutable,
  execute,
  signal,
}) {
  let user;
  try {
    const result = await execute(ghExecutable, ["api", "user"], {
      env: commandEnvironment(githubToken),
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMilliseconds,
      windowsHide: true,
      signal,
    });
    user = JSON.parse(result.stdout);
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Could not determine the current GitHub CLI user for Git commit attribution.",
    );
  }
  const login = typeof user?.login === "string" ? user.login.trim() : "";
  const id = Number.isInteger(user?.id) && user.id > 0 ? String(user.id) : "";
  if (!login || !id) {
    throw new Error(
      "The current GitHub CLI user does not provide a valid login and user ID.",
    );
  }
  const profileName = typeof user.name === "string" ? user.name.trim() : "";
  const profileEmail = typeof user.email === "string" ? user.email.trim() : "";
  return {
    name: profileName || login,
    email: profileEmail || `${id}+${login}@users.noreply.github.com`,
  };
}

export async function executeDashboardCommand({
  command,
  workingDirectory,
  githubToken,
  ghExecutable = "gh",
  execute = executeFile,
  input,
  onOutput,
  streamCommand = runDashboardCommandStreaming,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  timeoutMs = timeoutMilliseconds,
  deadline = Date.now() + timeoutMs,
}) {
  signal?.throwIfAborted();
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
  signal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const tokens = parseDashboardCommand(command);
  const resolvedGithubToken = await resolveGithubToken({
    githubToken,
    ghExecutable,
    execute,
    signal,
  });
  const isGhAwCommand = tokens[0] === "gh" && tokens[1] === "aw";
  const isCaoCommand = tokens[0] === "gh" && tokens[1] === "cao";
  const commandExecutable = ghExecutable;
  const commandArguments = tokens.slice(1);
  const defaults = environmentDefaultsCommand(command);
  let gitIdentity;
  if (isGhAwCommand || isCaoCommand) {
    await ensureGhAwAvailable({
      githubToken: resolvedGithubToken,
      workingDirectory,
      ghExecutable,
      execute,
      signal,
    });
    if (!defaults) {
      gitIdentity = await resolveGitIdentity({
        githubToken: resolvedGithubToken,
        ghExecutable,
        execute,
        signal,
      });
    }
  }
  if (defaults) {
    return executeEnvironmentDefaults({
      operation: defaults.operation, input, onOutput, signal,
      run: async (directory, output) => {
        if (typeof onOutput === "function") {
          return streamCommand({
            ghExecutable: commandExecutable, args: commandArguments, workingDirectory: directory,
            githubToken: resolvedGithubToken, terminal: false, onOutput: output, signal,
            timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
          });
        }
        try {
          const result = await execute(commandExecutable, commandArguments, {
            cwd: directory, env: commandEnvironment(resolvedGithubToken), terminal: false,
            maxBuffer: maximumOutputBytes, timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
            windowsHide: true, signal,
          });
          return { ok: true, exitCode: 0, ...result };
        } catch (error) {
          return { ok: false, exitCode: Number.isInteger(error?.code) ? error.code : null,
            error: "Compiler defaults command failed.", stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
        }
      },
    });
  }
  if (typeof onOutput === "function") {
    signal?.throwIfAborted();
    return streamCommand({
      ghExecutable: commandExecutable,
      args: commandArguments,
      workingDirectory,
      githubToken: resolvedGithubToken,
      gitIdentity,
      terminal: (isGhAwCommand || isCaoCommand) && input === undefined,
      input,
      onOutput,
      signal,
      timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
    });
  }
  try {
    const result = await execute(commandExecutable, commandArguments, {
      cwd: workingDirectory,
      env: terminalCommandEnvironment(resolvedGithubToken, gitIdentity),
      terminal: (isGhAwCommand || isCaoCommand) && input === undefined,
      maxBuffer: maximumOutputBytes,
      timeout: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
      windowsHide: true,
      signal,
      ...(input === undefined ? {} : { input }),
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("GitHub CLI is required to run dashboard actions.");
    }
    return {
      ok: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
      error: error?.killed
        ? timeoutErrorMessage
        : "The CLI action did not complete successfully.",
    };
  }
}

export function runDashboardCommandStreaming({
  ghExecutable,
  args,
  workingDirectory,
  githubToken,
  gitIdentity,
  env = terminalCommandEnvironment(githubToken, gitIdentity),
  terminal = false,
  input,
  onOutput,
  signal = /** @type {AbortSignal | undefined} */ (undefined),
  timeoutMs = timeoutMilliseconds,
}) {
  signal?.throwIfAborted();
  if (terminal && input !== undefined) throw new Error("Terminal CLI commands cannot receive standard input.");
  return new Promise((resolve, reject) => {
    const child = terminal ? spawnTerminalCommand(ghExecutable, args, {
      cwd: workingDirectory, env,
    }) : spawn(ghExecutable, args, {
      cwd: workingDirectory,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined && "stdin" in child) {
      child.stdin.on("error", () => {
        // The child can close stdin before consuming the prompt.
      });
      child.stdin.end(input);
    }
    let settled = false;
    let timedOut = false;
    let killTimer;
    let outputError = false;
    let forceKilled = false;
    let outputPending = Promise.resolve();
    /** @param {NodeJS.Signals} signal */
    const kill = (signal) => signalCommand(child, signal);
    const terminate = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => { forceKilled = true; kill("SIGKILL"); }, 2000);
      killTimer.unref();
    };
    signal?.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const emit = (stream, chunk) => {
      const data = chunk.toString("utf8");
      if (!data || outputError) return;
      child.stdout.pause();
      child.stderr.pause();
      outputPending = outputPending.then(async () => {
        if (!outputError) await onOutput({ stream, data });
      }).catch(() => {
        outputError = true;
        terminate();
      }).finally(() => {
        child.stdout.resume();
        child.stderr.resume();
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => emit("stdout", chunk));
    child.stderr.on("data", (chunk) => emit("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
      if (error?.code === "ENOENT") {
        reject(Object.assign(new Error("GitHub CLI is required to run dashboard actions."), { code: "ENOENT" }));
      } else {
        reject(error);
      }
    });
    child.once("close", async (exitCode) => {
      if (settled) return;
      await outputPending;
      settled = true;
      if (!forceKilled && (signal?.aborted || timedOut || outputError)) kill("SIGKILL");
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", terminate);
      resolve({
        ok: !timedOut && !signal?.aborted && !outputError && exitCode === 0,
        exitCode,
        stdout: "",
        stderr: "",
        ...(signal?.aborted
          ? { error: "The CLI action was cancelled." }
          : timedOut
          ? { error: timeoutErrorMessage }
          : outputError
            ? { error: "The CLI action output could not be persisted." }
          : exitCode === 0
            ? {}
            : { error: "The CLI action did not complete successfully." }),
      });
    });
  });
}
