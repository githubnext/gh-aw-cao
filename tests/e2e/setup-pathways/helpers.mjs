import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { setupCaoControlPlane } from "../../../activity/setup.mjs";

const executeFile = promisify(execFile);
const catalog = path.resolve(".");
const installer = path.join(catalog, "install.sh");
const realGh = (await executeFile("which", ["gh"])).stdout.trim();
const timeout = 120_000;

export const controlRepository = "platform/control";

function scriptedPrompt({ repositories, profile, clientIds = [] }) {
  const notes = [];
  const selections = [];
  let clientIdIndex = 0;
  return {
    notes,
    selections,
    async text(message, defaultValue) {
      if (message.startsWith("Repositories CAO should")) return repositories;
      if (message.endsWith("App client ID")) return clientIds[clientIdIndex++] ?? "";
      return defaultValue;
    },
    note(message) {
      notes.push(message);
    },
    async select(message, choices) {
      selections.push({ message, choices });
      return profile;
    },
    async confirm() {
      return true;
    },
    close() {},
  };
}

async function createCleanRepository(t, repositories) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-setup-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const consumer = path.join(root, "control");
  const commandLog = path.join(root, "github-commands.jsonl");
  await mkdir(bin);
  await mkdir(consumer);
  await writeFile(commandLog, "");
  await writeFile(path.join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "aw" ]]; then
  exec ${JSON.stringify(realGh)} "$@"
fi
printf '%s\\n' "$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")" >> "$FAKE_GITHUB_COMMAND_LOG"
if [[ "$*" == "auth status" ]]; then
  exit 0
fi
if [[ "$*" == "repo view --json nameWithOwner --jq .nameWithOwner" ]]; then
  printf '%s\\n' "$FAKE_CONTROL_REPOSITORY"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "repo view" && "\${4:-}" == "--json" ]]; then
  node -e '
const repositories = JSON.parse(process.env.FAKE_REPOSITORIES);
const repository = process.argv[1];
const value = repositories[repository];
if (!value) process.exit(1);
console.log(JSON.stringify(value));
' "\${3:-}"
  exit 0
fi
if [[ "\${1:-}" == "secret" || "\${1:-}" == "variable" ]]; then
  exit 0
fi
exit 2
`);
  await chmod(path.join(bin, "gh"), 0o755);
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CONTROL_REPOSITORY: controlRepository,
    FAKE_GITHUB_COMMAND_LOG: commandLog,
    FAKE_REPOSITORIES: JSON.stringify(repositories),
    GH_HOST: "contoso-aw.ghe.com",
  };
  await executeFile("git", ["init", "-q"], { cwd: consumer });
  await executeFile("git", ["remote", "add", "origin", `https://contoso-aw.ghe.com/${controlRepository}.git`], { cwd: consumer });
  await executeFile("bash", [installer, catalog], { cwd: consumer, env: environment, timeout });
  return {
    consumer,
    environment,
    commands: async () => (await readFile(commandLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

export function setupExecutor(environment, cwd) {
  return (command, arguments_, options = {}) => spawnSync(command, arguments_, {
    cwd,
    env: environment,
    encoding: options.encoding,
    input: options.input,
    stdio: options.stdio,
  });
}

export async function runJourney(t, {
  repositories,
  selectedRepositories,
  profile,
  clientIds,
  configureAuthentication,
}) {
  const fixture = await createCleanRepository(t, repositories);
  const policyPath = path.join(fixture.consumer, ".github", "workflows", "cao.json");
  const prompt = scriptedPrompt({
    repositories: selectedRepositories.join(", "),
    profile,
    clientIds,
  });
  const browserUrls = [];
  const instructions = [];
  const previousDirectory = process.cwd();
  process.chdir(fixture.consumer);
  try {
    const result = await setupCaoControlPlane({
      policyPath,
      prompt,
      execute: setupExecutor(fixture.environment, fixture.consumer),
      setupAuthentication(method, arguments_, options) {
        return configureAuthentication({
          method,
          arguments_,
          options,
          fixture,
          browserUrls,
          instructions,
        });
      },
    });
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.equal(await readFile(path.join(fixture.consumer, "cao.sh"), "utf8").then(Boolean), true);
    assert.deepEqual(policy["control-plane"].scope["allowed-repositories"], [
      controlRepository,
      ...selectedRepositories,
    ]);
    assert.deepEqual(policy["control-plane"].campaigns, {});
    assert.equal(prompt.notes.some((note) => note.includes("Campaigns: none")), true);
    assert.equal(result.profile, profile);
    return { ...fixture, result, policy, prompt, browserUrls, instructions };
  } finally {
    process.chdir(previousDirectory);
  }
}
