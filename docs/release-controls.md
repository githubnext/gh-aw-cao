---
title: Release promotion controls
description: Gate the immutable prerelease-to-latest transition with independent approval and exact-source evidence.
---

**The approval boundary is prerelease to latest, not PR merge or prerelease
creation.** The automated Release workflow still prepares assets, publishes an
immutable prerelease, and adds highlights without an environment approval.
Existing PR path filters and branch rulesets are unchanged.

These controls support release evidence and change authorization (SOC 2 CC7.1
and CC8.1). They are control design, not certification or proof of operation
over an audit period. They do not enable hosted CLI execution, widen CAO policy,
or change authority over enrolled targets.

## Promotion flow

After the complete Release workflow succeeds, dispatch **Promote prerelease to
latest** (`release-promote.yml`) from the current default branch with its
existing `vX.Y.Z` tag:

```sh
gh workflow run release-promote.yml --ref main -f tag=vX.Y.Z
```

The workflow does not create a release, rebuild its assets, or move its tag.
It requires an existing immutable, published prerelease whose tag and
`target_commitish` identify the same full commit SHA reachable from the default
branch. All nine runtime/binary assets must have immutable SHA-256 digests,
and the exact-SHA prerelease preparation/highlights workflow must have succeeded.
The candidate must advance the current stable semantic version; rollback,
repromotion, and first-stable bootstrapping are not supported by this workflow.

Before requesting approval, it verifies the live `release-latest` environment,
binds the candidate, notes digest, asset digests, previous latest release, and
exact-SHA CodeQL analysis identities, then runs fresh validation:

| Promotion job | Required evidence |
| --- | --- |
| `Validate release contracts` | `npm run check`: root lint, typechecks, unit/integration/load contracts, SVG checks, TypeSpec artifacts, seeded workflow compilation, and docs |
| `Validate release dashboard` | Dashboard typecheck, lint, unit tests, production build |
| `Validate release server` | Go formatting, lint, and server tests |

These are jobs in the promotion run, not required PR status checks. Every job
runs against the exact candidate SHA, without path filters or skip-as-success
fallbacks. Skipped, cancelled, failed, or missing validation prevents promotion.
Candidate validation has only read permissions; the privileged job checks out
the trusted workflow SHA, never the candidate source.

CodeQL evidence must cover Actions, Go, JavaScript/TypeScript, and Python on
the exact candidate SHA from default-branch analysis. The verifier searches
the most recent 1,000 default-branch analyses and retrieves each selected
analysis's SARIF, checking result completeness and linked alert identities.
High/critical security findings or error-level results block promotion even
if an alert was dismissed; no automatic waiver or scanner suppression is
provided. Missing, inaccessible, failed, or mismatched evidence blocks.
Low/medium non-error findings remain available for reviewer assessment.
An analysis on a PR head or another commit is not release evidence.

The workflow records candidate/evidence JSON in a 90-day Actions artifact and
the job summary before the protected job becomes eligible. An independent
human reviewer examines the release notes, SHA, validation jobs, and scanner
evidence, then approves the `release-latest` environment. GitHub approval
history must identify a human other than both the original and rerun actor.

After approval, the workflow rereads the environment, candidate, latest,
preparation result, and scanner evidence. Changed evidence or a newer default
branch head requires a new dispatch and approval. Reruns are rejected to avoid
reusing approval history from an earlier attempt. Promotion runs share one
non-cancelling concurrency group.

Only then does the privileged job update the existing release with
`prerelease: false` and `make_latest: true`, verifying the stable/latest result.
Failure before the update leaves the candidate a prerelease. A failed readback
after the update is reported as failure, not silently rolled back or declared
successful; an operator must inspect the actual release state.

## Administrator setup (not performed by this change)

1. Independently review and land the promotion workflow. Keep the existing
   prerelease automation, branch rulesets, deletion protections, and force-push
   prohibitions unchanged.
2. Create the GitHub environment **`release-latest`** in repository Settings >
   Environments. Configure at least one suitable required reviewer or reviewer
   team, enable **Prevent self-review**, and disable **Allow administrators to
   bypass configured protection rules**.
3. Select deployment branches/tags and allow exactly the default **branch**
   (`main` here), with no wildcard or tag policy. Keep existing CodeQL default
   setup configured for the four required language categories.
4. Run the read-only check below before any promotion. A missing environment
   or insufficient protection must be fixed by an administrator, not created
   implicitly by starting a job that references its name.

```sh
node scripts/verify-release-environment.mjs githubnext/gh-aw-cao
```

The supported `.github/github-app.yml` exposes this as a manual verification
script. It only performs GET requests. No credentials, environment mutations,
branch-policy mutations, or release writes occur in the verifier.

5. Dispatch a candidate promotion, inspect the bound evidence and validation,
   and obtain independent environment approval. Retain environment
   configuration, approval history, exact SHAs, workflow/job links, scanner
   analysis IDs, and the promotion receipt in the approved evidence system
   beyond Actions retention when required.

**Administrative boundary:** GitHub environment protection gates this workflow
job, not every possible release edit. A user or App with repository
`contents: write` can still edit releases directly through GitHub's UI/API.
Administrators must restrict that authority and require this promotion path
operationally; this repository change cannot impose a release-specific UI/API
permission boundary. The workflow uses `GITHUB_TOKEN`, whose release updates
do not automatically trigger other Actions workflows. It promotes the release
to latest only; downstream publication must use its separately authorized path.
Repository releases have no conditional update primitive here, so concurrent
out-of-band administrator edits remain an operational risk despite immediate
revalidation and postcondition checks.

## Hosted CLI scanner disposition

Parent PR [#18462](https://github.com/githubnext/gh-aw-cao/pull/18462), revision
`81b7333a7cbb4cc5064ccb3f2c7d9dd22196d132`,
[CodeQL check 117485353748](https://github.com/githubnext/gh-aw-cao/runs/117485353748)
reported a high-severity potential allocation overflow at
`server/internal/hostedcli/apple_container.go`: `42 + len(spec.Args)`.
This is scanner evidence, not independently established exploitation.
The fix removes arithmetic from allocation sizing by appending variable
arguments to a fixed slice literal. Tests preserve empty/single/many argument
ordering and boundaries, without a CodeQL suppression.

Dashboard test fixes preserve the intentional native `gh aw update` commands,
explicit control-repository context, PR publication, and opt-in auto-merge.
Neither local tests nor the prior merge-gate implementation prove promotion
readiness: release promotion requires its own exact-SHA validation and scanner
evidence plus independent approval.
