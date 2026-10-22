import { createSign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

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

export function deriveAppName(repo, role) {
  const [owner, name] = splitRepo(repo);
  const suffix = `-${role}`;
  const base = `cao-${owner}-${name}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-");
  const prefix = base.slice(0, APP_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
  return `${prefix}${suffix}`;
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

export function deriveWriteInstallationTargets(controlRepository, writeRepositories = []) {
  const [controlOwner] = splitRepo(controlRepository);
  return groupInstallationTargets(
    writeRepositories.length > 0 ? writeRepositories : [controlRepository],
    controlOwner,
  );
}

function groupInstallationTargets(repositories, controlOwner) {
  const repositoriesByOwner = new Map();
  const add = (repository) => {
    const [owner, name] = splitRepo(repository);
    const normalizedOwner = owner.toLowerCase();
    if (!repositoriesByOwner.has(normalizedOwner)) {
      repositoriesByOwner.set(normalizedOwner, { owner, repositories: new Map() });
    }
    repositoriesByOwner.get(normalizedOwner).repositories.set(name.toLowerCase(), name);
  };

  for (const repository of repositories) {
    add(repository);
  }

  return [...repositoriesByOwner.values()]
    .map(({ owner, repositories }) => ({
      owner,
      repositories: [...repositories.values()].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => (
      Number(right.owner.toLowerCase() === controlOwner.toLowerCase())
      - Number(left.owner.toLowerCase() === controlOwner.toLowerCase())
      || left.owner.localeCompare(right.owner)
    ));
}

export function isManifestCode(code) {
  return /^[A-Za-z0-9_-]+$/.test(code);
}

export function githubServerUrl(environment = process.env) {
  const configured = environment.GH_HOST?.trim()
    || environment.GITHUB_SERVER_URL?.trim()
    || "github.com";
  const url = configured.includes("://") ? configured : `https://${configured}`;
  return new URL(url).origin;
}

export function isDataResidencyServer(serverUrl = githubServerUrl()) {
  return new URL(serverUrl).hostname.endsWith(".ghe.com");
}

export function splitRepo(repo) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) {
    throw new Error(`invalid repository slug: ${repo}`);
  }
  return [match[1], match[2]];
}

export function runGh(args, options = {}) {
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

export function repositoryState(repo, runner = runGh) {
  const variables = new Set(runner([
    "api",
    `/repos/${repo}/actions/variables?per_page=100`,
    "--paginate",
    "--jq",
    ".variables[].name",
  ]).split("\n").filter(Boolean));
  const secrets = new Set(runner([
    "api",
    `/repos/${repo}/actions/secrets?per_page=100`,
    "--paginate",
    "--jq",
    ".secrets[].name",
  ]).split("\n").filter(Boolean));
  return { variables, secrets };
}

export function repositoryVariableValue(repo, name, runner = runGh) {
  return runner([
    "api",
    `/repos/${repo}/actions/variables/${name}`,
    "--jq",
    ".value",
  ]);
}

export function verifyTarget(repo) {
  const [owner] = splitRepo(repo);
  const canonicalRepo = runGh(["repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (canonicalRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`repository resolved to unexpected slug: ${canonicalRepo}`);
  }
  runGh(["api", `/users/${owner}`, "--jq", ".login"]);
  return {
    owner,
    homepageUrl: `${githubServerUrl()}/${canonicalRepo}`,
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

export function appInstallationUrl(owner, slug, serverUrl = githubServerUrl()) {
  if (isDataResidencyServer(serverUrl)) {
    return `${serverUrl}/organizations/${owner}/settings/apps/${slug}/installations`;
  }
  return `${serverUrl}/apps/${slug}/installations/new`;
}

export function githubApiUrl(environment = process.env) {
  if (environment.GITHUB_API_URL?.trim()) {
    return environment.GITHUB_API_URL.trim().replace(/\/+$/, "");
  }
  const serverUrl = githubServerUrl(environment);
  const hostname = new URL(serverUrl).hostname;
  if (hostname === "github.com") return "https://api.github.com";
  if (hostname.endsWith(".ghe.com")) return `https://api.${hostname}`;
  return `${serverUrl}/api/v3`;
}

function exchangeManifestCode(code, owner) {
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
    installUrl: appInstallationUrl(owner, payload.slug),
  };
}

export function appRegistrationUrl(owner, state, serverUrl = githubServerUrl()) {
  return `${serverUrl}/organizations/${owner}/settings/apps/new?state=${state}`;
}

export async function createGitHubApp({ owner, name, homepageUrl, description, permissions, openBrowser }) {
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
      const app = exchangeManifestCode(code, owner);
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
  const manifest = buildGitHubAppManifest({
    name,
    homepageUrl,
    redirectUrl,
    description,
    permissions,
  });
  const registrationUrl = appRegistrationUrl(owner, state);
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
  console.error("- public: no");
  console.error("- permissions:");
  for (const [permission, level] of Object.entries(manifest.default_permissions).sort()) {
    console.error(`  - ${permission}: ${level}`);
  }
  console.error("- webhook events: none");
}

function createAppJwt(app, now = Date.now()) {
  if (!(app.clientId || app.id) || !app.pem) {
    throw new Error("the GitHub App ID and private key are required to verify selected repositories");
  }
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: app.clientId || app.id,
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(app.pem, "base64url")}`;
}

function appRequest(app, apiUrl, pathname, fetchImpl) {
  return fetchImpl(`${apiUrl}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${createAppJwt(app)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

export async function findInstallationForApp(app, owner, {
  fetchImpl = fetch,
  apiUrl = githubApiUrl(),
} = {}) {
  const response = await appRequest(app, apiUrl, `/orgs/${owner}/installation`, fetchImpl);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub App installation lookup failed with HTTP ${response.status}`);
  const installation = await response.json();
  if (!installation.id || String(installation.app_id) !== app.id
    || installation.account?.login?.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("GitHub returned an unexpected App installation identity");
  }
  return { id: String(installation.id), repositorySelection: installation.repository_selection };
}

async function githubJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

export async function listInstallationRepositoriesForApp(app, installationId, {
  fetchImpl = fetch,
  apiUrl = githubApiUrl(),
} = {}) {
  const appJwt = createAppJwt(app);
  const tokenPayload = await githubJson(fetchImpl, `${apiUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permissions: { metadata: "read" } }),
  }, "GitHub App installation token creation");
  if (!tokenPayload.token) {
    throw new Error("GitHub returned an incomplete installation access token");
  }

  const repositories = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubJson(fetchImpl, `${apiUrl}/installation/repositories?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenPayload.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }, "GitHub App repository verification");
    const pageRepositories = payload.repositories ?? [];
    repositories.push(...pageRepositories.map(({ full_name: fullName }) => fullName).filter(Boolean));
    if (pageRepositories.length < 100 || repositories.length >= (payload.total_count ?? repositories.length)) break;
  }
  return repositories;
}

export function validateInstallationScope(installation, owner) {
  if (installation.repositorySelection !== "selected") {
    const settingsUrl = `${githubServerUrl()}/organizations/${owner}/settings/installations/${installation.id}`;
    const error = new Error(`GitHub App is installed for all ${owner} repositories; select only approved repositories at ${settingsUrl}`);
    error.name = "InstallationScopeError";
    throw error;
  }
}

export function installationTargetInstruction(target) {
  const repositories = target.repositories.map((repository) => `${target.owner}/${repository}`).join(", ");
  return `Choose "${target.owner}", choose "Only select repositories", select ${repositories}, and save.`;
}

export function installationIncludesTarget(installation, target, listRepositories) {
  validateInstallationScope(installation, target.owner);
  if (!listRepositories) throw new Error("a selected-repository verifier is required");
  const selected = new Set(listRepositories(installation.id, target.owner).map((repository) => repository.toLowerCase()));
  return target.repositories.every((repository) => selected.has(`${target.owner}/${repository}`.toLowerCase()));
}

function openInstallation(app, openBrowser) {
  if (!openBrowser || !openUrl(app.installUrl)) {
    console.error(`Open this URL to install the App: ${app.installUrl}`);
  }
}

async function waitForInstallation(app, target) {
  console.error(`Install ${app.name || app.slug} in the browser. ${installationTargetInstruction(target)}`);
  const deadline = Date.now() + MANIFEST_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const installation = await selectedInstallationForSetup(app, target);
      if (installation) {
        console.error(`Selected-repository GitHub App installation ${installation.id} detected for ${target.owner}.`);
        return installation;
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
  throw new Error(`timed out waiting for GitHub App installation on ${target.owner}${suffix}`);
}

export async function ensureInstallations(app, targets, openBrowser, firstInstallationAlreadyOpen = false) {
  const installations = [];
  for (const [index, target] of targets.entries()) {
    const existing = await selectedInstallationForSetup(app, target);
    if (existing) {
      console.error(`Selected-repository GitHub App installation ${existing.id} already covers ${target.owner}; skipping.`);
      installations.push(existing);
      continue;
    }
    if (!(firstInstallationAlreadyOpen && index === 0)) {
      const installation = await findInstallationForApp(app, target.owner);
      const installUrl = installation
        ? `${githubServerUrl()}/organizations/${target.owner}/settings/installations/${installation.id}`
        : appInstallationUrl(target.owner, app.slug);
      console.error("Repository administrators can add their repositories to an already-approved App unless organization policy restricts this to owners. New installations still require the appropriate approval.");
      openInstallation({ ...app, installUrl }, openBrowser);
    }
    installations.push(await waitForInstallation(app, target));
  }
  return installations;
}

export async function selectedInstallationForSetup(app, target, {
  findInstallation = findInstallationForApp,
  listRepositories = listInstallationRepositoriesForApp,
} = {}) {
  const installation = await findInstallation(app, target.owner);
  if (!installation) return undefined;
  try {
    validateInstallationScope(installation, target.owner);
    const repositories = await listRepositories(app, installation.id);
    return installationIncludesTarget(installation, target, () => repositories)
      ? installation
      : undefined;
  } catch (error) {
    if (error.name === "InstallationScopeError") throw error;
    throw new Error(
      `unable to verify selected repository membership for ${app.name || app.slug} on ${target.owner}: ${error.message}`,
    );
  }
}
