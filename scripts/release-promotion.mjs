import { digest, promotionEnvironment, readCodeqlEvidence, readPromotionEnvironment, repositoryApi, requireCondition } from "./release-promotion-evidence.mjs";

const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;

function newerVersion(candidate, latest) {
  requireCondition(versionPattern.test(latest), "Current latest release must have a stable semantic version");
  const left = candidate.slice(1).split(".").map(BigInt);
  const right = latest.slice(1).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

export async function collectPromotionEvidence(request, context, tag) {
  requireCondition(context.eventName === "workflow_dispatch" && String(context.runAttempt) === "1",
    "Promotion requires a new manual dispatch; reruns must use a new approval");
  requireCondition(versionPattern.test(tag) && shaPattern.test(context.sha), "Invalid release tag or workflow SHA");
  const get = repositoryApi(request, context.repository);
  const repository = await get("");
  requireCondition(repository.fork === false && context.ref === `refs/heads/${repository.default_branch}`,
    "Promotion must run from this repository's default branch, never a fork or tag");
  const branch = await get(`branches/${encodeURIComponent(repository.default_branch)}`);
  requireCondition(branch.commit.sha === context.sha, "Promotion workflow is no longer the current default-branch revision");
  for (const actor of new Set([context.actor, context.triggeringActor])) {
    requireCondition(typeof actor === "string" && actor.length > 0, "Promotion actor is missing");
    const access = await get(`collaborators/${encodeURIComponent(actor)}/permission`);
    requireCondition(["maintain", "admin"].includes(access.role_name), "Promotion requires maintain or admin access");
  }
  const environment = await readPromotionEnvironment(get, repository.default_branch);
  const release = await get(`releases/tags/${tag}`);
  requireCondition(release.tag_name === tag && release.name === tag && release.draft === false
    && release.prerelease === true && release.immutable === true && !!release.published_at
    && Number.isSafeInteger(release.id) && release.id > 0 && shaPattern.test(release.target_commitish),
  "Promotion requires an existing immutable published prerelease bound to an exact SHA");
  const revision = release.target_commitish;
  const ref = await get(`git/ref/tags/${tag}`);
  requireCondition(ref.object?.type === "commit" && ref.object.sha === revision, "Release tag and source SHA disagree");
  const ancestry = await get(`compare/${revision}...${context.sha}`);
  requireCondition(["ahead", "identical"].includes(ancestry.status), "Release source is not reachable from the default branch");
  const latest = await get("releases/latest");
  requireCondition(latest.draft === false && latest.prerelease === false && newerVersion(tag, latest.tag_name),
    "Promotion must advance latest, not republish or downgrade it");
  const assets = await get(`releases/${release.id}/assets`, { per_page: 100 });
  const archive = `cao-runtime-${revision}.tgz`;
  const expected = [archive, `${archive}.sha256`, "darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64",
    "windows-amd64.exe", "windows-arm64.exe", "checksums.txt"].sort();
  requireCondition(Array.isArray(assets) && assets.length === expected.length
    && assets.every((asset) => asset.state === "uploaded" && asset.size > 0
      && /^sha256:[0-9a-f]{64}$/.test(asset.digest))
    && JSON.stringify(assets.map((asset) => asset.name).sort()) === JSON.stringify(expected),
  "Prerelease assets are missing, incomplete, or lack immutable digests");
  const builds = await get("actions/workflows/release.lock.yml/runs", {
    head_sha: revision, event: "workflow_dispatch", per_page: 100,
  });
  const build = builds.workflow_runs?.find((run) => run.head_sha === revision
    && run.path === ".github/workflows/release.lock.yml" && run.event === "workflow_dispatch"
    && run.head_branch === repository.default_branch);
  requireCondition(build?.status === "completed" && build.conclusion === "success",
    "The exact-SHA prerelease preparation and highlights workflow has not succeeded");
  const codeql = await readCodeqlEvidence(get, revision, repository.default_branch);
  return {
    repository: context.repository, workflowSha: context.sha, runId: context.runId,
    environment, releaseId: release.id, tag, revision, notesDigest: digest(release.body),
    assets: assets.map(({ id, name, size, digest: assetDigest }) => ({ id, name, size, digest: assetDigest }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    previousLatest: { id: latest.id, tag: latest.tag_name },
    build: { id: build.id, attempt: build.run_attempt }, codeql,
  };
}

export async function promoteRelease(request, context, approved, needs) {
  for (const job of ["preflight", "contracts", "dashboard", "server", "evidence"]) {
    requireCondition(needs[job]?.result === "success", `Promotion requires successful ${job} evidence`);
  }
  requireCondition(String(context.runAttempt) === "1", "Promotion reruns require a new dispatch and approval");
  const get = repositoryApi(request, context.repository);
  const reviews = await get(`actions/runs/${context.runId}/approvals`);
  const review = reviews.find((entry) => entry.state === "approved"
    && entry.environments?.some((environment) => environment.id === approved.environment.id
      && environment.name === promotionEnvironment)
    && entry.user?.type === "User" && typeof entry.user.login === "string" && entry.user.login.length > 0
    && ![context.actor.toLowerCase(), context.triggeringActor.toLowerCase()].includes(entry.user.login?.toLowerCase()));
  requireCondition(review, "Promotion requires an independent human environment approval for this run");
  const current = await collectPromotionEvidence(request, context, approved.tag);
  requireCondition(digest(current) === digest(approved), "Release candidate, policy, latest, or scanner evidence changed after preparation; start a new dispatch");
  await request(`PATCH /repos/${context.repository}/releases/${approved.releaseId}`, {
    draft: false, prerelease: false, make_latest: "true",
  });
  const promoted = await get(`releases/${approved.releaseId}`);
  const latest = await get("releases/latest");
  requireCondition(promoted.prerelease === false && promoted.draft === false && promoted.immutable === true
    && promoted.tag_name === approved.tag && promoted.target_commitish === approved.revision
    && latest.id === approved.releaseId, "Release promotion did not produce the expected latest release");
  return { ...approved, approvedBy: review.user.login, promoted: true };
}
