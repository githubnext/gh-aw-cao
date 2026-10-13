// Bug Bash investigation contract.
//
// Deterministic, dependency-free definitions shared by the Bug Bash campaign
// documentation, its workflows, and its contract tests. The agent reasons in
// natural language; this module fixes the parts that must not drift between a
// prompt, a review bundle, and a maintainer's expectations:
//
//   * the closed set of investigation outcomes;
//   * the gates that separate "a test fails" from "a bug is reproduced", and
//     "tests pass" from "the repair is correct";
//   * stable work identity and stable finding identity;
//   * bounded concurrency, duplicate suppression, retry/backoff, incremental
//     skip behavior, and a resource envelope that reserves verification budget;
//   * the required review-bundle contents and their digests.
//
// Nothing here contacts the network, reads policy, or grants authority. CAO
// policy decides whether and where a run happens; this module only describes
// what a single admitted investigation may conclude.

import { createHash } from "node:crypto";

/** Version of the investigation harness. Part of stable work identity. */
export const HARNESS_VERSION = "1.1.0";

/** Stable identity of the hypothesis the worker applies. */
export const HYPOTHESIS_ID = "explicit-zero-default";

/** Version of the hypothesis the worker applies. Part of stable work identity. */
export const HYPOTHESIS_VERSION = "1.0.0";

export const DEFAULT_HYPOTHESIS = Object.freeze({
  id: HYPOTHESIS_ID,
  version: HYPOTHESIS_VERSION,
  statement: "An explicit numeric zero accepted by a public contract is replaced by a nonzero default.",
  screeningSignals: Object.freeze([
    "numeric configuration or option fields with documented zero semantics",
    "truthiness-based fallback or normalization near those fields",
    "existing tests that cover omission and positive values but not explicit zero",
  ]),
});

/**
 * Closed set of investigation outcomes.
 *
 * `reproduced-candidate` is deliberately distinct from `review-ready`: a
 * reproduction is evidence of a defect, not evidence of a correct repair.
 */
export const INVESTIGATION_OUTCOMES = Object.freeze([
  "no-finding",
  "blocked",
  "inconclusive",
  "reproduced-candidate",
  "review-ready",
]);

/**
 * Starter target for the recommended getting-started run.
 *
 * The revision is an immutable commit SHA, not a branch. Replays compare
 * against this exact revision so that a later push cannot silently change what
 * "reproduced" means. The focus paths bound the first investigation to a small,
 * self-contained, standard-library-only surface with an existing test file.
 */
export const STARTER_TARGET = Object.freeze({
  repository: "githubnext/gh-aw-cao-bug-bash",
  revision: "49cfd2afb66bd6a07b8e6d18a21ccacc4871a4e9",
  focusPaths: Object.freeze([
    "docs/policy-contract.md",
    "examples/paused-rollout.json",
    "config/production-fleet.json",
    "src/demo.mjs",
    "src/policy.mjs",
    "src/rollout.mjs",
    "src/notifications.mjs",
    "legacy/batch-options.cjs",
    "test",
  ]),
  hypothesis: DEFAULT_HYPOTHESIS,
});

/**
 * Resource envelope for one investigation.
 *
 * `verificationReserve*` are held back from the investigation phase so that a
 * long search can never consume the budget the verification phase needs. A
 * worker that would cross `investigationCredits` must stop searching and verify
 * what it already has.
 */
export const RESOURCE_ENVELOPE = Object.freeze({
  maxConcurrentInvestigations: 1,
  maxInvestigationsPerRun: 1,
  maxSurfacedFindings: 1,
  workerCredits: 500,
  verificationReserveCredits: 200,
  timeoutMinutes: 45,
  verificationReserveMinutes: 15,
  maxAttempts: 3,
});

/** Required review-bundle files, in reading order. */
export const REVIEW_BUNDLE_FILES = Object.freeze([
  "summary.md",
  "contract.md",
  "reproduction.md",
  "tests.patch",
  "production.patch",
  "validation.txt",
  "verification.json",
]);

/** Gates the verification phase must clear before an outcome may be `review-ready`. */
export const VERIFICATION_GATES = Object.freeze([
  "contractSupportsDefect",
  "replayedInFreshEnvironment",
  "reproducedOnSourceRevision",
  "behaviorClassifiedFailure",
  "testPatch",
  "productionPatch",
  "patchResolvesReproduction",
  "applicableTestsPass",
  "boundaryChallenged",
  "noWeakenedTests",
]);

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Stable work identity: repository, revision, hypothesis identity and version, harness version.
 *
 * Two runs with the same work identity investigate the same question against
 * the same code with the same method, so the second may be skipped. Changing
 * the hypothesis or the harness produces new work even on an unchanged revision.
 *
 * @param {{repository: string, revision: string, hypothesisId?: string, hypothesisVersion?: string, harnessVersion?: string}} work
 * @returns {{id: string, label: string, repository: string, revision: string, hypothesisId: string, hypothesisVersion: string, harnessVersion: string}}
 */
export function workIdentity(work) {
  const repository = requireString(work?.repository, "repository");
  const revision = requireString(work?.revision, "revision");
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new TypeError("revision must be a 40-character commit SHA, not a branch or tag");
  }
  const hypothesisId = requireString(work?.hypothesisId ?? HYPOTHESIS_ID, "hypothesisId");
  const hypothesisVersion = requireString(work?.hypothesisVersion ?? HYPOTHESIS_VERSION, "hypothesisVersion");
  const harnessVersion = requireString(work?.harnessVersion ?? HARNESS_VERSION, "harnessVersion");
  const label = [repository, revision, hypothesisId, hypothesisVersion, harnessVersion].join("@");
  return Object.freeze({
    id: `work:${digest(label).slice(0, 32)}`,
    label,
    repository,
    revision,
    hypothesisId,
    hypothesisVersion,
    harnessVersion,
  });
}

/**
 * Stable finding identity: repository, violated contract, symptom signature, entry point.
 *
 * Deliberately independent of revision, run, harness, and hypothesis version so
 * that repeating the investigation on a later commit recognizes the same defect
 * instead of surfacing a near-duplicate.
 *
 * @param {{repository: string, contract: string, symptom: string, entryPoint: string}} finding
 * @returns {{id: string, label: string}}
 */
export function findingIdentity(finding) {
  const label = [
    requireString(finding?.repository, "repository"),
    requireString(finding?.contract, "contract"),
    requireString(finding?.symptom, "symptom"),
    requireString(finding?.entryPoint, "entryPoint"),
  ].join("|");
  return Object.freeze({ id: `finding:${digest(label).slice(0, 32)}`, label });
}

/**
 * Bounded retry plan with explicit backoff.
 *
 * Only transient infrastructure faults are retried, and never more than
 * `RESOURCE_ENVELOPE.maxAttempts` times in one run. Exhausted AI credits, rate
 * limits, and denied admission are terminal: the run stops and reports instead
 * of waiting for replenishment or redispatching itself.
 *
 * @param {number} attempt 1-based attempt number.
 * @param {{retryable?: boolean, reason?: string}} [context]
 * @returns {{retry: boolean, attempt: number, delaySeconds: number, reason: string}}
 */
export function retryPlan(attempt, context = {}) {
  const terminalReasons = new Set(["credits-exhausted", "rate-limited", "admission-denied", "model-access-unavailable"]);
  const delays = [15, 60, 0];
  const reason = context.reason ?? "transient-fault";
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError("attempt must be a positive integer");
  if (context.retryable === false || terminalReasons.has(reason)) {
    return Object.freeze({ retry: false, attempt, delaySeconds: 0, reason: `terminal:${reason}` });
  }
  if (attempt >= RESOURCE_ENVELOPE.maxAttempts) {
    return Object.freeze({ retry: false, attempt, delaySeconds: 0, reason: "attempts-exhausted" });
  }
  return Object.freeze({ retry: true, attempt, delaySeconds: delays[attempt - 1], reason });
}

/**
 * Incremental skip and duplicate suppression.
 *
 * @param {{workId: string, findingId?: string, completedWorkIds?: string[], openFindingIds?: string[], runningWorkIds?: string[]}} state
 * @returns {{skip: boolean, reason: string}}
 */
export function skipDecision(state) {
  const workId = requireString(state?.workId, "workId");
  const running = state?.runningWorkIds ?? [];
  const completed = state?.completedWorkIds ?? [];
  const open = state?.openFindingIds ?? [];
  if (running.length >= RESOURCE_ENVELOPE.maxConcurrentInvestigations && !running.includes(workId)) {
    return Object.freeze({ skip: true, reason: "concurrency-limit" });
  }
  if (running.includes(workId)) return Object.freeze({ skip: true, reason: "already-running" });
  if (completed.includes(workId)) return Object.freeze({ skip: true, reason: "already-investigated" });
  if (state?.findingId && open.includes(state.findingId)) {
    return Object.freeze({ skip: true, reason: "duplicate-finding" });
  }
  return Object.freeze({ skip: false, reason: "eligible" });
}

/**
 * Credit split that reserves verification budget.
 *
 * @param {{workerCredits?: number, verificationReserveCredits?: number, timeoutMinutes?: number, verificationReserveMinutes?: number}} [envelope]
 */
export function investigationBudget(envelope = RESOURCE_ENVELOPE) {
  const workerCredits = envelope.workerCredits ?? RESOURCE_ENVELOPE.workerCredits;
  const reserveCredits = envelope.verificationReserveCredits ?? RESOURCE_ENVELOPE.verificationReserveCredits;
  const timeoutMinutes = envelope.timeoutMinutes ?? RESOURCE_ENVELOPE.timeoutMinutes;
  const reserveMinutes = envelope.verificationReserveMinutes ?? RESOURCE_ENVELOPE.verificationReserveMinutes;
  if (reserveCredits <= 0 || reserveCredits >= workerCredits) {
    throw new RangeError("verification reserve must be a positive minority of the worker credit budget");
  }
  if (reserveMinutes <= 0 || reserveMinutes >= timeoutMinutes) {
    throw new RangeError("verification reserve must be a positive minority of the worker timeout");
  }
  return Object.freeze({
    investigationCredits: workerCredits - reserveCredits,
    verificationCredits: reserveCredits,
    investigationMinutes: timeoutMinutes - reserveMinutes,
    verificationMinutes: reserveMinutes,
  });
}

/**
 * Verification decision for one investigation.
 *
 * The ordering matters. Admission and environment problems are reported as
 * `blocked` rather than as an absence of bugs, so an operator can tell "nothing
 * was found" apart from "nothing was looked at". A failing generated test alone
 * never reaches `reproduced-candidate`: the failure must also contradict a
 * stated contract, replay on the original pinned revision in a fresh
 * environment, and be classified as product behavior rather than setup. Passing
 * tests alone never reach `review-ready`: the minimal reproduction must flip,
 * boundaries must have been challenged, and no test may have been weakened,
 * deleted, skipped, or suppressed.
 *
 * @param {object} signals
 * @returns {{outcome: string, reason: string, surfaced: boolean, publishReviewBundle: boolean, failedGate: string|null}}
 */
export function classifyOutcome(signals = {}) {
  const decide = (outcome, reason, failedGate = null) => Object.freeze({
    outcome,
    reason,
    failedGate,
    surfaced: outcome === "review-ready",
    publishReviewBundle: outcome === "review-ready",
  });

  if (signals.duplicate === true) return decide("no-finding", "duplicate-finding-suppressed");
  if (signals.modelAccess === false) return decide("blocked", "model-access-unavailable");
  if (signals.setupSucceeded === false) return decide("blocked", "environment-setup-failed");
  if (signals.contractSupportsDefect === false) {
    return decide("no-finding", "behavior-matches-stated-contract", "contractSupportsDefect");
  }
  if (signals.candidateFound === false) return decide("no-finding", "no-candidate-within-budget");
  if (signals.replayedInFreshEnvironment !== true) {
    return decide("inconclusive", "not-replayed-in-fresh-environment", "replayedInFreshEnvironment");
  }
  if (signals.reproducedOnSourceRevision !== true) {
    return decide("inconclusive", "not-reproduced-on-source-revision", "reproducedOnSourceRevision");
  }
  if (signals.failureClass !== "behavior") {
    return decide("inconclusive", `failure-classified-as-${signals.failureClass ?? "unknown"}`, "behaviorClassifiedFailure");
  }

  const repairGates = [
    ["testPatch", signals.testPatch === true, "missing-test-patch"],
    ["productionPatch", signals.productionPatch === true, "missing-production-patch"],
    ["patchResolvesReproduction", signals.patchResolvesReproduction === true, "patch-does-not-resolve-reproduction"],
    ["applicableTestsPass", signals.applicableTestsPass === true, "applicable-tests-failing"],
    ["boundaryChallenged", signals.boundaryChallenged === true, "boundary-conditions-not-challenged"],
    ["noWeakenedTests", signals.testsWeakened !== true, "weakened-or-suppressed-tests"],
  ];
  const failed = repairGates.find(([, passed]) => !passed);
  if (failed) return decide("reproduced-candidate", failed[2], failed[0]);
  return decide("review-ready", "verified-reproduction-and-repair");
}

/**
 * Deterministic review-bundle manifest with per-file digests.
 *
 * @param {Record<string, string>} files
 * @param {{workId: string, findingId: string, decision: {outcome: string, reason: string}, uncertainty: string}} record
 */
export function reviewBundleManifest(files, record) {
  const digests = Object.fromEntries(
    REVIEW_BUNDLE_FILES.filter((name) => typeof files?.[name] === "string")
      .map((name) => [name, digest(files[name])]),
  );
  return Object.freeze({
    contractVersion: 1,
    campaign: "bug-bash",
    worker: "investigation",
    harnessVersion: HARNESS_VERSION,
    hypothesisId: HYPOTHESIS_ID,
    hypothesisVersion: HYPOTHESIS_VERSION,
    workId: record?.workId ?? "",
    findingId: record?.findingId ?? "",
    outcome: record?.decision?.outcome ?? "",
    reason: record?.decision?.reason ?? "",
    uncertainty: record?.uncertainty ?? "",
    digests,
  });
}

/**
 * Validates that a review bundle is complete, self-describing, and intact.
 *
 * @param {Record<string, string>} files
 * @param {ReturnType<typeof reviewBundleManifest>} manifest
 * @returns {{valid: boolean, missing: string[], corrupted: string[], problems: string[]}}
 */
export function validateReviewBundle(files, manifest) {
  const missing = REVIEW_BUNDLE_FILES.filter((name) => typeof files?.[name] !== "string" || files[name] === "");
  const corrupted = REVIEW_BUNDLE_FILES
    .filter((name) => !missing.includes(name))
    .filter((name) => manifest?.digests?.[name] !== digest(files[name]));
  const problems = [];
  if (!INVESTIGATION_OUTCOMES.includes(manifest?.outcome)) problems.push("unknown-outcome");
  if (manifest?.outcome === "review-ready" && missing.length === 0) {
    if (files["tests.patch"] === files["production.patch"]) problems.push("test-and-production-patches-not-separated");
    if (!/\S/.test(manifest?.uncertainty ?? "")) problems.push("missing-uncertainty");
    if (!/\b[0-9a-f]{40}\b/.test(files["reproduction.md"] ?? "")) problems.push("missing-source-revision");
  }
  return Object.freeze({
    valid: missing.length === 0 && corrupted.length === 0 && problems.length === 0,
    missing,
    corrupted,
    problems,
  });
}

// ---------------------------------------------------------------------------
// Command line interface
//
// The worker calls these subcommands instead of restating the rules in prose,
// so identity, budget, classification, and bundle sealing are computed the same
// way in a workflow run and in the contract tests.
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    flags[key] = next === undefined || next.startsWith("--") ? "true" : next;
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

const USAGE = `Usage: node bug-bash/investigation-contract.mjs <command>

  starter                     Print the pinned starter target.
  hypothesis                  Print the fixed, versioned campaign hypothesis.
  budget                      Print the credit and time split that reserves verification.
  identity --repository R --revision SHA [--hypothesis-id ID] [--hypothesis-version V] [--harness-version V]
  finding --repository R --contract C --symptom S --entry-point E
  classify <signals.json>     Print the verification decision for recorded signals.
  seal <bundle-dir> <record.json>
                              Write <bundle-dir>/bundle-contract.json and validate the bundle.
`;

/**
 * Runs one CLI command.
 *
 * @param {string[]} argv
 * @param {{readFile: (path: string) => string, writeFile: (path: string, data: string) => void}} io
 * @returns {{status: number, stdout: string}}
 */
export function runCommand(argv, io) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const print = (value) => ({ status: 0, stdout: `${JSON.stringify(value, null, 2)}\n` });

  switch (command) {
    case "starter":
      return print(STARTER_TARGET);
    case "hypothesis":
      return print(DEFAULT_HYPOTHESIS);
    case "budget":
      return print(investigationBudget());
    case "identity":
      return print(workIdentity({
        repository: flags.repository,
        revision: flags.revision,
        hypothesisId: flags.hypothesisId,
        hypothesisVersion: flags.hypothesisVersion,
        harnessVersion: flags.harnessVersion,
      }));
    case "finding":
      return print(findingIdentity({
        repository: flags.repository,
        contract: flags.contract,
        symptom: flags.symptom,
        entryPoint: flags.entryPoint,
      }));
    case "classify": {
      const path = rest.find((token) => !token.startsWith("--"));
      if (!path) throw new TypeError("classify requires a signals JSON file");
      return print(classifyOutcome(JSON.parse(io.readFile(path))));
    }
    case "seal": {
      const positional = rest.filter((token) => !token.startsWith("--"));
      const [directory, recordPath] = positional;
      if (!directory || !recordPath) throw new TypeError("seal requires a bundle directory and a record JSON file");
      const record = JSON.parse(io.readFile(recordPath));
      const files = {};
      for (const name of REVIEW_BUNDLE_FILES) {
        const contents = io.readFile(`${directory}/${name}`, { optional: true });
        if (typeof contents === "string") files[name] = contents;
      }
      const manifest = reviewBundleManifest(files, record);
      const validation = validateReviewBundle(files, manifest);
      io.writeFile(`${directory}/bundle-contract.json`, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        status: validation.valid ? 0 : 1,
        stdout: `${JSON.stringify({ manifest, validation }, null, 2)}\n`,
      };
    }
    default:
      return { status: command === "help" || command === undefined ? 0 : 2, stdout: USAGE };
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const io = {
    readFile(path, options = {}) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (options.optional) return undefined;
        throw error;
      }
    },
    writeFile(path, data) {
      writeFileSync(path, data);
    },
  };
  try {
    const { status, stdout } = runCommand(process.argv.slice(2), io);
    process.stdout.write(stdout);
    process.exitCode = status;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
