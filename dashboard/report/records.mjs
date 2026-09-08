import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { normalizeVersion, updateState } from "../../activity/version.mjs";
import { parseRolloutMode } from "./dashboard-language-sources.mjs";
import { firstText } from "./text-utils.mjs";

const apiRoot = "https://api.github.com";
const rateLimitDocs = "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api";

class GitHubRateLimitError extends Error {
  constructor(pathname, response, detail) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0
      ? new Date(resetSeconds * 1000).toISOString()
      : "";
    const retry = resetAt
      ? ` Retry after ${resetAt}.`
      : Number.isFinite(retryAfter) && retryAfter > 0
        ? ` Retry after ${Math.ceil(retryAfter)} seconds.`
        : "";
    super(`GitHub API rate limit exceeded for ${pathname}.${retry} ${detail || "Collection stopped before the dashboard data could be completed."} See ${rateLimitDocs}`);
    this.name = "GitHubRateLimitError";
    this.status = response.status;
    this.pathname = pathname;
    this.resetAt = resetAt;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeMode(mode) {
  return parseRolloutMode(mode);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function repositoryContentPath(repositoryName, filePath) {
  const encodedPath = String(filePath)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/repos/${repositoryName}/contents/${encodedPath}`;
}

function rawWorkflowUrl(repositoryName, sha, filePath) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(sha))) return "";
  const encodedPath = String(filePath)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://raw.githubusercontent.com/${repositoryName}/${sha}/${encodedPath}`;
}

function ghAwPayloads(lockSource) {
  const payloads = { ghAwMetadata: null, ghAwManifest: null };
  const fields = {
    "# gh-aw-metadata: ": "ghAwMetadata",
    "# gh-aw-manifest: ": "ghAwManifest",
  };
  for (const line of lockSource.split(/\r?\n/)) {
    const entry = Object.entries(fields).find(([prefix]) => line.startsWith(prefix));
    if (!entry) continue;
    const [prefix, field] = entry;
    try {
      const value = JSON.parse(line.slice(prefix.length));
      if (value && typeof value === "object" && !Array.isArray(value)) payloads[field] = value;
    } catch {
      // Malformed generated metadata remains unavailable.
    }
  }
  return payloads;
}

function plainText(markdown = "") {
  return markdown
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/```[^]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[#>*+-]+\s*/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(markdown = "") {
  const text = plainText(markdown.replace(/>\s*Generated from[^]*$/m, ""));
  return text.length > 700 ? `${text.slice(0, 697)}...` : text;
}

function workflowFrom(body = "") {
  const heading = body.match(/^###\s+(.+)$/m)?.[1]?.trim();
  const provenance = body.match(/Generated from \[([^\]]+)\]\([^)]*\/actions\/runs\/\d+\)/)?.[1];
  return provenance || heading || "GitHub Agentic Workflow";
}

function runUrlFrom(body = "") {
  return body.match(/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/)?.[0] || "";
}

function repositoryFrom(body = "") {
  return body.match(/(?:target repository|target repo):\s*`?([a-z0-9][a-z0-9-]*\/[a-z0-9._-]+)/i)?.[1] || "";
}

function markerFrom(body = "", marker) {
  return body.match(new RegExp(`<!--\\s*[\\w-]+:${marker}=([^>]+?)\\s*-->`, "i"))?.[1]?.trim() || "";
}

function workflowIdFrom(body = "") {
  const marker = body.match(/<!--\s*gh-aw-workflow-id:\s*([a-z0-9_.-]{1,100})\s*-->/i)?.[1];
  return marker?.replace(/\.md$/i, "") || "";
}

function generatedMetadataFrom(body = "") {
  const text = plainText(body);
  const generatedLine = text.match(/Generated (?:from|by|with)\b[^.]+/i)?.[0] || text;
  const field = (name) => generatedLine.match(new RegExp(`${name}:\\s*([^·,;]+)`, "i"))?.[1]?.trim() || "";
  return {
    engine: field("engine") || field("agentic engine") || field("agent"),
    engineVersion: field("engine version") || field("agent version"),
    requestedModel: field("requested model") || field("model"),
    resolvedModel: field("resolved model"),
  };
}

function modelMetadataFrom(body = "") {
  const generated = generatedMetadataFrom(body);
  return {
    engine: firstText(markerFrom(body, "engine"), markerFrom(body, "agentic-engine"), generated.engine),
    engineVersion: firstText(markerFrom(body, "engine-version"), markerFrom(body, "agent-version"), generated.engineVersion),
    requestedModel: firstText(markerFrom(body, "requested-model"), generated.requestedModel),
    resolvedModel: firstText(markerFrom(body, "resolved-model"), generated.resolvedModel),
  };
}

function aicFrom(body = "") {
  const provenance = plainText(body).match(/Generated (?:from|by)[^·]*·\s*(?:[a-z][\w.-]*\s+)?([\d,.]+)\s+AIC\b/i);
  return provenance ? Number(provenance[1].replaceAll(",", "")) : null;
}

function hasReportWarning(bodyHtml = "") {
  return /markdown-alert-warning/i.test(bodyHtml);
}

function configuredModeFor(bundle, controlSettings) {
  return normalizeMode(controlSettings.packages?.[bundle.controlPackage]?.mode);
}

function bundleFor(reportDefinitions, ...values) {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  return reportDefinitions.find((definition) => {
    const terms = [definition.id, definition.name, ...(definition.workers || []).flatMap((worker) => [worker.id, worker.name, worker.trackerId])];
    return terms.filter(Boolean).some((term) => text.includes(String(term).toLowerCase()));
  }) || null;
}

function targetRepositoryFromRun(run, fallback, allowedRepositories, owner) {
  const candidates = [...(run?.display_title || "").matchAll(/\b([a-z0-9][a-z0-9-]*\/[a-z0-9._-]+)\b/gi)]
    .map((candidate) => candidate[1]);
  return candidates.find((candidate) => allowedRepositories.size === 0
    ? candidate.split("/")[0].toLowerCase() === owner.toLowerCase()
    : allowedRepositories.has(candidate.toLowerCase())) || fallback;
}

function recordFromIssue(issue, outputRepository, reportDefinitions) {
  const body = issue.body || "";
  const workflowId = workflowIdFrom(body);
  const workflow = workflowFrom(body);
  const modelMetadata = modelMetadataFrom(body);
  const generatedSafeOutput = /Generated (?:from|with) \[[^\]]+\]\([^)]*\/actions\/runs\/\d+\)/.test(body);
  const bundle = bundleFor(reportDefinitions, issue.title, workflow, body);
  const generatedSafeOutputTitle = /^\[[^\]]+\]\s/.test(issue.title) && bundle;
  if (!generatedSafeOutputTitle && !generatedSafeOutput) return null;
  if (issue.title === "[aw] No-Op Runs") return null;
  return {
    id: `${outputRepository}-${issue.pull_request ? "pr" : "issue"}-${issue.number}`,
    number: issue.number,
    bundle: bundle?.id || "",
    kind: issue.pull_request ? "pull-request" : "issue",
    title: issue.title,
    summary: summarize(issue.body),
    bodyHtml: issue.body_html || "",
    state: issue.state.toLowerCase(),
    url: safeUrl(issue.html_url),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    workflow,
    workflowId,
    runUrl: runUrlFrom(body),
    repository: repositoryFrom(body) || outputRepository,
    outputRepository,
    bundleId: markerFrom(body, "bundle"),
    correlationId: markerFrom(body, "correlation"),
    aic: aicFrom(body),
    engine: modelMetadata.engine,
    engineVersion: modelMetadata.engineVersion,
    requestedModel: modelMetadata.requestedModel,
    resolvedModel: modelMetadata.resolvedModel,
    warning: hasReportWarning(issue.body_html),
  };
}

function recordFromComment(comment, issueByUrl, outputRepository, reportDefinitions) {
  const issue = issueByUrl.get(comment.issue_url);
  const body = comment.body || "";
  const workflow = workflowFrom(body);
  const modelMetadata = modelMetadataFrom(body);
  const bundle = bundleFor(reportDefinitions, workflow, issue?.title, body);
  const generatedSafeOutput = /Generated from \[[^\]]+\]\([^)]*\/actions\/runs\/\d+\)/.test(body);
  if (!generatedSafeOutput) return null;
  const noop = issue?.title === "[aw] No-Op Runs";
  return {
    id: `${outputRepository}-comment-${comment.id}`,
    bundle: bundle?.id || "",
    kind: noop ? "noop" : "comment",
    title: noop ? `${workflow} completed with no action` : `Comment on ${issue?.title || "safe output"}`,
    summary: summarize(body),
    bodyHtml: comment.body_html || "",
    state: noop ? "complete" : issue?.state?.toLowerCase() || "published",
    url: safeUrl(comment.html_url),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    workflow,
    runUrl: runUrlFrom(body),
    repository: repositoryFrom(body) || outputRepository,
    outputRepository,
    bundleId: markerFrom(body, "bundle"),
    correlationId: markerFrom(body, "correlation"),
    aic: aicFrom(body),
    engine: modelMetadata.engine,
    engineVersion: modelMetadata.engineVersion,
    requestedModel: modelMetadata.requestedModel,
    resolvedModel: modelMetadata.resolvedModel,
    warning: hasReportWarning(comment.body_html),
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function collectDashboardRecordsImpl({
  repository,
  token,
  pagesToken = token,
  controlSettings,
  inventory,
  deployedInventory,
  previousSnapshot,
  requestedRepositories = [],
  fetchImpl = fetch,
  generatedAt = new Date().toISOString(),
}) {
  const [owner, repo] = repository.split("/");
  const policyRepositories = [...new Set((controlSettings.allowed_repositories || []).map((value) => value.toLowerCase()))];
  const normalizedRequestedRepositories = [...new Set(requestedRepositories
    .map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (policyRepositories.length > 0 && normalizedRequestedRepositories.some((value) => !policyRepositories.includes(value))) {
    throw new Error("REPORT_ALLOWED_REPOS cannot widen checked-in control policy");
  }
  const allowedRepositories = new Set(normalizedRequestedRepositories.length > 0 ? normalizedRequestedRepositories : policyRepositories);
  const bundleDefinitions = inventory.bundles;
  const reportDefinitions = [
    ...bundleDefinitions,
    ...(inventory.standalone || []).map((workflow) => ({ ...workflow, workers: [], missingWorkers: [] })),
  ];

  let rateLimitError = null;

  async function github(pathname, authToken = token) {
    if (rateLimitError) throw rateLimitError;
    const response = await fetchImpl(`${apiRoot}${pathname}`, {
      headers: {
        Accept: "application/vnd.github.full+json",
        Authorization: `Bearer ${authToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const responseText = await response.text();
      let detail = "";
      try {
        detail = JSON.parse(responseText).message || "";
      } catch {
        detail = responseText.trim();
      }
      const rateLimited = response.status === 429
        || (response.status === 403
          && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(detail)));
      if (rateLimited) {
        rateLimitError = new GitHubRateLimitError(pathname, response, detail);
        throw rateLimitError;
      }
      throw new Error(`GitHub API ${response.status} for ${pathname}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
  }

  async function githubOptional(pathname, fallback) {
    try {
      return await github(pathname);
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      log.warning`${error.message}; continuing without optional repository metadata`;
      return fallback;
    }
  }

  async function githubDownload(downloadUrl) {
    const url = safeUrl(downloadUrl);
    if (!url || new URL(url).hostname !== "raw.githubusercontent.com") {
      throw new Error("GitHub workflow content URL is unavailable");
    }
    const authorization = ["Bearer", token].join(" ");
    const response = await fetchImpl(url, {
      headers: { Authorization: authorization },
    });
    if (!response.ok) {
      throw new Error(`GitHub workflow content download returned HTTP ${response.status}`);
    }
    return response.text();
  }

  const reportRepositoryNames = [...new Set([
    repository,
    ...(deployedInventory.workflows || []).map((workflow) => workflow.repository),
    ...(deployedInventory.allowedRepositories || []),
    ...allowedRepositories,
  ].filter(Boolean))].sort();
  const remoteWorkflowRepositories = [...allowedRepositories]
    .filter((repositoryName) => repositoryName !== repository.toLowerCase());
  const repositoryStates = await mapWithConcurrency(reportRepositoryNames, 4, async (repositoryName) => {
    try {
      const metadata = await github(`/repos/${repositoryName}`);
      const visibility = ["public", "private", "internal"].includes(metadata.visibility)
        ? metadata.visibility
        : metadata.private === true ? "private" : metadata.private === false ? "public" : "unknown";
      return {
        repository: repositoryName,
        complete: visibility !== "unknown" && Boolean(metadata.default_branch),
        visibility,
        defaultBranch: metadata.default_branch || "",
        ...(visibility === "unknown" || !metadata.default_branch
          ? { reason: "Repository visibility or default branch is unavailable" }
          : {}),
      };
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      log.warning`${error.message}; remote workflow discovery will be incomplete for ${repositoryName}`;
      return { repository: repositoryName, complete: false, visibility: "unknown", reason: error.message };
    }
  });
  const repositoryStateByName = new Map(
    repositoryStates.map((state) => [state.repository.toLowerCase(), state]),
  );
  const controlRepositoryState = repositoryStateByName.get(repository.toLowerCase());
  if (!controlRepositoryState?.complete) {
    throw new Error(controlRepositoryState?.reason || "Control repository visibility is unavailable");
  }
  const hasPrivateData = deployedInventory.includePrivate === true
    || repositoryStates.some((state) => state.visibility === "private" || state.visibility === "internal");
  if (hasPrivateData) {
    const pages = await github(`/repos/${owner}/${repo}/pages`, pagesToken);
    if (pages.public !== false) {
      throw new Error(`Refusing to publish non-public repository data because GitHub Pages for ${repository} is public`);
    }
  }

  async function githubPages(pathname, maxPages = 10) {
    const separator = pathname.includes("?") ? "&" : "?";
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await github(`${pathname}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Expected an array from ${pathname}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  async function githubWorkflowPages(repositoryName, maxPages = 10) {
    const workflows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await github(`/repos/${repositoryName}/actions/workflows?per_page=100&page=${page}`);
      if (!Array.isArray(response.workflows)) throw new Error(`Expected workflows from ${repositoryName}`);
      workflows.push(...response.workflows);
      if (response.workflows.length < 100) break;
    }
    return workflows;
  }

  const previousRemoteWorkflowByIdentity = new Map(
    (previousSnapshot?.remoteWorkflows || []).map((workflow) => [
      `${String(workflow.repository).toLowerCase()}:${String(workflow.path).toLowerCase()}`,
      workflow,
    ]),
  );

  async function repositoryWorkflowSource(repositoryName, latestVersion) {
    const repositoryState = repositoryStateByName.get(repositoryName.toLowerCase());
    if (!repositoryState?.complete) {
      return {
        repository: repositoryName,
        complete: false,
        workflows: [],
        reason: repositoryState?.reason || "Repository visibility is unavailable",
      };
    }
    try {
      const revision = await github(
        `/repos/${repositoryName}/commits/${encodeURIComponent(repositoryState.defaultBranch)}`,
      );
      const commitSha = String(revision.sha || "");
      if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) {
        throw new Error(`Expected a default-branch commit from ${repositoryName}`);
      }
      const [workflows, workflowFiles] = await Promise.all([
        githubWorkflowPages(repositoryName),
        github(`${repositoryContentPath(repositoryName, ".github/workflows")}?ref=${commitSha}`),
      ]);
      if (!Array.isArray(workflowFiles)) {
        throw new Error(`Expected workflow files from ${repositoryName}`);
      }
      const workflowFileByPath = new Map(workflowFiles.map((file) => [file.path, file]));
      const agenticWorkflows = workflows.filter((workflow) => String(workflow.path || "").endsWith(".lock.yml"));
      return {
        repository: repositoryName,
        complete: true,
        workflows: await mapWithConcurrency(agenticWorkflows, 8, async (workflow) => {
          const lockFile = workflowFileByPath.get(workflow.path);
          const previous = previousRemoteWorkflowByIdentity.get(
            `${repositoryName.toLowerCase()}:${String(workflow.path).toLowerCase()}`,
          );
          let metadataAvailable = previous?.lockMetadataAvailable === true
            && previous.lockSha === lockFile?.sha;
          let payloads = metadataAvailable
            ? {
              ghAwMetadata: previous.ghAwMetadata || null,
              ghAwManifest: previous.ghAwManifest || null,
            }
            : { ghAwMetadata: null, ghAwManifest: null };
          const downloadUrl = rawWorkflowUrl(repositoryName, commitSha, workflow.path);
          if (!metadataAvailable && downloadUrl) {
            try {
              payloads = ghAwPayloads(await githubDownload(downloadUrl));
              metadataAvailable = true;
            } catch (error) {
              log.warning`${error.message}; generated metadata is unavailable for ${repositoryName}/${workflow.path}`;
            }
          }
          const ghAwVersion = normalizeVersion(payloads.ghAwMetadata?.compiler_version);
          return {
            repository: repositoryName,
            visibility: repositoryState.visibility,
            path: workflow.path,
            name: workflow.name || workflow.path.split("/").at(-1)?.replace(/\.lock\.yml$/, "") || "Unknown workflow",
            state: workflow.state || "unknown",
            htmlUrl: safeUrl(workflow.html_url),
            createdAt: workflow.created_at || null,
            updatedAt: workflow.updated_at || null,
            role: "standalone",
            runHealth: { runRecords: [] },
            sourceAvailable: false,
            ghAwVersion,
            currentGhAwVersion: latestVersion,
            updateState: updateState(ghAwVersion, latestVersion),
            lockSha: metadataAvailable ? lockFile?.sha : null,
            lockMetadataAvailable: metadataAvailable,
            ...payloads,
          };
        }),
      };
    } catch (error) {
      if (error instanceof GitHubRateLimitError) throw error;
      log.warning`${error.message}; remote workflow discovery will be incomplete for ${repositoryName}`;
      return { repository: repositoryName, complete: false, workflows: [], reason: error.message };
    }
  }

  async function repositoryReportSources(repositoryName) {
    const required = repositoryName.toLowerCase() === repository.toLowerCase();
    const repositoryState = repositoryStateByName.get(repositoryName.toLowerCase());
    if (!required && !repositoryState?.complete) {
      return { repository: repositoryName, issues: [], comments: [], artifacts: [] };
    }
    const optional = async (loader, fallback) => {
      try {
        return await loader();
      } catch (error) {
        if (error instanceof GitHubRateLimitError) throw error;
        if (required) throw error;
        log.warning`${error.message}; durable reports will be incomplete for ${repositoryName}`;
        return fallback;
      }
    };
    const [issues, comments, artifacts] = await Promise.all([
      optional(() => githubPages(`/repos/${repositoryName}/issues?state=all&sort=updated&direction=desc`), []),
      optional(() => githubPages(`/repos/${repositoryName}/issues/comments?sort=updated&direction=desc`), []),
      optional(() => github(`/repos/${repositoryName}/actions/artifacts?per_page=100`), { artifacts: [] }),
    ]);
    return { repository: repositoryName, issues, comments, artifacts: artifacts.artifacts || [] };
  }

  async function recordFromArtifact(artifact, outputRepository) {
    if (artifact.expired || !artifact.name.startsWith("review-")) return null;
    const runId = artifact.workflow_run?.id;
    if (!runId) return null;
    const cacheKey = `${outputRepository}/${runId}`;
    if (!runCache.has(cacheKey)) {
      runCache.set(cacheKey, github(`/repos/${outputRepository}/actions/runs/${runId}`));
    }
    const run = await runCache.get(cacheKey);
    const bundle = bundleFor(reportDefinitions, run.name, run.display_title, artifact.name);
    return {
      id: `${outputRepository}-artifact-${artifact.id}`,
      bundle: bundle?.id || "",
      kind: "review-bundle",
      mode: "review",
      title: artifact.name,
      summary: `Artifact-backed proposal from ${run.display_title || run.name}.`,
      state: "available",
      url: safeUrl(run.html_url),
      createdAt: artifact.created_at,
      updatedAt: artifact.updated_at,
      workflow: run.name,
      runUrl: safeUrl(run.html_url),
      repository: targetRepositoryFromRun(run, outputRepository, allowedRepositories, owner),
      outputRepository,
      runtimeRepository: outputRepository,
      workflowPath: run.path || "",
      workflowId: run.path?.split("/").at(-1)?.replace(/\.lock\.yml$/, "") || "",
      bundleId: "",
      correlationId: String(runId),
      conclusion: run.conclusion || "unknown",
      aic: null,
      warning: false,
    };
  }

  const [reportSources, latestRelease] = await Promise.all([
    mapWithConcurrency(reportRepositoryNames, 4, repositoryReportSources),
    remoteWorkflowRepositories.length > 0
      ? githubOptional("/repos/github/gh-aw/releases/latest", {})
      : null,
  ]);
  const latestVersion = normalizeVersion(latestRelease?.tag_name);
  const remoteWorkflowSources = await mapWithConcurrency(
    remoteWorkflowRepositories,
    4,
    (repositoryName) => repositoryWorkflowSource(repositoryName, latestVersion),
  );
  const remoteWorkflows = remoteWorkflowSources.flatMap((source) => source.workflows);
  const workflowDiscovery = {
    complete: remoteWorkflowSources.every((source) => source.complete),
    repositoriesExpected: remoteWorkflowRepositories.length,
    repositoriesObserved: remoteWorkflowSources.filter((source) => source.complete).length,
    workflowsObserved: remoteWorkflows.length,
    failures: remoteWorkflowSources.filter((source) => !source.complete)
      .map((source) => ({ repository: source.repository, reason: source.reason })),
  };
  const issueByUrl = new Map(reportSources.flatMap((source) => source.issues.map((issue) => [issue.url, issue])));
  const runCache = new Map();

  async function metadataFromRunUrl(runUrl) {
    const match = runUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
    if (!match) return { mode: "unknown", conclusion: "unknown", repository: "", runtimeRepository: "", workflowPath: "", workflowId: "", workflowName: "" };
    const [, runOwner, runRepository, runId] = match;
    const cacheKey = `${runOwner}/${runRepository}/${runId}`;
    if (!runCache.has(cacheKey)) {
      runCache.set(cacheKey, githubOptional(`/repos/${runOwner}/${runRepository}/actions/runs/${runId}`, null));
    }
    const run = await runCache.get(cacheKey);
    const mode = parseRolloutMode(run?.display_title);
    const workflowPath = run?.path || "";
    return {
      mode: normalizeMode(mode),
      conclusion: run?.conclusion || "unknown",
      repository: targetRepositoryFromRun(run, `${runOwner}/${runRepository}`, allowedRepositories, owner),
      runtimeRepository: `${runOwner}/${runRepository}`,
      workflowPath,
      workflowId: workflowPath.split("/").at(-1)?.replace(/\.lock\.yml$/, "") || "",
      workflowName: run?.name || "",
    };
  }

  const discoveredRecords = [
    ...reportSources.flatMap((source) => source.issues
      .map((issue) => recordFromIssue(issue, source.repository, reportDefinitions)).filter(Boolean)),
    ...reportSources.flatMap((source) => source.comments
      .map((comment) => recordFromComment(comment, issueByUrl, source.repository, reportDefinitions)).filter(Boolean)),
    ...(await Promise.all(reportSources.flatMap((source) => source.artifacts
      .map((artifact) => recordFromArtifact(artifact, source.repository))))).filter(Boolean),
  ];
  const records = (await Promise.all(discoveredRecords.map(async (record) => {
    const metadata = record.mode && record.conclusion
      ? { mode: record.mode, conclusion: record.conclusion, runtimeRepository: "", workflowPath: "", workflowId: "", workflowName: "" }
      : await metadataFromRunUrl(record.runUrl);
    const workflowId = record.workflowId || metadata.workflowId;
    const inventoryWorkflow = (inventory.workflows || []).find((workflow) => workflow.id === workflowId);
    const markerBundle = record.workflowId ? bundleDefinitions.find((definition) => (
      definition.id === record.workflowId
      || definition.workers.some((worker) => worker.id === record.workflowId)
    )) : null;
    const runtimeBundle = metadata.runtimeRepository?.toLowerCase() === repository.toLowerCase()
      ? bundleDefinitions.find((definition) => (
        definition.id === workflowId
        || definition.workers.some((worker) => worker.id === workflowId)
      ))
      : null;
    const bundle = markerBundle
      || bundleDefinitions.find((definition) => definition.id === record.bundle)
      || runtimeBundle;
    const inferredMode = record.outputRepository?.toLowerCase() === record.repository?.toLowerCase() ? "live" : "review";
    return {
      ...record,
      bundle: bundle?.id || "",
      mode: normalizeMode(record.mode) !== "unknown"
        ? normalizeMode(record.mode)
        : metadata.mode !== "unknown"
          ? metadata.mode
          : bundle
            ? configuredModeFor(bundle, controlSettings)
            : inferredMode,
      conclusion: record.conclusion || metadata.conclusion,
      repository: record.repository || metadata.repository || "",
      runtimeRepository: record.runtimeRepository || metadata.runtimeRepository || "",
      workflowPath: record.workflowPath || metadata.workflowPath || inventoryWorkflow?.sourcePath || "",
      workflowId,
      workflow: metadata.workflowName || inventoryWorkflow?.name || record.workflow,
    };
  }))).sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  const scopedRecords = allowedRepositories.size === 0
    ? records
    : records.filter((record) => allowedRepositories.has(record.repository.toLowerCase()));
  return {
    generatedAt,
    repository,
    inventory,
    records: scopedRecords,
    remoteWorkflows,
    workflowDiscovery,
    containsPrivateData: hasPrivateData,
  };
}

export async function collectDashboardRecords(options) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  try {
    return await collectDashboardRecordsImpl({ ...options, generatedAt });
  } catch (error) {
    if (!(error instanceof GitHubRateLimitError)) throw error;
    log.warning`${error.message}`;
    const canRetain = options.previousSnapshot?.containsPrivateData === false;
    const retained = canRetain ? options.previousSnapshot.records : null;
    const retainedRemoteWorkflows = canRetain && Array.isArray(options.previousSnapshot?.remoteWorkflows)
      ? options.previousSnapshot.remoteWorkflows : [];
    const snapshotGeneratedAt = options.previousSnapshot?.generatedAt || "";
    const snapshotAge = snapshotGeneratedAt
      ? Math.floor((Date.parse(generatedAt) - Date.parse(snapshotGeneratedAt)) / 1000)
      : null;
    const snapshotAgeSeconds = Number.isFinite(snapshotAge) ? Math.max(0, snapshotAge) : null;
    const retainedWorkflowDiscovery = canRetain && options.previousSnapshot?.workflowDiscovery
      ? {
        ...options.previousSnapshot.workflowDiscovery,
        complete: false,
        failures: [
          ...(options.previousSnapshot.workflowDiscovery.failures || []),
          { repository: "", reason: error.message },
        ],
      }
      : {
        complete: false,
        repositoriesExpected: 0,
        repositoriesObserved: 0,
        workflowsObserved: 0,
        failures: [{ repository: "", reason: error.message }],
      };
    return {
      generatedAt,
      repository: options.repository,
      inventory: options.inventory,
      records: Array.isArray(retained) ? retained : [],
      remoteWorkflows: retainedRemoteWorkflows,
      workflowDiscovery: retainedWorkflowDiscovery,
      error: error.message,
      errorStatus: error.status,
      errorEndpoint: error.pathname,
      rateLimitResetAt: error.resetAt,
      snapshotGeneratedAt,
      snapshotAgeSeconds,
      stale: (Array.isArray(retained) && retained.length > 0) || retainedRemoteWorkflows.length > 0,
      partial: true,
      containsPrivateData: false,
    };
  }
}

export async function writeDashboardRecords() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const controlSettingsPath = process.env.REPORT_CONTROL_SETTINGS;
  const inventoryPath = process.env.REPORT_INVENTORY;
  const deployedWorkflowsPath = process.env.REPORT_DEPLOYED_WORKFLOWS || "_inventory/deployed-workflows.json";
  const outputPath = process.env.REPORT_RECORDS;
  if (!repository || !token || !controlSettingsPath || !inventoryPath || !outputPath) {
    throw new Error("GITHUB_REPOSITORY, GITHUB_TOKEN, REPORT_CONTROL_SETTINGS, REPORT_INVENTORY, and REPORT_RECORDS are required");
  }
  const inventory = readJson(inventoryPath);
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.workflows) || !Array.isArray(inventory.bundles)) {
    throw new Error(`Unsupported or invalid control-plane inventory: ${inventoryPath}`);
  }
  const deployedInventory = existsSync(deployedWorkflowsPath)
    ? readJson(deployedWorkflowsPath)
    : { schemaVersion: 1, organization: repository.split("/")[0], repositoryCount: 0, bundles: [], workflows: [] };
  log.group`Collect dashboard records`;
  try {
    let previousSnapshot = null;
    if (existsSync(outputPath)) {
      try {
        previousSnapshot = readJson(outputPath);
      } catch (error) {
        log.warning`Unable to read prior dashboard record snapshot: ${error.message}`;
      }
    }
    const records = await collectDashboardRecords({
      repository,
      token,
      pagesToken: process.env.REPORT_PAGES_TOKEN || token,
      controlSettings: readJson(controlSettingsPath),
      inventory,
      deployedInventory,
      requestedRepositories: (process.env.REPORT_ALLOWED_REPOS || "").split(","),
      previousSnapshot,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(records, null, 2)}\n`);
    log.info`Wrote ${records.records.length} dashboard records to ${outputPath}${records.error ? " with incomplete coverage" : ""}`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeDashboardRecords().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
