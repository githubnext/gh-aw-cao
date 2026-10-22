import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";

function repositoryName(repository) {
  return String(repository || "").trim();
}

async function repositoryMetadata(request, repository) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("repository visibility check requires owner/repository names");
  return (await request("GET /repos/{owner}/{repo}", { owner, repo })).data;
}

function isPublic(repository) {
  return repository.visibility
    ? repository.visibility === "public"
    : repository.private !== true;
}

export function assertPublicRepository(metadata, repository) {
  if (metadata?.visibility !== "public" || metadata?.private !== false
    || metadata?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`Public-only Activity requires verified public visibility and unchanged identity for ${repository}`);
  }
}

export function assertMonitoringRepository(metadata, repository, controlRepository) {
  if (repository.toLowerCase() !== controlRepository?.toLowerCase()) {
    assertPublicRepository(metadata, repository);
    return;
  }
  if (metadata?.full_name?.toLowerCase() !== repository.toLowerCase()
    || !["public", "private", "internal"].includes(metadata?.visibility)
    || metadata?.private !== (metadata.visibility !== "public")) {
    throw new Error(`Monitoring requires verified control repository visibility and unchanged identity for ${repository}`);
  }
}

async function ownerRepositories(paginate, owner) {
  try {
    return await paginate("GET /orgs/{org}/repos", {
      org: owner,
      type: "all",
      per_page: 100,
    });
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  try {
    return await paginate(
      "GET /installation/repositories",
      { per_page: 100 },
      (response) => (response.data.repositories || []).filter(
        (repository) => repository.full_name?.split("/", 1)[0]?.toLowerCase() === owner.toLowerCase(),
      ),
    );
  } catch {
    return paginate(
      "GET /user/repos",
      { per_page: 100 },
      (response) => (response.data || []).filter(
        (repository) => repository.full_name?.split("/", 1)[0]?.toLowerCase() === owner.toLowerCase(),
      ),
    );
  }
}

export async function validateRepositoryVisibility({
  controlRepository,
  allowedRepositories,
  publicOnly = false,
  request,
  paginate,
}) {
  const control = await repositoryMetadata(request, repositoryName(controlRepository));
  if (publicOnly) {
    if (!Array.isArray(allowedRepositories) || allowedRepositories.length === 0) {
      throw new Error("Public-only Activity requires an exact nonempty repository scope");
    }
    assertMonitoringRepository(control, controlRepository, controlRepository);
    for (const repository of new Set(allowedRepositories.map(repositoryName))) {
      assertMonitoringRepository(await repositoryMetadata(request, repository), repository, controlRepository);
    }
    return;
  }
  if (!isPublic(control)) return;

  let repositories;
  if (allowedRepositories.length > 0) {
    repositories = [];
    for (const repository of new Set([controlRepository, ...allowedRepositories].map(repositoryName))) {
      repositories.push(await repositoryMetadata(request, repository));
    }
  } else {
    const [owner] = controlRepository.split("/");
    repositories = await ownerRepositories(paginate, owner);
  }

  const nonPublicCount = repositories.filter((repository) => !isPublic(repository)).length;
  if (nonPublicCount > 0) {
    throw new Error(
      `Public control repository cannot access non-public repositories (non-public repository count: ${nonPublicCount})`,
    );
  }
}

export async function main(actions = {}, args) {
  setActionsGlobals(actions);
  const [settingsPath] = args ?? process.argv.slice(2);
  if (!settingsPath) throw new Error("usage: repository-visibility.mjs <control-settings.json>");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  log.group`Validate repository visibility boundary`;
  try {
    await validateRepositoryVisibility({
      controlRepository: (settings.activity_public_only === true
        ? process.env.GITHUB_REPOSITORY
        : process.env.ACTIVITY_VISIBILITY_REPOSITORY || process.env.GITHUB_REPOSITORY) || "",
      allowedRepositories: settings.allowed_repositories || [],
      publicOnly: settings.activity_public_only === true,
      request: actions.github.request,
      paginate: actions.github.paginate,
    });
    log.info`Repository visibility boundary validated`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  throw new Error("repository-visibility.mjs must run with GitHub Actions Toolkit APIs");
}
