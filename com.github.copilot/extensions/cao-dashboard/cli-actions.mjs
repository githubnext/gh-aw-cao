import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const maximumOutputBytes = 1024 * 1024;
const timeoutMilliseconds = 5 * 60 * 1000;
const ghAwInstallerUrl =
  "https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh";
const ghAwVersionPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const caoConfigurationPath = join(".github", "workflows", "cao.json");

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

function commandEnvironment(githubToken, gitIdentity) {
  return {
    ...process.env,
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
    ...(gitIdentity ? {
      GIT_AUTHOR_NAME: gitIdentity.name,
      GIT_AUTHOR_EMAIL: gitIdentity.email,
      GIT_COMMITTER_NAME: gitIdentity.name,
      GIT_COMMITTER_EMAIL: gitIdentity.email,
    } : {}),
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
}) {
  const ghAwVersion = await resolveGhAwCompilerVersion(workingDirectory);
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
  workingDirectory,
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

  const ghAwVersion = await resolveGhAwCompilerVersion(workingDirectory);
  try {
    await execute(ghExecutable, ["extension", "install", "github/gh-aw", "--pin", ghAwVersion], options);
  } catch {
    await installWithCurl({ githubToken, workingDirectory, execute });
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

async function resolveGitIdentity({
  githubToken,
  ghExecutable,
  execute,
}) {
  let user;
  try {
    const result = await execute(ghExecutable, ["api", "user"], {
      env: commandEnvironment(githubToken),
      maxBuffer: maximumOutputBytes,
      timeout: timeoutMilliseconds,
      windowsHide: true,
    });
    user = JSON.parse(result.stdout);
  } catch {
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
    workingDirectory,
    ghExecutable,
    execute,
  });
  const gitIdentity = await resolveGitIdentity({
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
      gitIdentity,
      onOutput,
    });
  }
  try {
    const result = await execute(ghExecutable, tokens.slice(1), {
      cwd: workingDirectory,
      env: commandEnvironment(resolvedGithubToken, gitIdentity),
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
  gitIdentity,
  onOutput,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ghExecutable, args, {
      cwd: workingDirectory,
      env: commandEnvironment(githubToken, gitIdentity),
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
