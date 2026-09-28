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

export async function validateRepositoryVisibility({
  controlRepository,
  allowedRepositories,
  request,
  paginate,
}) {
  const control = await repositoryMetadata(request, repositoryName(controlRepository));
  if (control.private === true) return;

  let repositories;
  if (allowedRepositories.length > 0) {
    repositories = [];
    for (const repository of new Set([controlRepository, ...allowedRepositories].map(repositoryName))) {
      repositories.push(await repositoryMetadata(request, repository));
    }
  } else {
    const [organization] = controlRepository.split("/");
    repositories = await paginate("GET /orgs/{org}/repos", {
      org: organization,
      type: "all",
      per_page: 100,
    });
  }

  const privateCount = repositories.filter((repository) => repository.private === true).length;
  if (privateCount > 0) {
    throw new Error(
      `Public control repository cannot access private repositories (private repository count: ${privateCount})`,
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
      controlRepository: process.env.GITHUB_REPOSITORY || "",
      allowedRepositories: settings.allowed_repositories || [],
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
