import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLifecycleObservation,
  hasLifecycleClaim,
} from "../../activity/token-intervention-lifecycle.mjs";

const opportunityId =
  "token-opportunity:octo%2Fexample:.github%2Fworkflows%2Freview.md:2026-09-01T00:00:00Z:2026-09-08T00:00:00Z:1185999:review-context-v1";
const interventionId = `token-intervention:${opportunityId}:review-context-v1`;
const safeOutputUrl = "https://github.com/githubnext/gh-aw-cao/issues/11861";
const implementationUrl = "https://github.com/octo/example/pull/42";

function claim(overrides = {}) {
  return {
    schemaVersion: 1,
    claimedAt: "2026-09-16T00:00:00Z",
    controlRepository: "githubnext/gh-aw-cao",
    claimRunId: "1189001",
    claimRunAttempt: 1,
    actor: "maintainer",
    optimizerRunId: "1186001",
    optimizerRunAttempt: 1,
    opportunityId,
    interventionId,
    safeOutputUrl,
    decision: "accepted",
    ...overrides,
  };
}

function envelopes(extra = []) {
  return [
    {
      schema_version: 2,
      kind: "run",
      run: {
        run_id: 1186001,
        run_attempt: 1,
        organization: "githubnext",
        repository: "githubnext/gh-aw-cao",
        workflow_name: "Optimization / Token Optimizer",
        workflow_path: ".github/workflows/optimization-token-optimizer.md",
        created_at: "2026-09-15T03:00:00Z",
        updated_at: "2026-09-15T04:00:00Z",
      },
    },
    {
      schema_version: 2,
      kind: "token_efficiency_observation",
      observation: {
        schemaVersion: 1,
        optimizerRunId: "1186001",
        runAttempt: 1,
        controlRepository: "githubnext/gh-aw-cao",
        targetRepo: "octo/example",
        workflowPath: ".github/workflows/review.md",
        opportunityId,
        interventionId,
      },
    },
    {
      schema_version: 2,
      kind: "safe_output_item",
      safe_output: {
        run_id: 1186001,
        type: "create_issue",
        url: safeOutputUrl,
        timestamp: "2026-09-15T03:30:00Z",
      },
    },
    ...extra,
  ];
}

function githubFixture({ pullRequest, files, runs = {} } = {}) {
  return (endpoint) => {
    if (endpoint === "repos/githubnext/gh-aw-cao/issues/11861") {
      return { number: 11861, html_url: safeOutputUrl };
    }
    if (endpoint === "repos/octo/example/pulls/42") {
      if (pullRequest instanceof Error) throw pullRequest;
      return pullRequest;
    }
    if (endpoint === "repos/octo/example/pulls/42/files?per_page=100") return files;
    const runMatch = endpoint.match(/^repos\/octo\/example\/actions\/runs\/([0-9]+)$/u);
    if (runMatch && Object.hasOwn(runs, runMatch[1])) return runs[runMatch[1]];
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}

test("an explicit claim records acceptance without treating issue state as implementation", async () => {
  const observation = await buildLifecycleObservation({
    claim: claim(),
    envelopes: envelopes(),
    fetchGitHub: githubFixture(),
  });

  assert.equal(observation.previousInterventionState, "proposed");
  assert.equal(observation.interventionState, "accepted");
  assert.equal(observation.recommendationDisposition, "unapplied");
  assert.equal(observation.safeOutputId, "github:issue:githubnext/gh-aw-cao:11861");
  assert.equal(observation.acceptedAt, "2026-09-16T00:00:00Z");
  assert.equal(observation.implementationChangeId, undefined);
});

test("an authoritative target pull request advances running and applied states", async () => {
  const open = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });
  assert.equal(open.interventionState, "running");
  assert.equal(open.recommendationDisposition, "unapplied");
  assert.equal(open.implementationStartedAt, "2026-09-16T01:00:00Z");

  const merged = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "closed",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: "2026-09-16T02:00:00Z",
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });
  assert.equal(merged.interventionState, "running");
  assert.equal(merged.recommendationDisposition, "applied");
  assert.equal(merged.implementationCompletedAt, "2026-09-16T02:00:00Z");
});

test("implementation evidence advances an accepted observation without rewriting it", async () => {
  const accepted = await buildLifecycleObservation({
    claim: claim(),
    envelopes: envelopes(),
    fetchGitHub: githubFixture(),
  });
  const merged = await buildLifecycleObservation({
    claim: claim({
      claimRunId: "1189002",
      claimedAt: "2026-09-17T00:00:00Z",
      implementationPullRequestUrl: implementationUrl,
    }),
    envelopes: envelopes([{
      schema_version: 2,
      kind: "token_efficiency_lifecycle_observation",
      observation: accepted,
    }]),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "closed",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: "2026-09-16T02:00:00Z",
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });

  assert.equal(merged.previousInterventionState, "accepted");
  assert.equal(merged.acceptedAt, accepted.acceptedAt);
  assert.notEqual(merged.lifecycleObservationId, accepted.lifecycleObservationId);
});

test("retained lifecycle evidence keeps older interventions correlatable", async () => {
  const accepted = await buildLifecycleObservation({
    claim: claim(),
    envelopes: envelopes(),
    fetchGitHub: githubFixture(),
  });
  const advanced = await buildLifecycleObservation({
    claim: claim({
      claimRunId: "1189002",
      claimedAt: "2026-10-17T00:00:00Z",
      implementationPullRequestUrl: implementationUrl,
    }),
    envelopes: [{
      schema_version: 2,
      kind: "token_efficiency_lifecycle_observation",
      observation: accepted,
    }],
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-10-17T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });

  assert.equal(advanced.previousInterventionState, "accepted");
  assert.equal(advanced.interventionState, "running");
  assert.equal(advanced.safeOutputUrl, safeOutputUrl);
});

test("implementation run identities must match the target pull request head", async () => {
  const observation = await buildLifecycleObservation({
    claim: claim({
      implementationPullRequestUrl: implementationUrl,
      implementationRunIds: [7001],
    }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
        head: { sha: "abc123" },
      },
      files: [{ filename: ".github/workflows/review.md" }],
      runs: {
        7001: {
          id: 7001,
          head_sha: "abc123",
          repository: { full_name: "octo/example" },
        },
      },
    }),
  });

  assert.deepEqual(observation.implementationRunIds, ["7001"]);
  assert.equal(observation.evidenceState, "complete");

  const mismatch = await buildLifecycleObservation({
    claim: claim({
      implementationPullRequestUrl: implementationUrl,
      implementationRunIds: [7002],
    }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "closed",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: "2026-09-16T02:00:00Z",
        head: { sha: "abc123" },
      },
      files: [{ filename: ".github/workflows/review.md" }],
      runs: {
        7002: {
          id: 7002,
          head_sha: "different",
          repository: { full_name: "octo/example" },
        },
      },
    }),
  });
  assert.equal(mismatch.interventionState, "accepted");
  assert.equal(mismatch.recommendationDisposition, "unapplied");
  assert.equal(mismatch.evidenceState, "incomplete");
  assert.equal(mismatch.missingReason, "implementation-run-does-not-match-pull-request");
});

test("implementation evidence must target and change the assigned workflow", async () => {
  await assert.rejects(
    buildLifecycleObservation({
      claim: claim({
        implementationPullRequestUrl: "https://github.com/octo/other/pull/42",
      }),
      envelopes: envelopes(),
      fetchGitHub: githubFixture(),
    }),
    /target repository/,
  );
  const wrongFile = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: "README.md" }],
    }),
  });
  assert.equal(wrongFile.interventionState, "accepted");
  assert.equal(wrongFile.evidenceState, "incomplete");
  assert.equal(
    wrongFile.missingReason,
    "implementation-pull-request-does-not-change-target-workflow",
  );
});

test("explicit rejection and supersession remain within one opportunity lineage", async () => {
  const replacement = `token-intervention:${opportunityId}:review-context-v2`;
  const observation = await buildLifecycleObservation({
    claim: claim({
      decision: "rejected",
      rejectionDisposition: "superseded",
      supersededByInterventionId: replacement,
    }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture(),
  });

  assert.equal(observation.interventionState, "rejected");
  assert.equal(observation.recommendationDisposition, "superseded");
  assert.equal(observation.supersededByInterventionId, replacement);
  assert.equal(observation.supersededAt, "2026-09-16T00:00:00Z");

  await assert.rejects(
    buildLifecycleObservation({
      claim: claim({
        decision: "rejected",
        rejectionDisposition: "superseded",
        supersededByInterventionId: "token-intervention:different-opportunity:replacement",
      }),
      envelopes: envelopes(),
      fetchGitHub: githubFixture(),
    }),
    /same opportunity/,
  );
});

test("unavailable implementation evidence is explicit and does not count as applied", async () => {
  const observation = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: new Error("API unavailable"),
      files: [],
    }),
  });

  assert.equal(observation.interventionState, "accepted");
  assert.equal(observation.recommendationDisposition, "unapplied");
  assert.equal(observation.evidenceState, "unavailable");
  assert.equal(observation.missingReason, "implementation-pull-request-unavailable");
});

test("a failed implementation can retain an authoritative closed pull request", async () => {
  const observation = await buildLifecycleObservation({
    claim: claim({
      decision: "rejected",
      rejectionDisposition: "failed-start",
      implementationPullRequestUrl: implementationUrl,
    }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "closed",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });

  assert.equal(observation.interventionState, "rejected");
  assert.equal(observation.recommendationDisposition, "failed-start");
  assert.equal(observation.implementationPullRequestUrl, implementationUrl);
  assert.equal(observation.evidenceState, "complete");
});

test("contradictory implementation evidence cannot make rejection terminal", async () => {
  const running = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });
  const observation = await buildLifecycleObservation({
    claim: claim({
      claimRunId: "1189002",
      claimedAt: "2026-09-17T00:00:00Z",
      decision: "rejected",
      rejectionDisposition: "failed-start",
    }),
    envelopes: envelopes([{
      schema_version: 2,
      kind: "token_efficiency_lifecycle_observation",
      observation: running,
    }]),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "open",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: null,
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });

  assert.equal(observation.interventionState, "running");
  assert.equal(observation.recommendationDisposition, "unapplied");
  assert.equal(observation.evidenceState, "incomplete");
  assert.equal(observation.rejectedAt, undefined);
});

test("an applied implementation cannot be downgraded or replaced", async () => {
  const applied = await buildLifecycleObservation({
    claim: claim({ implementationPullRequestUrl: implementationUrl }),
    envelopes: envelopes(),
    fetchGitHub: githubFixture({
      pullRequest: {
        number: 42,
        html_url: implementationUrl,
        state: "closed",
        created_at: "2026-09-16T01:00:00Z",
        merged_at: "2026-09-16T02:00:00Z",
      },
      files: [{ filename: ".github/workflows/review.md" }],
    }),
  });
  await assert.rejects(
    buildLifecycleObservation({
      claim: claim({
        claimRunId: "1189002",
        claimedAt: "2026-09-17T00:00:00Z",
        decision: "rejected",
        rejectionDisposition: "outdated",
      }),
      envelopes: envelopes([{
        schema_version: 2,
        kind: "token_efficiency_lifecycle_observation",
        observation: applied,
      }]),
      fetchGitHub: githubFixture(),
    }),
    /applied intervention cannot be downgraded/,
  );
});

test("claims fail closed without exact structured proposal and safe-output correlation", async () => {
  await assert.rejects(
    buildLifecycleObservation({
      claim: claim(),
      envelopes: envelopes().filter((envelope) => envelope.kind !== "safe_output_item"),
      fetchGitHub: githubFixture(),
    }),
    /exactly one optimizer safe output/,
  );
  const duplicate = await buildLifecycleObservation({
    claim: claim(),
    envelopes: [
      ...envelopes(),
      envelopes().find((envelope) => envelope.kind === "safe_output_item"),
    ],
    fetchGitHub: githubFixture(),
  });
  assert.equal(duplicate.lifecycleObservationId, (
    await buildLifecycleObservation({
      claim: claim(),
      envelopes: envelopes(),
      fetchGitHub: githubFixture(),
    })
  ).lifecycleObservationId);
});

test("safe-output correlation cannot cross optimizer run attempts", async () => {
  const rerunEnvelopes = structuredClone(envelopes());
  const run = rerunEnvelopes.find((envelope) => envelope.kind === "run").run;
  run.run_attempt = 2;
  run.created_at = "2026-09-15T05:00:00Z";
  run.updated_at = "2026-09-15T06:00:00Z";
  rerunEnvelopes.find(
    (envelope) => envelope.kind === "token_efficiency_observation",
  ).observation.runAttempt = 2;

  await assert.rejects(
    buildLifecycleObservation({
      claim: claim({ optimizerRunAttempt: 2 }),
      envelopes: rerunEnvelopes,
      fetchGitHub: githubFixture(),
    }),
    /exactly one optimizer safe output/,
  );
});

test("a collected claim is detected by immutable run identity", async () => {
  const lifecycleClaim = claim();
  const observation = await buildLifecycleObservation({
    claim: lifecycleClaim,
    envelopes: envelopes(),
    fetchGitHub: githubFixture(),
  });
  assert.equal(hasLifecycleClaim(envelopes([{
    schema_version: 2,
    kind: "token_efficiency_lifecycle_observation",
    observation,
  }]), lifecycleClaim), true);
});
