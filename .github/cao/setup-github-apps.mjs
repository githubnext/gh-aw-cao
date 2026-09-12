#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const MANIFEST_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_POLL_MS = 5 * 1000;
const APP_NAME_MAX_LENGTH = 34;

export const APP_PROFILES = Object.freeze([
  Object.freeze({
    role: "read",
    label: "read-only",
    variable: "GH_AW_GITHUB_READ_APP_ID",
    secret: "GH_AW_GITHUB_READ_APP_PRIVATE_KEY",
    permissions: Object.freeze({
      actions: "read",
      checks: "read",
      contents: "read",
      issues: "read",
      packages: "read",
      pull_requests: "read",
      secret_scanning_alerts: "read",
      security_events: "read",
      statuses: "read",
      vulnerability_alerts: "read",
    }),
  }),
  Object.freeze({
    role: "write",
    label: "write-capable",
    variable: "GH_AW_GITHUB_WRITE_APP_ID",
    secret: "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY",
    permissions: Object.freeze({
      actions: "write",
      administration: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    }),
  }),
]);

export function parseArgs(argv) {
  const options = {
    repo: "",
    readAppName: "",
    writeAppName: "",
    dryRun: false,
    force: false,
    openBrowser: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") {
      options.repo = requireArgument(argv, ++index, argument);
    } else if (argument === "--read-app-name") {
      options.readAppName = requireArgument(argv, ++index, argument);
    } else if (argument === "--write-app-name") {
      options.writeAppName = requireArgument(argv, ++index, argument);
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--no-open") {
      options.openBrowser = false;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function requireArgument(argv, index, flag) {
  const value = argv[index]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function deriveAppName(repo, role) {
  const [owner, name] = splitRepo(repo);
  const suffix = `-${role}`;
  const base = `cao-${owner}-${name}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  return `${base.slice(0, APP_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

export function validateAppName(name, flag) {
  if (!/^[A-Za-z0-9-]+$/.test(name) || name.length > APP_NAME_MAX_LENGTH) {
    throw new Error(`${flag} must contain only letters, numbers, or hyphens and be at most ${APP_NAME_MAX_LENGTH} characters`);
  }
  if (/^(?:github|gist)/i.test(name)) {
    throw new Error(`${flag} must not begin with GitHub or Gist`);
  }
}

export function buildGitHubAppManifest({ name, homepageUrl, redirectUrl, description, permissions }) {
  return {
    name,
    url: homepageUrl,
    hook_attributes: { url: homepageUrl, active: false },
    redirect_url: redirectUrl,
    public: false,
    request_oauth_on_install: false,
    description,
    default_permissions: permissions,
    default_events: [],
  };
}

export function isManifestCode(code) {
  return /^[A-Za-z0-9_-]+$/.test(code);
}

export function setRepositoryCredentials(profile, app, repo, runner = runGh) {
  runner(["variable", "set", profile.variable, "--repo", repo, "--body", app.clientId]);
  runner(["secret", "set", profile.secret, "--repo", repo], { input: app.pem });
}

function splitRepo(repo) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) {
    throw new Error(`invalid repository slug: ${repo}`);
  }
  return [match[1], match[2]];
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function repositoryState(repo) {
  const variables = new Set(runGh([
    "api",
    `/repos/${repo}/actions/variables?per_page=100`,
    "--paginate",
    "--jq",
    ".variables[].name",
  ]).split("\n").filter(Boolean));
  const secrets = new Set(runGh([
    "api",
    `/repos/${repo}/actions/secrets?per_page=100`,
    "--paginate",
    "--jq",
    ".secrets[].name",
  ]).split("\n").filter(Boolean));
  return { variables, secrets };
}

function repositoryVariableValue(repo, name) {
  return runGh([
    "api",
    `/repos/${repo}/actions/variables/${name}`,
    "--jq",
    ".value",
  ]);
}

function verifyTarget(repo) {
  const [owner] = splitRepo(repo);
  const canonicalRepo = runGh(["repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (canonicalRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`repository resolved to unexpected slug: ${canonicalRepo}`);
  }
  runGh(["api", `/orgs/${owner}`, "--jq", ".login"]);
  return {
    owner,
    homepageUrl: `https://github.com/${canonicalRepo}`,
  };
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function registrationPage(registrationUrl, manifest) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Redirecting to GitHub App creation</title></head><body><p>Redirecting to GitHub App creation...</p><form id="manifest-form" action="${escapeAttribute(registrationUrl)}" method="post"><input type="hidden" name="manifest" value="${escapeAttribute(JSON.stringify(manifest))}"><noscript><button type="submit">Continue to GitHub App creation</button></noscript></form><script>document.getElementById("manifest-form").submit();</script></body></html>`;
}

function openUrl(url) {
  const candidates = process.platform === "darwin"
    ? [["open", url], ["gh", "browse", url]]
    : process.platform === "win32"
      ? [["cmd", "/c", "start", "", url], ["gh", "browse", url]]
      : [["xdg-open", url], ["gh", "browse", url]];

  return candidates.some(([command, ...args]) => {
    const result = spawnSync(command, args, { stdio: "ignore" });
    return !result.error && result.status === 0;
  });
}

function exchangeManifestCode(code) {
  const payload = JSON.parse(runGh([
    "api",
    "-X",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    `/app-manifests/${code}/conversions`,
  ]));
  if (!payload.client_id || !payload.pem || !payload.slug) {
    throw new Error("GitHub returned an incomplete App manifest conversion");
  }
  return {
    id: String(payload.id ?? ""),
    clientId: payload.client_id,
    pem: payload.pem,
    slug: payload.slug,
    name: payload.name,
    settingsUrl: payload.html_url,
    installUrl: `https://github.com/apps/${payload.slug}/installations/new`,
  };
}

function existingGitHubApp(name, clientId) {
  const payload = JSON.parse(runGh(["api", `/apps/${name}`]));
  if (payload.client_id !== clientId || !payload.slug) {
    throw new Error(`stored credentials do not match GitHub App ${name}`);
  }
  return {
    id: String(payload.id ?? ""),
    clientId: payload.client_id,
    slug: payload.slug,
    name: payload.name,
    installUrl: `https://github.com/apps/${payload.slug}/installations/new`,
  };
}

async function createGitHubApp({ owner, name, homepageUrl, description, permissions, openBrowser }) {
  const state = randomBytes(16).toString("hex");
  let page = "";
  let complete;
  let fail;
  let settled = false;
  const flow = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    if (url.pathname === "/register") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(page);
      return;
    }
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }

    const code = url.searchParams.get("code") ?? "";
    const returnedState = url.searchParams.get("state") ?? "";
    if (!isManifestCode(code)) {
      response.writeHead(400).end("Invalid GitHub App manifest code.");
      fail(new Error("GitHub returned an invalid App manifest code"));
      return;
    }
    if (returnedState !== state) {
      response.writeHead(400).end("State mismatch while creating the GitHub App.");
      fail(new Error("state mismatch while creating the GitHub App"));
      return;
    }

    try {
      const app = exchangeManifestCode(code);
      settled = true;
      response.writeHead(302, { Location: app.installUrl }).end();
      complete(app);
    } catch (error) {
      response.writeHead(500).end("GitHub App creation completed, but the manifest code exchange failed.");
      fail(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const redirectUrl = `http://127.0.0.1:${address.port}/callback`;
  const manifest = buildGitHubAppManifest({ name, homepageUrl, redirectUrl, description, permissions });
  const registrationUrl = `https://github.com/organizations/${owner}/settings/apps/new?state=${state}`;
  page = registrationPage(registrationUrl, manifest);
  const localUrl = `http://127.0.0.1:${address.port}/register`;

  printManifestReview(owner, manifest);
  if (!openBrowser || !openUrl(localUrl)) {
    console.error(`Open this URL to continue: ${localUrl}`);
  }

  const timeout = setTimeout(() => {
    if (!settled) {
      fail(new Error("timed out waiting for GitHub App creation in the browser"));
    }
  }, MANIFEST_TIMEOUT_MS);
  try {
    return await flow;
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

function printManifestReview(owner, manifest) {
  console.error(`\nCreate private GitHub App for ${owner}:`);
  console.error(`- name: ${manifest.name}`);
  console.error(`- homepage: ${manifest.url}`);
  console.error("- permissions:");
  for (const [permission, level] of Object.entries(manifest.default_permissions).sort()) {
    console.error(`  - ${permission}: ${level}`);
  }
  console.error("- webhook events: none");
}

function listOrganizationInstallations(owner) {
  const output = runGh([
    "api",
    `/orgs/${owner}/installations?per_page=100`,
    "--paginate",
    "--jq",
    ".installations[] | [(.id|tostring), (.client_id // \"\"), (.app_id|tostring), .app_slug, .repository_selection] | @tsv",
  ]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [id, clientId, appId, slug, repositorySelection] = line.split("\t");
    return { id, clientId, appId, slug, repositorySelection };
  });
}

function matchingInstallation(app, owner) {
  return listOrganizationInstallations(owner).find((installation) => (
    installation.clientId === app.clientId
      || installation.slug === app.slug
      || (installation.appId && installation.appId === app.id)
  ));
}

export function validateInstallationScope(installation, owner) {
  if (installation.repositorySelection !== "selected") {
    const settingsUrl = `https://github.com/organizations/${owner}/settings/installations/${installation.id}`;
    const error = new Error(`GitHub App is installed for all ${owner} repositories; select only approved repositories at ${settingsUrl}`);
    error.name = "InstallationScopeError";
    throw error;
  }
}

export function installationInstruction(repo) {
  return `Choose "Only select repositories", select only ${repo}, and save.`;
}

function hasSelectedInstallation(app, repo) {
  const [owner] = splitRepo(repo);
  const installation = matchingInstallation(app, owner);
  if (!installation) {
    return false;
  }
  validateInstallationScope(installation, owner);
  return true;
}

function openInstallation(app, openBrowser) {
  if (!openBrowser || !openUrl(app.installUrl)) {
    console.error(`Open this URL to install the App: ${app.installUrl}`);
  }
}

async function waitForInstallation(app, repo) {
  console.error(`Install ${app.name || app.slug} in the browser. ${installationInstruction(repo)}`);
  const deadline = Date.now() + MANIFEST_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (hasSelectedInstallation(app, repo)) {
        console.error(`Selected-repository GitHub App installation detected for ${repo}.`);
        return;
      }
      lastError = undefined;
    } catch (error) {
      if (error.name === "InstallationScopeError") {
        throw error;
      }
      lastError = error;
    }
    await delay(INSTALL_POLL_MS);
  }
  const suffix = lastError ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for GitHub App installation on ${repo}${suffix}`);
}

function printHelp() {
  console.log(`Usage: cao-setup [options]

Create and install separate read-only and write-capable GitHub Apps for a CAO control repository.

Options:
  --repo OWNER/REPO       Control repository (defaults to the current repository)
  --read-app-name NAME    Globally unique read App name
  --write-app-name NAME   Globally unique write App name
  --dry-run               Print manifests without changing GitHub
  --force                 Create replacements even when both credential pairs exist
  --no-open               Print browser URLs instead of opening them
  -h, --help              Show this help`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const repo = options.repo || runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  splitRepo(repo);
  const [owner] = splitRepo(repo);
  const homepageUrl = `https://github.com/${repo}`;
  const appNames = {
    read: options.readAppName || deriveAppName(repo, "read"),
    write: options.writeAppName || deriveAppName(repo, "write"),
  };
  validateAppName(appNames.read, "--read-app-name");
  validateAppName(appNames.write, "--write-app-name");
  if (appNames.read.toLowerCase() === appNames.write.toLowerCase()) {
    throw new Error("read and write App names must be distinct");
  }

  if (options.dryRun) {
    const apps = APP_PROFILES.map((profile) => ({
      role: profile.role,
      variable: profile.variable,
      secret: profile.secret,
      manifest: buildGitHubAppManifest({
        name: appNames[profile.role],
        homepageUrl,
        redirectUrl: "http://127.0.0.1:0/callback",
        description: `Central Agentic Ops ${profile.label} App for ${repo}`,
        permissions: profile.permissions,
      }),
    }));
    console.log(JSON.stringify({ repo, apps }, null, 2));
    return;
  }

  runGh(["auth", "status"]);
  const target = verifyTarget(repo);
  const state = repositoryState(repo);
  for (const profile of APP_PROFILES) {
    const complete = state.variables.has(profile.variable) && state.secrets.has(profile.secret);
    if (complete && !options.force) {
      const app = existingGitHubApp(appNames[profile.role], repositoryVariableValue(repo, profile.variable));
      if (hasSelectedInstallation(app, repo)) {
        console.error(`${profile.label} App credentials and selected-repository installation already exist; skipping.`);
        continue;
      }
      console.error(`${profile.label} App credentials exist, but installation on ${repo} is incomplete; reopening it.`);
      openInstallation(app, options.openBrowser);
      await waitForInstallation(app, repo);
      continue;
    }
    if (state.variables.has(profile.variable) !== state.secrets.has(profile.secret)) {
      console.error(`${profile.label} App credentials are incomplete; creating a replacement pair.`);
    }
    const app = await createGitHubApp({
      owner: target.owner,
      name: appNames[profile.role],
      homepageUrl: target.homepageUrl,
      description: `Central Agentic Ops ${profile.label} App for ${repo}`,
      permissions: profile.permissions,
      openBrowser: options.openBrowser,
    });
    setRepositoryCredentials(profile, app, repo);
    console.error(`Set repository variable ${profile.variable}.`);
    console.error(`Set repository secret ${profile.secret}.`);
    await waitForInstallation(app, repo);
  }

  const finalState = repositoryState(repo);
  for (const profile of APP_PROFILES) {
    if (!finalState.variables.has(profile.variable) || !finalState.secrets.has(profile.secret)) {
      throw new Error(`credential verification failed for the ${profile.label} App`);
    }
  }
  console.error(`Both GitHub App credential pairs are configured for ${repo}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}