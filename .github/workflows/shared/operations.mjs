import { AuthorityError, resolveEnvelope, validateEnvelope, validateNarrowing } from "./authority.mjs";

export function operationBinding(environment) {
  return {
    repository: environment.GITHUB_REPOSITORY ?? "",
    policySha: environment.GITHUB_WORKFLOW_SHA ?? "",
    workflowRef: environment.GITHUB_WORKFLOW_REF ?? "",
    runId: environment.GITHUB_RUN_ID ?? "",
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? "",
  };
}

export function operationRequest(environment) {
  const target = environment.CAO_TARGET_REPOSITORY || "";
  const targetsInput = environment.CAO_TARGET_REPOSITORIES || "";
  if (target && targetsInput) throw new AuthorityError("specify target_repo or target_repos, not both");
  if (targetsInput.length > 64 * 1024) throw new AuthorityError("target_repos exceeds 64 KiB");
  let targets = target ? [target] : [];
  if (targetsInput) {
    try {
      targets = JSON.parse(targetsInput);
    } catch {
      throw new AuthorityError("target_repos must be a JSON array of repository names");
    }
  }
  if (environment.CAO_CORRELATION_ID || environment.CAO_CENTRAL_REPOSITORY || environment.CAO_CONTROL_PLANE_RUN_URL) {
    throw new AuthorityError("direct operations must not carry a dispatcher envelope");
  }
  if (environment.CAO_REQUESTED_ROLLOUT_PERCENT) throw new AuthorityError("direct operations do not use rollout_percent");
  return {
    version: 1,
    operation: environment.CAO_WORKFLOW,
    targets,
    mode: environment.CAO_REQUESTED_MODE || "review",
    destination: environment.CAO_REQUESTED_SAFE_OUTPUT_REPOSITORY || "",
    maxTargets: environment.CAO_REQUESTED_MAX_REPOSITORIES || "",
  };
}

export function resolveOperation(document, request, binding) {
  const workflow = request.operation;
  if (typeof workflow !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workflow)) {
    throw new AuthorityError("operation requires an exact workflow identity");
  }
  const prefix = `${binding.repository}/.github/workflows/${workflow}.lock.yml@`;
  if (!binding.workflowRef.startsWith(prefix) || binding.workflowRef.length === prefix.length) {
    throw new AuthorityError("operation identity must match GITHUB_WORKFLOW_REF");
  }
  const control = document["control-plane"];
  const declaration = Object.hasOwn(control?.operations ?? {}, workflow) ? control.operations[workflow] : null;
  const deny = reason => ({ authorized: false, reason, control_role: "direct", campaign: "", workflow, worker: "", enabled: false });
  if (!control) return deny("control-plane-absent");
  if (!declaration) return deny("operation-undeclared");
  const decision = resolveEnvelope({
    operation: workflow,
    enabled: declaration.enabled ?? true,
    mode: declaration.mode ?? control.defaults?.mode ?? "review",
    maxMode: declaration["max-mode"],
    maxTargets: declaration["max-repositories"] ?? control.defaults?.["max-repositories"] ?? 1,
    targets: declaration.targets,
    scope: {
      owners: control.scope?.["allowed-owners"] ?? [binding.repository.split("/")[0]],
      repositories: control.scope?.["allowed-repositories"] ?? [],
    },
  }, request, binding);
  if (decision.decision !== "allow") return deny(decision.reason);
  const envelope = decision.envelope;
  if (!envelope) throw new AuthorityError("operation decision has no authority envelope");
  const first = envelope.grants[0];
  if (first.mode !== request.mode) throw new AuthorityError("requested mode is not permitted for every operation target");
  if (envelope.grants.some(grant => grant.mode !== first.mode || grant.destination.toLowerCase() !== first.destination.toLowerCase())) {
    throw new AuthorityError("gh-aw direct operations require a common mode and output destination");
  }
  if (first.mode === "live" && (envelope.grants.length !== 1 || request.targets.length !== 1)) {
    throw new AuthorityError("live direct operations require one target_repo");
  }
  return {
    authorized: true,
    reason: decision.reason,
    control_role: "direct",
    campaign: "",
    workflow,
    worker: "",
    enabled: true,
    safe_output_mode: first.mode,
    max_repositories: envelope.maxTargets,
    allowed_owners: control.scope?.["allowed-owners"] ?? [binding.repository.split("/")[0]],
    allowed_repositories: control.scope?.["allowed-repositories"] ?? [],
    authority_envelope: envelope,
  };
}

export function validateOperationHandoff(admitted, resolved, binding) {
  if (resolved.authorized !== true || admitted.authorized !== true) throw new AuthorityError("operation handoff is not authorized");
  validateEnvelope(admitted.authority_envelope, binding);
  validateNarrowing(resolved.authority_envelope, admitted.authority_envelope);
  if (JSON.stringify(admitted.authority_envelope) !== JSON.stringify(resolved.authority_envelope)) {
    throw new AuthorityError("operation handoff does not match current request and exact-revision policy");
  }
}

export async function prepareOperation(envelope, { loadRepository, validateDestination }) {
  validateEnvelope(envelope, envelope.binding);
  const candidates = [];
  const resolvedNames = new Set();
  for (const grant of envelope.grants) {
    const repository = await loadRepository(grant.target);
    if (typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== grant.target.toLowerCase()
      || !Number.isSafeInteger(repository.id) || repository.id < 1
      || repository.archived !== false || repository.disabled !== false) {
      throw new AuthorityError("operation target is redirected, archived, disabled or lacks required evidence");
    }
    if (resolvedNames.has(repository.id)) throw new AuthorityError("operation targets resolve to duplicate repositories");
    resolvedNames.add(repository.id);
    await validateDestination(grant);
    candidates.push({ ...repository, safe_output_mode: grant.mode, safe_output_repo: grant.destination });
  }
  return candidates;
}
