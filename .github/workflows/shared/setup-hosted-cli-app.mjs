#!/usr/bin/env node

import { closeSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createGitHubApp,
  deriveAppName,
  deriveWriteInstallationTargets,
  ensureInstallations,
  findInstallationForApp,
  githubApiUrl,
  githubServerUrl,
  buildGitHubAppManifest,
  listInstallationRepositoriesForApp,
  runGh,
  splitRepo,
  validateAppName,
  verifyTarget,
} from "./github-apps.mjs";

// The hosted CLI executor mints one repository-scoped installation token per
// command with exactly these permissions, so the App must never hold more.
export const HOSTED_CLI_APP_PERMISSIONS = Object.freeze({
  actions: "write",
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  workflows: "write",
});

// Permissions that require organization-owner approval for every repository
// addition or that would let the App widen its own installation.
export const SENSITIVE_APP_PERMISSIONS = Object.freeze([
  "administration",
  "repository_creation",
  "installation_repositories",
  "organization_administration",
  "members",
]);

export const HOSTED_CLI_ENVIRONMENT = Object.freeze({
  appId: "CAO_HOSTED_CLI_APP_ID",
  privateKeyFile: "CAO_HOSTED_CLI_PRIVATE_KEY_FILE",
  controlRepository: "CAO_HOSTED_CLI_CONTROL_REPOSITORY",
  apiUrl: "CAO_HOSTED_CLI_GITHUB_API_URL",
});

export function assertLeastPrivilege(permissions) {
  for (const permission of Object.keys(permissions)) {
    if (SENSITIVE_APP_PERMISSIONS.includes(permission) || permission.startsWith("organization_")) {
      throw new Error(`hosted CLI App must not request ${permission}`);
    }
  }
  return permissions;
}

export function parseHostedCliArgs(argv) {
  const options = { repo: "", appName: "", targetRepositories: [], privateKeyOut: "", dryRun: false, openBrowser: true };
  const value = (index, flag) => {
    const next = argv[index]?.trim();
    if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") options.repo = value(++index, argument);
    else if (argument === "--app-name") options.appName = value(++index, argument);
    else if (argument === "--target-repository") options.targetRepositories.push(value(++index, argument));
    else if (argument === "--private-key-out") options.privateKeyOut = value(++index, argument);
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--no-open") options.openBrowser = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.repo) throw new Error("--repo OWNER/REPO is required");
  splitRepo(options.repo);
  options.targetRepositories.forEach(splitRepo);
  if (!options.dryRun && !options.privateKeyOut) {
    throw new Error("--private-key-out PATH is required; the private key is never printed");
  }
  return options;
}

export function hostedCliTargets(repo, targetRepositories) {
  const [controlOwner] = splitRepo(repo);
  const targets = deriveWriteInstallationTargets(repo, [repo, ...targetRepositories]);
  const external = targets.find((target) => target.owner.toLowerCase() !== controlOwner.toLowerCase());
  if (external) {
    throw new Error(`private organization-owned Apps cannot be installed on ${external.owner}; use a hosted CLI App owned by that organization`);
  }
  return targets;
}

export function hostedCliManifest(repo, appName) {
  return buildGitHubAppManifest({
    name: appName,
    homepageUrl: `${githubServerUrl()}/${repo}`,
    redirectUrl: "http://127.0.0.1:0/callback",
    description: `Central Agentic Ops hosted CLI executor for ${repo}. Single-use repository tokens only.`,
    permissions: assertLeastPrivilege({ ...HOSTED_CLI_APP_PERMISSIONS }),
  });
}

// Writes the key with owner-only permissions and refuses to overwrite.
export function writePrivateKey(file, pem, { open = openSync, write = writeSync, close = closeSync } = {}) {
  const descriptor = open(path.resolve(file), "wx", 0o600);
  try {
    write(descriptor, pem.endsWith("\n") ? pem : `${pem}\n`);
  } finally {
    close(descriptor);
  }
}

// Uses the installation repository API so a repository administrator can add
// an already-approved App without an owner-only installation page.
export async function addRepositoriesToInstallation(installationId, owner, repositories, runner = runGh) {
  const added = [];
  for (const repository of repositories) {
    const slug = `${owner}/${repository}`;
    const repositoryId = runner(["api", `/repos/${slug}`, "--jq", ".id"]);
    if (!/^\d+$/.test(repositoryId)) throw new Error(`unable to resolve repository ID for ${slug}`);
    runner(["api", "-X", "PUT", `/user/installations/${installationId}/repositories/${repositoryId}`, "--silent"]);
    added.push(slug);
  }
  return added;
}

export function configurationInstructions({ repo, app, privateKeyOut, environment = process.env }) {
  return [
    `${HOSTED_CLI_ENVIRONMENT.appId}=${app.id}`,
    `${HOSTED_CLI_ENVIRONMENT.privateKeyFile}=${path.resolve(privateKeyOut)}`,
    `${HOSTED_CLI_ENVIRONMENT.controlRepository}=${repo}`,
    `${HOSTED_CLI_ENVIRONMENT.apiUrl}=${githubApiUrl(environment)}`,
  ];
}

function printHelp() {
  console.log(`Usage: cao setup-auth hosted-cli --repo OWNER/REPO --private-key-out PATH [options]

Create a dedicated private GitHub App for the dashboard server's hosted CLI
executor (cao-dashboard execute-cli). The App requests only repository
permissions, so repository administrators can add it to their repositories
once the organization approves it. It never requests administration,
repository_creation, installation_repositories, or organization permissions.

Options:
  --repo OWNER/REPO            Control repository; the App is installed on it
  --target-repository REPO     Additional repository to add; repeatable
  --app-name NAME              Globally unique App name
  --private-key-out PATH       Write a temporary bootstrap file (mode 0600, never overwritten)
  --dry-run                    Print the manifest and targets without changing GitHub
  --no-open                    Print browser URLs instead of opening them
  -h, --help                   Show this help`);
}

async function main() {
  const options = parseHostedCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const appName = options.appName || deriveAppName(options.repo, "cli");
  validateAppName(appName, "--app-name");
  const targets = hostedCliTargets(options.repo, options.targetRepositories);
  const manifest = hostedCliManifest(options.repo, appName);
  if (options.dryRun) {
    console.log(JSON.stringify({ repo: options.repo, installationTargets: targets, manifest, environment: HOSTED_CLI_ENVIRONMENT }, null, 2));
    return;
  }

  runGh(["auth", "status"]);
  const target = verifyTarget(options.repo);
  const app = await createGitHubApp({
    owner: target.owner,
    name: appName,
    homepageUrl: target.homepageUrl,
    description: manifest.description,
    permissions: manifest.default_permissions,
    openBrowser: options.openBrowser,
  });
  writePrivateKey(options.privateKeyOut, app.pem);
  console.error(`Wrote the private key to ${path.resolve(options.privateKeyOut)} with mode 0600.`);
  console.error("Import it into the execute-cli deployment's secret manager, then securely remove this bootstrap file.");

  const [controlTarget] = targets;
  const [installation] = await ensureInstallations(app, [{ owner: controlTarget.owner, repositories: [splitRepo(options.repo)[1]] }], options.openBrowser, true);
  const selected = new Set((await listInstallationRepositoriesForApp(app, installation.id)).map((name) => name.toLowerCase()));
  const missing = controlTarget.repositories.filter((name) => !selected.has(`${controlTarget.owner}/${name}`.toLowerCase()));
  if (missing.length > 0) {
    try {
      const added = await addRepositoriesToInstallation(installation.id, controlTarget.owner, missing);
      console.error(`Added ${added.join(", ")} to installation ${installation.id}.`);
    } catch (error) {
      console.error(`Repository addition requires administrator access on each repository (${error.message}); continuing in the browser.`);
      await ensureInstallations(app, targets, options.openBrowser);
    }
  }
  const verified = await findInstallationForApp(app, controlTarget.owner);
  if (!verified) throw new Error("hosted CLI App installation could not be verified");

  console.error("\nConfigure the execute-cli worker (not serve-hosted) with:");
  for (const line of configurationInstructions({ repo: options.repo, app, privateKeyOut: options.privateKeyOut })) {
    console.error(`  ${line}`);
  }
  console.error("Keep this App separate from the dashboard login App. Rotate keys from the App's Credentials tab.");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
