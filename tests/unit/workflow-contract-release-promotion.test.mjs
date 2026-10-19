import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { collectPromotionEvidence, promoteRelease } from "../../scripts/release-promotion.mjs";
import { codeqlCategories, digest, readCodeqlEvidence, repositoryApi } from "../../scripts/release-promotion-evidence.mjs";

function fixture() {
  const revision = "a".repeat(40);
  const context = {
    repository: "octo/cao", eventName: "workflow_dispatch", sha: "b".repeat(40),
    ref: "refs/heads/main", actor: "maintainer", triggeringActor: "maintainer", runId: 100, runAttempt: "1",
  };
  const environment = {
    id: 10, name: "release-latest", can_admins_bypass: false,
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "Team", reviewer: { id: 1 } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const release = {
    id: 42, tag_name: "v0.2.0", name: "v0.2.0", draft: false, prerelease: true, immutable: true,
    published_at: "2026-10-17T00:00:00Z", target_commitish: revision, body: "Reviewed highlights",
  };
  const assets = [`cao-runtime-${revision}.tgz`, `cao-runtime-${revision}.tgz.sha256`,
    "gh-cao-darwin-amd64", "gh-cao-darwin-arm64", "gh-cao-linux-amd64", "gh-cao-linux-arm64",
    "gh-cao-windows-amd64.exe", "gh-cao-windows-arm64.exe", "checksums.txt"].map((name, id) =>
    ({ id: id + 1, name, state: "uploaded", size: 100, digest: `sha256:${"c".repeat(64)}` }));
  const analyses = codeqlCategories.map((category, i) => ({
    id: 200 + i, category, error: "", commit_sha: revision, ref: "refs/heads/main",
    tool: { name: "CodeQL" }, results_count: 0,
  }));
  const data = {
    "": { fork: false, default_branch: "main" },
    "branches/main": { commit: { sha: context.sha } },
    "collaborators/maintainer/permission": { role_name: "maintain" },
    "environments/release-latest": environment,
    "environments/release-latest/deployment-branch-policies": {
      total_count: 1, branch_policies: [{ name: "main", type: "branch" }],
    },
    "releases/tags/v0.2.0": release,
    "releases/42": release,
    "git/ref/tags/v0.2.0": { object: { type: "commit", sha: revision } },
    [`compare/${revision}...${context.sha}`]: { status: "ahead" },
    "releases/latest": { id: 41, tag_name: "v0.1.19", draft: false, prerelease: false },
    "releases/42/assets": assets,
    "actions/workflows/release.lock.yml/runs": { workflow_runs: [{
      id: 99, run_attempt: 1, head_sha: revision, head_branch: "main", path: ".github/workflows/release.lock.yml",
      event: "workflow_dispatch", status: "completed", conclusion: "success",
    }] },
    "code-scanning/analyses": analyses,
    "actions/runs/100/approvals": [{
      state: "approved", environments: [{ id: 10, name: "release-latest" }], user: { login: "reviewer", type: "User" },
    }],
  };
  for (const analysis of analyses) {
    data[`code-scanning/analyses/${analysis.id}`] = { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL" } }, results: [] }] };
  }
  const calls = [];
  const request = async (route, parameters = {}) => {
    calls.push({ route, parameters });
    if (route === "PATCH /repos/octo/cao/releases/42") {
      Object.assign(release, { prerelease: false });
      data["releases/latest"] = release;
      return { data: release };
    }
    const path = route.replace(/^GET \/repos\/octo\/cao\/?/, "");
    if (!Object.hasOwn(data, path)) throw new Error(`Unavailable fixture endpoint: ${path}`);
    return { data: structuredClone(data[path]) };
  };
  const needs = Object.fromEntries(["preflight", "contracts", "dashboard", "server", "evidence"]
    .map((name) => [name, { result: "success" }]));
  return { revision, context, environment, release, assets, analyses, data, calls, request, needs };
}

test("only an approved immutable prerelease transitions to latest without replacing assets or tag", async () => {
  const f = fixture();
  const source = readFileSync(new URL("../../.github/workflows/release.md", import.meta.url), "utf8");
  const publisher = parse(/^---\n([\s\S]*?)\n---/.exec(source)[1]).jobs["publish-release"]
    .steps.find(({ name }) => name === "Publish verified draft as prerelease").with.script;
  for (const { name } of f.assets.slice(2)) {
    assert.ok(publisher.includes(`'${name}'`), `promotion fixture must match the published asset ${name}`);
  }
  const approved = await collectPromotionEvidence(f.request, f.context, "v0.2.0");
  assert.ok(f.calls.every(({ route }) => route.startsWith("GET ")));
  assert.equal(approved.revision, f.revision);
  assert.equal(approved.notesDigest, digest("Reviewed highlights"));
  assert.deepEqual(approved.codeql.map(({ category }) => category), codeqlCategories);
  const result = await promoteRelease(f.request, f.context, approved, f.needs);
  assert.equal(result.promoted, true);
  assert.equal(result.approvedBy, "reviewer");
  assert.deepEqual(f.calls.filter(({ route }) => route.startsWith("PATCH ")), [{
    route: "PATCH /repos/octo/cao/releases/42",
    parameters: { draft: false, prerelease: false, make_latest: "true" },
  }]);
});

const rejected = [
  ["missing environment", (f) => { delete f.data["environments/release-latest"]; }],
  ["self-review enabled", (f) => { f.environment.protection_rules[0].prevent_self_review = false; }],
  ["missing reviewers", (f) => { f.environment.protection_rules[0].reviewers = []; }],
  ["admin bypass", (f) => { f.environment.can_admins_bypass = true; }],
  ["unknown bypass policy", (f) => { delete f.environment.can_admins_bypass; }],
  ["unrestricted environment", (f) => { f.environment.deployment_branch_policy = null; }],
  ["tag deployment policy", (f) => { f.data["environments/release-latest/deployment-branch-policies"].branch_policies[0].type = "tag"; }],
  ["wildcard deployment policy", (f) => { f.data["environments/release-latest/deployment-branch-policies"].branch_policies[0].name = "*"; }],
  ["fork", (f) => { f.data[""].fork = true; }],
  ["nondefault dispatch", (f) => { f.context.ref = "refs/heads/feature"; }],
  ["stale workflow SHA", (f) => { f.data["branches/main"].commit.sha = "c".repeat(40); }],
  ["rerun", (f) => { f.context.runAttempt = "2"; }],
  ["unprivileged actor", (f) => { f.data["collaborators/maintainer/permission"].role_name = "write"; }],
  ["stable release", (f) => { f.release.prerelease = false; }],
  ["draft release", (f) => { f.release.draft = true; }],
  ["mutable release", (f) => { f.release.immutable = false; }],
  ["wrong tag SHA", (f) => { f.data["git/ref/tags/v0.2.0"].object.sha = "d".repeat(40); }],
  ["unreachable candidate", (f) => { f.data[`compare/${f.revision}...${f.context.sha}`].status = "diverged"; }],
  ["rollback", (f) => { f.data["releases/latest"].tag_name = "v0.3.0"; }],
  ["repromotion", (f) => { f.data["releases/latest"].tag_name = "v0.2.0"; }],
  ["missing asset", (f) => { f.assets.pop(); }],
  ["legacy binary asset names", (f) => {
    for (const asset of f.assets) asset.name = asset.name.replace(/^gh-cao-/, "");
  }],
  ["missing digest", (f) => { delete f.assets[0].digest; }],
  ["unfinished preparation", (f) => { f.data["actions/workflows/release.lock.yml/runs"].workflow_runs[0].conclusion = null; }],
  ["wrong preparation branch", (f) => { f.data["actions/workflows/release.lock.yml/runs"].workflow_runs[0].head_branch = "untrusted"; }],
  ["missing scanner language", (f) => { f.analyses.pop(); }],
  ["scanner wrong SHA", (f) => { f.analyses[0].commit_sha = "e".repeat(40); }],
  ["scanner wrong ref", (f) => { f.analyses[0].ref = "refs/pull/1/head"; }],
  ["scanner failed", (f) => { f.analyses[0].error = "build failed"; }],
  ["incomplete SARIF", (f) => { f.analyses[0].results_count = 1; }],
];
for (const [name, mutate] of rejected) {
  test(`promotion fails closed: ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(collectPromotionEvidence(f.request, f.context, "v0.2.0"));
    assert.ok(f.calls.every(({ route }) => route.startsWith("GET ")));
  });
}

test("exact-analysis high/critical/error results block even if the alert was dismissed", async () => {
  for (const [security, level] of [["high", "warning"], ["critical", "warning"], [null, "error"], [undefined, "warning"]]) {
    const f = fixture();
    f.analyses[0].results_count = 1;
    f.data["code-scanning/analyses/200"].runs[0].results.push({
      ruleId: "go/allocation-overflow", level, properties: { "github/alertNumber": 7 },
    });
    f.data["code-scanning/alerts/7"] = {
      state: "dismissed", tool: { name: "CodeQL" },
      rule: { id: "go/allocation-overflow", severity: level, security_severity_level: security },
    };
    await assert.rejects(collectPromotionEvidence(f.request, f.context, "v0.2.0"), /CodeQL/);
  }
});

test("scanner inventory paginates and never substitutes an older success for the newest failed analysis", async () => {
  const f = fixture();
  const base = repositoryApi(f.request, f.context.repository);
  const get = (path, parameters) => path === "code-scanning/analyses" && parameters.page === 1
    ? Promise.resolve(Array.from({ length: 100 }, () => ({ commit_sha: "c".repeat(40) })))
    : base(path, parameters);
  assert.equal((await readCodeqlEvidence(get, f.revision, "main")).length, 4);
  f.analyses.unshift({ ...f.analyses[0], id: 999, error: "latest analysis failed" });
  await assert.rejects(readCodeqlEvidence(get, f.revision, "main"), /Missing or failed/);
});

test("independent approval and every successful validation are required before any mutation", async () => {
  for (const scenario of ["absent", "self", "case-self", "bot", "wrong-environment", "rejected", "rerun", "skipped", "failed", "missing-job"]) {
    const f = fixture();
    const snapshot = await collectPromotionEvidence(f.request, f.context, "v0.2.0");
    const reviews = f.data["actions/runs/100/approvals"];
    if (scenario === "absent") reviews.length = 0;
    if (scenario === "self") reviews[0].user.login = "maintainer";
    if (scenario === "case-self") reviews[0].user.login = "MAINTAINER";
    if (scenario === "bot") reviews[0].user.type = "Bot";
    if (scenario === "wrong-environment") reviews[0].environments[0].id++;
    if (scenario === "rejected") reviews[0].state = "rejected";
    if (scenario === "rerun") f.context.runAttempt = "2";
    if (scenario === "skipped") f.needs.server.result = "skipped";
    if (scenario === "failed") f.needs.contracts.result = "failure";
    if (scenario === "missing-job") delete f.needs.dashboard;
    await assert.rejects(promoteRelease(f.request, f.context, snapshot, f.needs));
    assert.ok(f.calls.every(({ route }) => route.startsWith("GET ")), scenario);
  }
});

test("candidate, scanner, environment, and latest are reread after approval and bound to its snapshot", async () => {
  for (const mutate of [
    (f) => { f.release.body = "Unreviewed notes"; },
    (f) => { f.assets[0].digest = `sha256:${"e".repeat(64)}`; },
    (f) => { f.data["releases/latest"].id = 40; },
    (f) => { f.environment.id = 11; },
    (f) => { f.data["code-scanning/analyses/200"].runs[0].properties = { changed: true }; },
  ]) {
    const f = fixture();
    const snapshot = await collectPromotionEvidence(f.request, f.context, "v0.2.0");
    mutate(f);
    await assert.rejects(promoteRelease(f.request, f.context, snapshot, f.needs), /changed after preparation/);
    assert.ok(f.calls.every(({ route }) => route.startsWith("GET ")));
  }
});

test("failed promotion postcondition is not reported as success", async () => {
  const f = fixture();
  const snapshot = await collectPromotionEvidence(f.request, f.context, "v0.2.0");
  const request = (route, parameters) => route.startsWith("PATCH ") ? Promise.resolve({ data: {} }) : f.request(route, parameters);
  await assert.rejects(promoteRelease(request, f.context, snapshot, f.needs), /did not produce/);
});

test("repository identifiers cannot change the API route", () => {
  for (const repository of ["", "--help", "octo/cao/../other"]) {
    assert.throws(() => repositoryApi(() => {}, repository), /explicit OWNER/);
  }
});

test("promotion jobs cannot publish shared caches while executing the candidate", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/release-promote.yml", import.meta.url), "utf8"));
  assert.equal(workflow["cache-mode"], "read");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(["read", "none"].includes(job["cache-mode"] ?? workflow["cache-mode"]),
      `${name} must not override read-only cache authority with write access`);
  }
});

test("only promotion is approval-gated; automated prerelease publication and PR filters are unchanged", () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const workflow = parse(read(".github/workflows/release-promote.yml"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.concurrency.group, "release-latest-promotion");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const { jobs } = workflow;
  assert.equal(jobs.preflight.environment, undefined);
  assert.equal(jobs.preflight.permissions.contents, "read");
  assert.equal(jobs.promote.environment, "release-latest");
  assert.equal(jobs.promote.permissions.contents, "write");
  assert.deepEqual(jobs.promote.needs, ["preflight", "contracts", "dashboard", "server", "evidence"]);
  for (const name of ["contracts", "dashboard", "server"]) {
    assert.equal(jobs[name].if, undefined);
    assert.equal(jobs[name].steps[0].with.ref, "${{ needs.preflight.outputs.revision }}");
    assert.equal(jobs[name].steps[0].with["persist-credentials"], false);
    assert.equal(jobs[name].permissions, undefined);
  }
  assert.equal(jobs.promote.steps[0].with.ref, "${{ github.sha }}");
  assert.match(read(".github/workflows/release.md"), /prerelease: true,\s+make_latest: 'false'/);
  assert.doesNotMatch(read(".github/workflows/release.md"), /environment: release-latest/);
  for (const name of ["cgo", "cid", "workflow-contracts"]) {
    const ci = parse(read(`.github/workflows/${name}.yml`));
    assert.ok(ci.on.pull_request.paths || ci.on.pull_request["paths-ignore"]);
    assert.equal(ci.jobs.gate, undefined);
  }
  assert.equal(parse(read(".github/github-app.yml")).scripts[0].command,
    "node scripts/verify-release-environment.mjs githubnext/gh-cao");
});
