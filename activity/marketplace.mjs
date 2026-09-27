import { createSign } from "node:crypto";

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]*$/;
const INTERNAL_PACKAGES = new Set(["activity", "dashboard"]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGES_PER_REGISTRY = 500;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function appJwt(appId, privateKey, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey, "base64url")}`;
}

function secret(environment, name, field) {
  const value = typeof name === "string" ? environment[name] : "";
  if (!value) throw new Error(`${field} secret is unavailable`);
  return value;
}

function apiBase(registry) {
  return String(registry["api-url"] ?? "https://api.github.com").replace(/\/+$/, "");
}

async function githubRequest(fetchImpl, url, token, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: ["Bearer", token].join(" ") } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed with status ${response.status}`);
  return response;
}

async function registryToken(registry, { fetchImpl, environment }) {
  const auth = registry.auth ?? { type: "none" };
  if (auth.type === "none") return "";
  if (auth.type === "pat") return secret(environment, auth.secret, "registry PAT");
  if (auth.type !== "github-app") throw new Error("registry authentication type is unsupported");
  const appId = secret(environment, auth["app-id-secret"], "registry GitHub App id");
  const privateKey = secret(environment, auth["private-key-secret"], "registry GitHub App private key");
  const installationId = secret(environment, auth["installation-id-secret"], "registry GitHub App installation id");
  const jwt = appJwt(appId, privateKey);
  const response = await githubRequest(
    fetchImpl,
    `${apiBase(registry)}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { method: "POST" },
  );
  const payload = await response.json();
  if (typeof payload.token !== "string" || !payload.token) {
    throw new Error("registry GitHub App token response is invalid");
  }
  return payload.token;
}

function scalar(source, name) {
  const value = source.match(new RegExp(`^${name}:[ \\t]*(.+?)\\s*$`, "m"))?.[1]?.trim() ?? "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function includes(source) {
  const block = source.match(/^includes:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] ?? "";
  return block.split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(?:source:\s+)?([^#]+?)\s*$/)?.[1])
    .filter(Boolean)
    .map((value) => value.replace(/^['"]|['"]$/g, ""));
}

export function parsePackageManifest(source, coordinates) {
  if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) throw new Error("package manifest exceeds size limit");
  const name = scalar(source, "name");
  if (!name) throw new Error("package manifest name is required");
  const contents = includes(source);
  const version = scalar(source, "version") || coordinates.ref;
  const packagePath = coordinates.path.replace(/\/?aw\.yml$/, "");
  const sourceCoordinate = `${coordinates.repository}${packagePath ? `/${packagePath}` : ""}@${coordinates.resolvedCommit}`;
  return {
    id: `${coordinates.registryId}:${sourceCoordinate}`,
    "registry-id": coordinates.registryId,
    "registry-name": coordinates.registryName,
    "registry-precedence": coordinates.precedence,
    name,
    description: scalar(source, "description"),
    publisher: coordinates.repository.split("/")[0],
    repository: coordinates.repository,
    path: packagePath,
    ref: coordinates.ref,
    "resolved-commit": coordinates.resolvedCommit,
    version,
    icon: scalar(source, "icon") || "workflow",
    artwork: scalar(source, "artwork") || "",
    contents,
    source: sourceCoordinate,
    "add-command": `./cao.sh add ${sourceCoordinate}`,
  };
}

function validateRegistry(registry, index) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error(`registry ${index} is invalid`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(registry.id ?? "")) throw new Error(`registry ${index} id is invalid`);
  if (!REPOSITORY_PATTERN.test(registry.repository ?? "")) throw new Error(`registry ${registry.id} repository is invalid`);
  if (typeof registry.ref !== "string" || !registry.ref.trim()) throw new Error(`registry ${registry.id} ref is required`);
  if (!SAFE_PATH_PATTERN.test(registry.path ?? "")) throw new Error(`registry ${registry.id} path is invalid`);
  return {
    ...registry,
    path: String(registry.path ?? "").replace(/^\/|\/$/g, ""),
    name: String(registry.name ?? registry.id),
  };
}

function safeDiagnostic(error, registry, environment) {
  let message = String(error?.message ?? error);
  for (const reference of Object.values(registry?.auth ?? {}).filter((value) => typeof value === "string")) {
    const value = environment[reference];
    if (typeof value === "string" && value) message = message.replaceAll(value, "[redacted]");
  }
  return message.slice(0, 500);
}

async function resolveRegistry(registry, precedence, options) {
  const token = await registryToken(registry, options);
  const base = apiBase(registry);
  const repositoryPath = registry.repository.split("/").map(encodeURIComponent).join("/");
  const commitResponse = await githubRequest(
    options.fetchImpl,
    `${base}/repos/${repositoryPath}/commits/${encodeURIComponent(registry.ref)}`,
    token,
  );
  const commitPayload = await commitResponse.json();
  const commit = String(commitPayload.sha ?? "");
  if (!COMMIT_PATTERN.test(commit)) throw new Error("registry ref did not resolve to a commit");
  const treeResponse = await githubRequest(
    options.fetchImpl,
    `${base}/repos/${repositoryPath}/git/trees/${commit}?recursive=1`,
    token,
  );
  const treePayload = await treeResponse.json();
  if (!Array.isArray(treePayload.tree) || treePayload.truncated === true) {
    throw new Error("registry tree is unavailable or truncated");
  }
  const prefix = registry.path ? `${registry.path}/` : "";
  const manifests = treePayload.tree
    .filter((entry) => entry?.type === "blob"
      && typeof entry.path === "string"
      && entry.path.startsWith(prefix)
      && entry.path.endsWith("/aw.yml")
      && entry.path !== `${prefix}aw.yml`)
    .filter((entry) => !INTERNAL_PACKAGES.has(entry.path.slice(prefix.length).split("/", 1)[0]))
    .slice(0, MAX_PACKAGES_PER_REGISTRY);
  return Promise.all(manifests.map(async (entry) => {
    const blobResponse = await githubRequest(options.fetchImpl, `${base}/repos/${repositoryPath}/git/blobs/${entry.sha}`, token);
    const blob = await blobResponse.json();
    if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error("package manifest blob is invalid");
    const manifest = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (scalar(manifest, "private") === "true") return null;
    return parsePackageManifest(manifest, {
      registryId: registry.id,
      registryName: registry.name,
      precedence,
      repository: registry.repository,
      path: entry.path,
      ref: registry.ref,
      resolvedCommit: commit,
    });
  })).then((packages) => packages.filter(Boolean));
}

export async function resolveMarketplace(marketplace, options = {}) {
  const registries = marketplace?.registries ?? [];
  if (!Array.isArray(registries)) throw new Error("marketplace registries must be a sequence");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const environment = options.environment ?? process.env;
  const packages = [];
  const diagnostics = [];
  for (let index = 0; index < registries.length; index += 1) {
    let registry;
    try {
      registry = validateRegistry(registries[index], index);
      const resolved = await resolveRegistry(registry, index, { fetchImpl, environment });
      packages.push(...resolved);
      diagnostics.push({ "registry-id": registry.id, status: "available", packages: resolved.length });
    } catch (error) {
      diagnostics.push({
        "registry-id": registry?.id ?? String(registries[index]?.id ?? `registry-${index}`),
        status: "unavailable",
        message: safeDiagnostic(error, registry ?? registries[index], environment),
      });
    }
  }
  const seen = new Set();
  const ordered = packages
    .sort((left, right) => left["registry-precedence"] - right["registry-precedence"]
      || left.repository.localeCompare(right.repository)
      || left.path.localeCompare(right.path))
    .filter((entry) => {
      const coordinate = `${entry.repository}/${entry.path}`.toLowerCase();
      if (seen.has(coordinate)) return false;
      seen.add(coordinate);
      return true;
    });
  return { packages: ordered, diagnostics };
}
