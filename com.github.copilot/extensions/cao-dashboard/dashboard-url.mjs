import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CATALOG_REPOSITORY = "githubnext/gh-aw-cao";

export function normalizeRepository(value) {
  if (typeof value !== "string") return undefined;

  const repository = value.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return undefined;
  }
  return repository;
}

export function repositoryFromRemote(value) {
  if (typeof value !== "string") return undefined;

  const remote = value.trim().replace(/\.git$/, "");
  const match =
    remote.match(/^git@github\.com:([^/]+\/[^/]+)$/i) ??
    remote.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i) ??
    remote.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return normalizeRepository(match?.[1]);
}

export function pagesUrlForRepository(repository, sitePath) {
  const normalized = normalizeRepository(repository);
  if (!normalized) {
    throw new Error("Repository must use the OWNER/REPOSITORY format.");
  }

  const [owner, name] = normalized.split("/");
  const isAccountSite = name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  const defaultPath =
    normalized.toLowerCase() === CATALOG_REPOSITORY ? "cao" : "";
  const path = normalizeSitePath(sitePath ?? defaultPath);
  const repositoryPath = isAccountSite ? "" : `/${name}`;
  const siteSuffix = path ? `/${path}` : "";
  return `https://${owner.toLowerCase()}.github.io${repositoryPath}${siteSuffix}/`;
}

export async function resolveDashboardUrl(
  input = {},
  {
    cwd = process.cwd(),
    environment = process.env,
    readRemote = async () => {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", cwd, "remote", "get-url", "origin"],
        { timeout: 5_000 },
      );
      return stdout;
    },
  } = {},
) {
  if (input.url) return normalizeDashboardUrl(input.url);

  let repository = normalizeRepository(input.repository);
  if (!repository) repository = normalizeRepository(environment.GITHUB_REPOSITORY);
  if (!repository) {
    try {
      repository = repositoryFromRemote(await readRemote());
    } catch {
      repository = undefined;
    }
  }
  if (!repository) {
    throw new Error(
      "Could not determine the current GitHub repository. Specify repository as OWNER/REPOSITORY or provide an HTTPS dashboard URL.",
    );
  }

  return pagesUrlForRepository(repository, input.sitePath);
}

function normalizeDashboardUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Dashboard URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Dashboard URL must use HTTPS.");
  }
  return url.href;
}

function normalizeSitePath(value) {
  if (typeof value !== "string") {
    throw new Error("Site path must be a string.");
  }

  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  if (
    path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    !/^[A-Za-z0-9._~/-]+$/.test(path)
  ) {
    throw new Error("Site path must be a safe relative URL path.");
  }
  return path;
}
