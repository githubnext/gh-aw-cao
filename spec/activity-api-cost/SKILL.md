---
name: analyze-activity-api-cost
description: Scan sharded CAO Activity workflow outputs and estimate GitHub REST API capacity.
argument-hint: "[OWNER/REPO]"
allowed-tools: bash
metadata:
  version: "1.0.0"
---

# Analyze CAO Activity API cost

Use this skill to measure the cost of observing recent `cao-activity.yml` runs and
to estimate the GitHub REST API cost incurred inside each run by
`gh aw logs --audit --artifacts usage`.

## Safety and interpretation

- Use a read-only GitHub App installation token with Actions read access. Keep it
  only in `GH_TOKEN` or `GITHUB_TOKEN`; never print or persist it.
- Use a dedicated token when validating rate-limit deltas. A shared token makes
  `x-ratelimit-used` and `/rate_limit` snapshots include unrelated traffic.
- Treat the Activity cache and downloaded artifacts as disposable evidence, not
  historical authority or rollout policy.
- Preserve partial and timed-out scans as partial. Do not extrapolate them as
  complete repository coverage.
- `run.github_api_calls` in the JSONL describes calls made by the analyzed agent
  run. It is not the cost of collecting that run and MUST NOT be summed into the
  acquisition model.

## Procedure

1. Select the latest completed successful Activity runs. Exclude in-progress and
   cancelled runs so every sample has a complete output artifact.
2. Download several runs with `download-runs.mjs`. It lists successful workflow
   runs once, assigns positions modulo the shard count, and downloads each
   assigned run's job logs and `cao-activity-index` artifact with bounded
   concurrency:

   ```bash
   GH_TOKEN=... node spec/activity-api-cost/download-runs.mjs \
     --repo OWNER/REPO \
     --runs 8 \
     --shard-count 2 \
     --shard-index 0 \
     --before 2026-09-14T22:45:00Z \
     --output /tmp/activity-api-cost
   ```

   Run shard index `1` separately with the same arguments, including the same
   `--before` cutoff; otherwise a run completing between distributed shard
   starts can shift modulo positions and cause overlap or omission. For one
   machine, `--shard-count 1 --concurrency 2` avoids repeating run discovery.
   Each shard writes a manifest containing endpoint paths, response status,
   rate-limit headers, modeled primary units, byte counts, and no authorization
   values.
3. Inspect the job-log summary without extracting every file:

   ```bash
   unzip -p /tmp/activity-api-cost/shard-*/*/job-logs.zip |
     grep -E 'Runs:|Skipping workflow target|Downloading missing artifacts'
   ```

   `Runs:` provides discovered and downloaded report counts. Timeout warnings
   identify workflow targets that were not covered.
4. Analyze artifacts as streams:

   ```bash
   node spec/activity-api-cost/analyze-runs.mjs \
     --input /tmp/activity-api-cost \
     --hourly-limit 15000 \
     --reserve 4000
   ```

   The analyzer uses `unzip -p` and Node's line iterator, so memory use is
   bounded by one JSONL record rather than artifact size. It chooses the newest
   wildcard shard when present. For legacy monolithic snapshots, the final
   `github_api_rate_limit` envelope separates the latest discovery block from
   its enriched `run` records.
5. Re-run with deployment assumptions to predict repository capacity:

   ```bash
   node spec/activity-api-cost/analyze-runs.mjs \
     --input /tmp/activity-api-cost \
     --workflows-per-repository 5 \
     --fresh-runs-per-workflow 10
   ```

6. Compare the analyzer's modeled units with the downloader manifest and a
   dedicated token's `x-ratelimit-used` movement. Explain discrepancies before
   changing the coefficient: retries, pagination, missing metadata fallbacks,
   concurrent token users, and secondary throttling are common causes.

## Cost model

There are two separate costs.

### Observing an Activity run

The downloader normally spends:

\[
C_{observe}=P_{activity-runs}+\sum_i(P_{artifact-list,i}+1_{artifact-zip,i}+1_{logs-zip,i})
\]

With one run-list page and one artifact-list page, observing \(N\) Activity runs
costs \(1+3N\) primary units. Redirected object-storage transfers add bytes and
latency, but not another GitHub REST request. Pagination adds one unit per page.

### Activity's internal collection

For each discovery iteration \(k\), let \(W_k\) be workflow-resolution requests;
the run-list request is one page because the gh-aw batch is at most 100. For
fresh report \(i\), let \(A_i\) be artifact count, \(U_i\) selected usage
archives, and \(J_i\) job count:

\[
C_{collect}=\sum_k(1+W_k)+
\sum_i\left(1+\lceil A_i/30\rceil+\lceil A_i/100\rceil+U_i+\lceil J_i/100\rceil\right)
\]

The per-run terms are run metadata, gh-aw's artifact enumeration,
`gh run download`'s artifact enumeration, archive download, and jobs. Under the
normal \(A_i\le30\), \(U_i=1\), and \(J_i\le100\) case:

\[
C_{collect}=2Q+5N
\]

where \(Q\) is the number of successful workflow queries and \(N\) is the number
of fresh reports analyzed. The analyzer also emits a lower bound \(Q+5N\) and
gh-aw's conservative reservation \(2Q+9N\). `GET /rate_limit` consumes no
primary unit, although it contributes to secondary limits.

For a repository with \(W\) installed workflows and \(R\) fresh runs per
workflow, the normal prediction is:

\[
C_{repo}=W(2+5R),\qquad
repositories=\left\lfloor\frac{limit-reserve}{C_{repo}}\right\rfloor
\]

Caching changes \(R\) to only the fresh runs that require remote metadata,
artifacts, and jobs. Discovery remains payable.

## 2026-09-14 sample

The scripts were applied to four recent successful
`githubnext/gh-aw-cao` Activity runs. Run 66 used the legacy monolithic snapshot;
runs 70–72 used one new wildcard JSONL shard per refresh.

| Run | Run ID | Successful workflow queries | Run-list candidates | Reports analyzed | Artifact ZIP | Download step | Normal primary units |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 66 | 34899408774 | 10 | 755 | 517 | 194.9 MB | 958 s | 2,605 |
| 70 | 34901567011 | 9 | 676 | 384 | 7.6 MB | 906 s | 1,938 |
| 71 | 34901839217 | 11 | 718 | 445 | 13.5 MB | 904 s | 2,247 |
| 72 | 34903596189 | 12 | 866 | 624 | 22.8 MB | 935 s | 3,144 |

The sample contains 1,970 analyzed reports and 42 successful workflow queries,
for 9,934 modeled primary units, or **5.04 units per report** including
amortized discovery. With the observed 15,000-unit installation limit and the
workflow's 4,000-unit reserve, the predictive capacity is about **2,181 fresh
reports per rate-limit window**.

The JSONL contained 3,015 raw run-list candidates. The human-readable job
summaries reported 3,001 discovered runs after gh-aw filtering (754, 675, 715,
and 857 respectively); use report count, not either discovery count, as \(N\).

Repository capacity depends on density:

| Workflows/repository | Fresh runs/workflow | Units/repository | Repositories in 11,000 usable units |
| ---: | ---: | ---: | ---: |
| 1 | 10 | 52 | 211 |
| 5 | 10 | 260 | 42 |
| 50 | 46.9 | 11,825 | 0 complete repositories |

The last row approximates this unusually dense control repository. It requires
cache reuse, a later rate-limit window, or a smaller evidence slice to complete
while preserving the reserve. The 15-minute context deadlines in every sampled
run also made coverage partial; API capacity alone does not guarantee
completion.

## Sources

- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub Actions workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
- [GitHub Actions artifacts](https://docs.github.com/en/rest/actions/artifacts)
- [GitHub Actions workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs)
- [GitHub REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- [`gh aw logs` run discovery](https://github.com/github/gh-aw/blob/de4c8431d6c9523db610844effea67372b99882b/pkg/cli/logs_github_api.go#L337-L402)
- [`gh aw logs` artifact enumeration](https://github.com/github/gh-aw/blob/de4c8431d6c9523db610844effea67372b99882b/pkg/cli/logs_download_artifacts.go#L84-L181)
- [`gh aw logs` run processing](https://github.com/github/gh-aw/blob/de4c8431d6c9523db610844effea67372b99882b/pkg/cli/logs_run_processor.go#L283-L355)
- [`gh aw logs` jobs collection](https://github.com/github/gh-aw/blob/de4c8431d6c9523db610844effea67372b99882b/pkg/cli/logs_github_api.go#L74-L105)
- [`gh run download` artifact requests](https://github.com/cli/cli/blob/38316c1c4f275030e3df6666382922e75410d68b/pkg/cmd/run/shared/artifacts.go#L22-L57)
