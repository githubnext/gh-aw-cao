export class AuthorityError extends Error {}

export const ENVELOPE_VERSION = 1;
const MODES = ["review", "live"];
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const SHA = /^[a-f0-9]{40,64}$/i;
const REQUIRED_CONTROLS = ["policy-revision", "target-scope", "output-routing"];

function record(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorityError(`${name} must be a mapping`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new AuthorityError(`unknown key ${name}.${key}`);
  }
}

function mode(value, name) {
  if (!MODES.includes(value)) throw new AuthorityError(`${name} must be review or live`);
}

export function lesserMode(left, right) {
  mode(left, "mode");
  mode(right, "mode ceiling");
  return MODES.indexOf(left) <= MODES.indexOf(right) ? left : right;
}

export function narrowLimit(limit, requested, name, maximum = 1000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new AuthorityError(`${name} must be an integer in 1..${maximum}`);
  }
  if (requested === "" || requested === undefined || requested === null) return limit;
  const value = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AuthorityError(`${name} must be an integer in 1..${maximum}`);
  }
  if (value > limit) throw new AuthorityError(`${name} exceeds checked-in policy`);
  return value;
}

// Policy adapters supply validated declarations; the kernel has no workflow roles.
/** @param {{target?: string, mode?: string, maxTargets?: string | number | null}} request */
export function resolveAuthority(policy, request = {}) {
  let resolvedMode = policy.mode;
  mode(resolvedMode, "mode");
  let targets = Object.fromEntries(Object.entries(policy.targets ?? {})
    .map(([repository, target]) => [repository.toLowerCase(), { mode: target.mode }]));
  if (request.target && targets[request.target.toLowerCase()]) resolvedMode = targets[request.target.toLowerCase()].mode;
  if (policy.maxMode) {
    resolvedMode = lesserMode(resolvedMode, policy.maxMode);
    targets = Object.fromEntries(Object.entries(targets).map(([repository, target]) => [
      repository, { mode: lesserMode(target.mode, policy.maxMode) },
    ]));
  }
  if (request.mode) {
    mode(request.mode, "safe_output_mode");
    if (MODES.indexOf(request.mode) > MODES.indexOf(resolvedMode)) {
      throw new AuthorityError("safe_output_mode exceeds checked-in policy");
    }
    resolvedMode = request.mode;
    targets = Object.fromEntries(Object.entries(targets).map(([repository, target]) => [
      repository, { mode: lesserMode(target.mode, request.mode) },
    ]));
  }
  return {
    mode: resolvedMode,
    maxTargets: narrowLimit(policy.maxTargets, request.maxTargets, "max_repositories"),
    targets,
  };
}

export function validateTargetScope(repository, scope, denialReason = "target_repo is not allowed") {
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    throw new AuthorityError("target_repo must use owner/repository form");
  }
  const normalized = repository.toLowerCase();
  if (scope.owners.length && !scope.owners.some(owner => owner.trim().toLowerCase() === normalized.split("/")[0])) {
    throw new AuthorityError("target_repo owner is outside control-plane.scope.allowed-owners");
  }
  if (scope.repositories.length && !scope.repositories.some(candidate => candidate.toLowerCase() === normalized)) {
    throw new AuthorityError(denialReason);
  }
}

function validateBinding(binding) {
  record(binding, "binding", ["repository", "policySha", "workflowRef", "runId", "runAttempt"]);
  if (!REPOSITORY.test(binding.repository) || !SHA.test(binding.policySha)
    || typeof binding.workflowRef !== "string" || !binding.workflowRef.startsWith(`${binding.repository}/.github/workflows/`)
    || !/^[1-9][0-9]*$/.test(binding.runId) || !/^[1-9][0-9]*$/.test(binding.runAttempt)) {
    throw new AuthorityError("envelope requires verified execution identity and policy revision");
  }
}

export function validateEnvelope(envelope, expectedBinding, supportedControls = REQUIRED_CONTROLS) {
  record(envelope, "envelope", ["version", "operation", "binding", "maxTargets", "grants", "requirements", "delegation"]);
  if (envelope.version !== ENVELOPE_VERSION) throw new AuthorityError("unsupported authority envelope version");
  if (typeof envelope.operation !== "string" || !/^[a-z0-9][a-z0-9:/-]{0,255}$/.test(envelope.operation)) {
    throw new AuthorityError("invalid envelope operation identity");
  }
  validateBinding(envelope.binding);
  validateBinding(expectedBinding);
  for (const key of Object.keys(expectedBinding)) {
    if (envelope.binding[key] !== expectedBinding[key]) throw new AuthorityError(`envelope binding mismatch: ${key}`);
  }
  narrowLimit(envelope.maxTargets, "", "max_repositories");
  if (!Array.isArray(envelope.grants) || !envelope.grants.length || envelope.grants.length > envelope.maxTargets) {
    throw new AuthorityError("envelope grants exceed admitted target limit");
  }
  const names = new Set();
  for (const grant of envelope.grants) {
    record(grant, "grant", ["target", "mode", "destination"]);
    if (!REPOSITORY.test(grant.target) || !REPOSITORY.test(grant.destination)) throw new AuthorityError("invalid envelope repository");
    mode(grant.mode, "grant mode");
    if (names.has(grant.target.toLowerCase())) throw new AuthorityError("duplicate envelope target");
    names.add(grant.target.toLowerCase());
  }
  if (!Array.isArray(envelope.requirements) || new Set(envelope.requirements).size !== envelope.requirements.length
    || REQUIRED_CONTROLS.some(control => !envelope.requirements.includes(control))
    || envelope.requirements.some(control => !supportedControls.includes(control))) {
    throw new AuthorityError("unsupported or missing required enforcement control");
  }
  if (envelope.delegation !== false) throw new AuthorityError("direct operation delegation is not supported");
  return envelope;
}

export function resolveEnvelope(policy, request, verifiedContext, supportedControls) {
  record(request, "request", ["version", "operation", "targets", "mode", "destination", "maxTargets"]);
  if (request.version !== ENVELOPE_VERSION) throw new AuthorityError("unsupported operation request version");
  if (request.operation !== policy.operation) throw new AuthorityError("operation identity mismatch");
  if (policy.enabled !== true) return { decision: "deny", reason: "operation-disabled" };
  validateBinding(verifiedContext);
  if (!Array.isArray(request.targets) || !request.targets.length || request.targets.length > 1000) {
    throw new AuthorityError("operation requires 1 through 1000 explicit targets");
  }
  const authority = resolveAuthority(policy, { mode: request.mode || "review", maxTargets: request.maxTargets });
  if (request.targets.length > authority.maxTargets) throw new AuthorityError("operation targets exceed checked-in policy");
  const grants = request.targets.map(target => {
    validateTargetScope(target, policy.scope);
    const targetMode = lesserMode(authority.mode, authority.targets[target.toLowerCase()]?.mode ?? authority.mode);
    const destination = request.destination || (targetMode === "live" ? target : verifiedContext.repository);
    validateTargetScope(destination, { owners: policy.scope.owners, repositories: [] }, "output destination is not allowed");
    if (targetMode === "live" && destination.toLowerCase() !== target.toLowerCase()) {
      throw new AuthorityError("live operation destination must equal target");
    }
    return { target, mode: targetMode, destination };
  });
  const envelope = {
    version: ENVELOPE_VERSION,
    operation: policy.operation,
    binding: { ...verifiedContext },
    maxTargets: authority.maxTargets,
    grants,
    requirements: [...REQUIRED_CONTROLS],
    delegation: false,
  };
  validateEnvelope(envelope, verifiedContext, supportedControls);
  return { decision: "allow", reason: "authorized", envelope };
}

// Both values must already be verified by the receiving integration; this is not provenance verification.
export function validateNarrowing(parent, child) {
  validateEnvelope(parent, parent.binding);
  validateEnvelope(child, child.binding);
  if (parent.operation !== child.operation || parent.maxTargets < child.maxTargets
    || parent.binding.repository !== child.binding.repository || parent.binding.policySha !== child.binding.policySha) {
    throw new AuthorityError("handoff exceeds parent authority");
  }
  for (const grant of child.grants) {
    const ceiling = parent.grants.find(candidate => candidate.target.toLowerCase() === grant.target.toLowerCase());
    if (!ceiling || lesserMode(grant.mode, ceiling.mode) !== grant.mode
      || ceiling.destination.toLowerCase() !== grant.destination.toLowerCase()) {
      throw new AuthorityError("handoff widens a scoped grant");
    }
  }
  return child;
}
