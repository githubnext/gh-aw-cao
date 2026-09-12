import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const maximumOutputBytes = 1024 * 1024;
const timeoutMilliseconds = 5 * 60 * 1000;
const ghAwVersion = "v0.89.8";
const ghAwInstallerUrl =
  "https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh";
const gitIdentity = {
  name: "GitHub Copilot",
  email: "223556219+Copilot@users.noreply.github.com",
};

export function parseGhAwCommand(command) {
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
  if (tokens[0] !== "gh" || tokens[1] !== "aw" || tokens.length < 3) {
    throw new Error('CLI action command must be an explicit "gh aw <command>" invocation.');
  }
  return tokens;
}

function commandEnvironment(githubToken) {
  return {
    ...process.env,
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || gitIdentity.name,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || gitIdentity.email,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || gitIdentity.name,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || gitIdentity.email,
  };
}

function ghAwUnavailable(error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return /gh aw is available as an official extension|unknown command ["']?aw|executable file not found/i.test(output);
}

export async function installGhAwWithCurl({
  githubToken,
  execute = executeFile,
}) {
  const directory = await mkdtemp(join(tmpdir(), "cao-gh-aw-install-"));
  const installerPath = join(directory, "install-gh-aw.sh");
  const options = {
    env: commandEnvironment(githubToken),
    maxBuffer: maximumOutputBytes,
    timeout: timeoutMilliseconds,
    windowsHide: true,
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
  ghExecutable = "gh",
  execute = executeFile,
  installWithCurl = installGhAwWithCurl,
}) {
  const options = {
    env: commandEnvironment(githubToken),
    maxBuffer: maximumOutputBytes,
    timeout: timeoutMilliseconds,
    windowsHide: true,
  };
  try {
    await execute(ghExecutable, ["aw", "--help"], options);
    return;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("GitHub CLI is required to run dashboard actions.");
    }
    if (!ghAwUnavailable(error)) throw error;
  }

  try {
    await execute(ghExecutable, ["extension", "install", "github/gh-aw"], options);
  } catch {
    await installWithCurl({ githubToken, execute });
  }

  try {
    await execute(ghExecutable, ["aw", "--help"], options);
  } catch {
    throw new Error(`Could not install GitHub Agentic Workflows ${ghAwVersion}.`);
  }
}

async function resolveGithubToken({
  githubToken,
  ghExecutable,
  execute,
}) {
  if (typeof githubToken === "string" && githubToken.length > 0) return githubToken;
  try {
    const result = await execute(ghExecutable, ["auth", "token"], {
      env: commandEnvironment(),
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMilliseconds,
      windowsHide: true,
    });
    const token = result.stdout.trim();
    if (token) return token;
  } catch {
    // Report one stable authentication error below.
  }
  throw new Error("Authenticate GitHub CLI before running dashboard actions.");
}

export async function executeGhAwCommand({
  command,
  workingDirectory,
  githubToken,
  ghExecutable = "gh",
  execute = executeFile,
  onOutput,
  streamCommand = runGhAwCommandStreaming,
}) {
  const tokens = parseGhAwCommand(command);
  const resolvedGithubToken = await resolveGithubToken({
    githubToken,
    ghExecutable,
    execute,
  });
  await ensureGhAwAvailable({
    githubToken: resolvedGithubToken,
    ghExecutable,
    execute,
  });
  if (typeof onOutput === "function") {
    return streamCommand({
      ghExecutable,
      args: tokens.slice(1),
      workingDirectory,
      githubToken: resolvedGithubToken,
      onOutput,
    });
  }
  try {
    const result = await execute(ghExecutable, tokens.slice(1), {
      cwd: workingDirectory,
      env: commandEnvironment(resolvedGithubToken),
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMilliseconds,
      windowsHide: true,
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
        ? "The CLI action exceeded its five-minute time limit."
        : "The CLI action did not complete successfully.",
    };
  }
}

export function runGhAwCommandStreaming({
  ghExecutable,
  args,
  workingDirectory,
  githubToken,
  onOutput,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ghExecutable, args, {
      cwd: workingDirectory,
      env: commandEnvironment(githubToken),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMilliseconds);
    const emit = (stream, chunk) => {
      const data = chunk.toString("utf8");
      if (data) onOutput({ stream, data });
    };
    child.stdout.on("data", (chunk) => emit("stdout", chunk));
    child.stderr.on("data", (chunk) => emit("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error?.code === "ENOENT") {
        reject(new Error("GitHub CLI is required to run dashboard actions."));
      } else {
        reject(error);
      }
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        stdout: "",
        stderr: "",
        ...(timedOut
          ? { error: "The CLI action exceeded its five-minute time limit." }
          : exitCode === 0
            ? {}
            : { error: "The CLI action did not complete successfully." }),
      });
    });
  });
}
