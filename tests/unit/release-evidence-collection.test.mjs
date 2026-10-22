import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectReleaseEvidence, runGh } from "../../scripts/collect-release-evidence.mjs";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const repository = "octo/cao";
const image = `ghcr.io/${repository}/cao-server@${digest}`;
const date = "2026-10-22T00:00:00Z";
const secret = "credential-value-that-must-not-appear";

function fixture() {
  const options = { repository, revision, image, packageRun: 42 };
  const run = {
    id: 42, run_attempt: 2, head_sha: revision, repository: { full_name: repository },
    path: ".github/workflows/cao-package.yml", event: "push", conclusion: "success",
    name: secret, actor: { login: secret }, html_url: `https://user:${secret}@example.com`,
  };
  const jobs = [{ id: 99, run_id: 42, run_attempt: 2, head_sha: revision, name: secret,
    conclusion: "success", steps: [{ name: secret, number: 1, conclusion: "success" }] }];
  const data = {
    "actions/runs/42": run,
    "actions/runs/42/attempts/2/jobs?per_page=100&page=1": { jobs },
    "actions/runs/42/artifacts?per_page=100&page=1": { artifacts: [
      { id: 100, name: secret, digest, expired: false, expires_at: date, archive_download_url: secret },
    ] },
    "actions/runs/42/approvals": [{
      state: "approved", user: { id: 12, login: secret }, comment: secret, environments: [{ id: 7, name: secret }],
    }],
  };
  const invocation = `https://github.com/${repository}/actions/runs/42/attempts/2`;
  const verification = [{ verificationResult: { statement: {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: image.split("@")[0], digest: { sha256: "b".repeat(64) } }],
    predicate: { runDetails: { metadata: { invocationId: invocation } }, sensitive: secret },
  } }, attestation: { raw: secret } }];
  const receipt = {
    kind: "cao.deploy.azure.receipt", schemaVersion: 1, sourceRevision: revision, sourceWorktree: "dirty",
    environment: "development", imageAssurance: "not-evaluated-development-only",
    contextSha256: "c".repeat(64), planSha256: "d".repeat(64), startedAt: date, completedAt: date,
    deploymentId: secret, subscription: secret, unexpectedSecret: secret,
    images: ["azure-functions-runtime", "azure-empty-ingest-runtime"].map((target, i) => ({
      target, digest, reference: `private.azurecr.io/image-${i}@${digest}`,
      configuredReference: `private.azurecr.io/image-${i}@${digest}`,
      scan: "not-performed", sbom: "not-generated", provenance: "local-context-not-attested", tag: secret,
    })),
    verification: [{ check: "health", status: 200, passed: true, checkedAt: date, body: secret }],
  };
  const calls = [];
  const deps = {
    command: async (args) => {
      calls.push(args);
      if (args[0] === "--version") return `gh version 2.83.0 (2025-11-01)\n${secret}`;
      if (args[0] === "attestation") return JSON.stringify(verification);
      assert.deepEqual(args.slice(0, 5), ["api", "--hostname", "github.com", "--method", "GET"]);
      const path = args[5].replace(`repos/${repository}/`, "");
      if (!Object.hasOwn(data, path)) throw new Error(`API failure ${secret}`);
      return JSON.stringify(data[path]);
    },
    now: () => new Date(date),
    loadReceipt: async () => JSON.stringify(receipt),
  };
  return { options, deps, calls, data, run, jobs, verification, receipt };
}

test("collects bounded exact run-attempt references without claiming governance or retention", async () => {
  const f = fixture();
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.deepEqual(Object.keys(result), [
    "kind", "schemaVersion", "collectedAt", "status", "repository", "sourceRevision", "image", "collector", "attribution",
    "package", "promotion", "provenance", "deployment", "imageSourceBinding", "deployedImageDigest",
    "independentRetention", "governance", "operatingEffectiveness",
  ]);
  assert.equal(result.kind, "cao.release.evidence");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "incomplete");
  assert.match(result.collector.scriptSHA256, /^[0-9a-f]{64}$/);
  assert.equal(result.collector.githubCli.version, "2.83.0");
  assert.equal(result.package.sourceBinding, "push-revision-matches");
  assert.equal(result.package.attempt, 2);
  assert.equal(result.package.jobs.records[0].id, 99);
  assert.equal(result.package.jobs.records[0].reference, `https://github.com/${repository}/actions/runs/42/job/99`);
  assert.equal(result.package.artifacts.attemptBinding, "unknown");
  assert.equal(result.package.approvals.records[0].actorId, 12);
  assert.equal(result.package.approvals.independentApproval, "unknown");
  assert.equal(result.imageSourceBinding, "unknown");
  assert.equal(result.independentRetention.status, "unknown");
  assert.equal(result.operatingEffectiveness, "not-assessed");
  assert.equal(result.governance, "not-assessed");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(f.calls.every((args) => args[0] === "--version" || (args[0] === "api" && args.includes("GET"))));
});

test("verifier constrains exact source, image, trusted reusable publisher and run attempt", async () => {
  const f = fixture();
  f.options.verify = true;
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.equal(result.provenance.status, "verified-by-gh");
  assert.equal(result.imageSourceBinding, "verified-by-gh");
  assert.match(result.provenance.receiptSHA256, /^[0-9a-f]{64}$/);
  assert.equal(result.provenance.rawReceiptRetained, false);
  assert.deepEqual(f.calls.at(-1), [
    "attestation", "verify", `oci://${image}`, "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/cao-package-publish.yml`,
    "--source-digest", revision, "--predicate-type", "https://slsa.dev/provenance/v1",
    "--limit", "10", "--format", "json", "--hostname", "github.com",
  ]);
  assert.ok(!JSON.stringify(result).includes(secret));
});

for (const [name, mutate] of [
  ["wrong digest", (f) => { f.verification[0].verificationResult.statement.subject[0].digest.sha256 = "e".repeat(64); }],
  ["wrong subject", (f) => { f.verification[0].verificationResult.statement.subject[0].name = "ghcr.io/elsewhere/cao/cao-server"; }],
  ["wrong attempt", (f) => { f.verification[0].verificationResult.statement.predicate.runDetails.metadata.invocationId = `https://github.com/${repository}/actions/runs/42/attempts/1`; }],
  ["wrong predicate", (f) => { f.verification[0].verificationResult.statement.predicateType = "sbom"; }],
  ["empty receipt", (f) => { f.verification.length = 0; }],
  ["verifier failure", (f) => {
    const command = f.deps.command;
    f.deps.command = (args) => args[0] === "attestation" ? Promise.reject(new Error(secret)) : command(args);
  }],
]) {
  test(`unverified provenance remains unknown: ${name}`, async () => {
    const f = fixture();
    f.options.verify = true;
    mutate(f);
    const result = await collectReleaseEvidence(f.options, f.deps);
    assert.equal(result.provenance.status, "unknown");
    assert.equal(result.imageSourceBinding, "unknown");
    assert.equal(result.status, "incomplete");
    assert.ok(!JSON.stringify(result).includes(secret));
  });
}

test("development receipt retains per-target identities and failures, not production or measured-image assurance", async () => {
  const f = fixture();
  f.options.azureReceipt = "selected.json";
  f.receipt.verification[0].passed = false;
  f.receipt.verification[0].status = 503;
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.equal(result.deployment.status, "reported");
  assert.equal(result.deployment.sourceWorktree, "dirty");
  assert.equal(result.deployment.verification[0].passed, false);
  assert.equal(result.deployment.images.length, 2);
  assert.equal(result.deployment.images[0].digest, digest);
  assert.match(result.deployment.images[0].referenceSHA256, /^[0-9a-f]{64}$/);
  assert.equal(result.deployment.imageAssurance, "not-evaluated-development-only");
  assert.equal(result.deployment.runningImageMeasurement, "unknown");
  assert.equal(result.deployedImageDigest.status, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private\.azurecr\.io/);
  assert.ok(!JSON.stringify(result).includes(secret));
});

for (const [name, mutate] of [
  ["wrong source", (f) => { f.receipt.sourceRevision = "f".repeat(40); }],
  ["production", (f) => { f.receipt.environment = "production"; }],
  ["upgraded assurance", (f) => { f.receipt.imageAssurance = "verified"; }],
  ["digest mismatch", (f) => { f.receipt.images[0].digest = `sha256:${"f".repeat(64)}`; }],
  ["configured mismatch", (f) => { f.receipt.images[0].configuredReference = "another-image"; }],
  ["duplicate target", (f) => { f.receipt.images[1] = f.receipt.images[0]; }],
  ["both ingestion targets", (f) => {
    f.receipt.images.push({ ...f.receipt.images[1], target: "azure-ingest-runtime" });
  }],
  ["credential URL", (f) => { f.receipt.images[0].reference = `https://user:${secret}@host/image`; }],
  ["oversized receipt", (f) => { f.deps.loadReceipt = async () => "x".repeat(1024 * 1024 + 1); }],
  ["invalid JSON", (f) => { f.deps.loadReceipt = async () => secret; }],
  ["missing receipt", (f) => { f.deps.loadReceipt = async () => { throw new Error(secret); }; }],
]) {
  test(`selected deployment receipt fails closed: ${name}`, async () => {
    const f = fixture();
    f.options.azureReceipt = "selected.json";
    mutate(f);
    await assert.rejects(collectReleaseEvidence(f.options, f.deps), (error) => !error.message.includes(secret));
  });
}

test("unavailable approvals, artifacts and checks are explicit unknowns, not empty successful collections", async () => {
  const f = fixture();
  for (const path of Object.keys(f.data).filter((path) => path !== "actions/runs/42")) delete f.data[path];
  const result = await collectReleaseEvidence(f.options, f.deps);
  for (const key of ["approvals", "artifacts", "jobs"]) assert.equal(result.package[key].status, "unknown");
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("empty approval history is unknown and known artifact roles never expose arbitrary names", async () => {
  const f = fixture();
  f.data["actions/runs/42/approvals"] = [];
  const artifacts = f.data["actions/runs/42/artifacts?per_page=100&page=1"].artifacts;
  artifacts.push({ id: 101, name: "cao-server-42-2", digest, expired: true, expires_at: date });
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.equal(result.package.approvals.status, "unknown");
  assert.equal(result.package.approvals.reason, "no-approval-records");
  assert.deepEqual(result.package.artifacts.records.map(({ role }) => role), ["unknown", "sealed-candidate"]);
  assert.equal(result.package.artifacts.records[1].expired, true);
  assert.equal(result.package.artifacts.attemptBinding, "unknown");
});

test("malformed and oversized optional responses remain unknown; selected run read failures reject", async () => {
  for (const raw of [secret, "x".repeat(2 * 1024 * 1024 + 1), JSON.stringify({ jobs: [{}] })]) {
    const f = fixture();
    const command = f.deps.command;
    f.deps.command = (args) => args.at(-1).includes("/jobs?") ? Promise.resolve(raw) : command(args);
    assert.equal((await collectReleaseEvidence(f.options, f.deps)).package.jobs.status, "unknown");
  }
  const f = fixture();
  delete f.data["actions/runs/42"];
  await assert.rejects(collectReleaseEvidence(f.options, f.deps));
});

test("pagination and step bounds are explicit; wrong-attempt jobs are not accepted", async () => {
  const f = fixture();
  for (let page = 1; page <= 5; page++) {
    f.data[`actions/runs/42/attempts/2/jobs?per_page=100&page=${page}`] = { jobs: Array.from({ length: 100 }, (_, i) => ({
      ...f.jobs[0], id: page * 100 + i, steps: Array.from({ length: 101 }, (_, number) => ({ number: number + 1, conclusion: "success" })),
    })) };
  }
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.equal(result.package.jobs.status, "incomplete");
  assert.equal(result.package.jobs.records.length, 500);
  assert.equal(result.package.jobs.records[0].steps.length, 100);
  assert.equal(result.package.jobs.records[0].stepsComplete, false);
  assert.ok(!f.calls.some((args) => args.at(-1).includes("page=6")));
  f.jobs[0].run_attempt = 1;
  f.data["actions/runs/42/attempts/2/jobs?per_page=100&page=1"] = { jobs: f.jobs };
  assert.equal((await collectReleaseEvidence(f.options, f.deps)).package.jobs.status, "unknown");
});

test("run identity mismatch fails; manual source and promotion workflow SHA are not conflated with product SHA", async () => {
  const f = fixture();
  for (const patch of [{ id: 43 }, { repository: { full_name: "elsewhere/cao" } }, { path: ".github/workflows/cgo.yml" }]) {
    const bad = fixture();
    Object.assign(bad.run, patch);
    await assert.rejects(collectReleaseEvidence(bad.options, bad.deps), /Run identity/);
  }
  f.run.event = "workflow_dispatch";
  f.run.head_sha = "f".repeat(40);
  f.jobs[0].head_sha = f.run.head_sha;
  f.options.promotionRun = 43;
  f.data["actions/runs/43"] = { ...f.run, id: 43, path: ".github/workflows/release-promote.yml" };
  const result = await collectReleaseEvidence(f.options, f.deps);
  assert.equal(result.package.sourceBinding, "unknown");
  assert.equal(result.promotion.sourceBinding, "unknown");
  assert.equal(result.promotion.workflowRevision, f.run.head_sha);
  assert.equal(result.sourceRevision, revision);
});

test("invalid owner selections cause no commands", async () => {
  for (const patch of [{ revision: "main" }, { packageRun: -1 }, { repository: "../cao" },
    { image: `ghcr.io/elsewhere/cao/cao-server@${digest}` }, { image: image.replace(`@${digest}`, ":latest") }]) {
    const f = fixture();
    await assert.rejects(collectReleaseEvidence({ ...f.options, ...patch }, f.deps));
    assert.equal(f.calls.length, 0);
  }
});

test("CLI refuses missing inputs without leaking values or replacing an existing output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cao-release-evidence-"));
  const output = join(dir, "report.json");
  try {
    await writeFile(output, secret);
    assert.throws(() => execFileSync(process.execPath, ["scripts/collect-release-evidence.mjs", "--output", output], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }), (error) => error.status === 1 && !error.stderr.includes(secret));
    assert.equal(await readFile(output, "utf8"), secret);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI writes a private persistent report, consumes the real receipt file and refuses overwrites", async () => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), "cao-release-cli-"));
  const output = join(dir, "report.json");
  const receipt = join(dir, "azure.json");
  const fixtureFile = join(dir, "responses.json");
  try {
    await writeFile(fixtureFile, JSON.stringify(f.data));
    await writeFile(receipt, JSON.stringify(f.receipt));
    await writeFile(join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  console.log("gh version 2.83.0 (2025-11-01)");
} else {
  const records = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, "utf8"));
  const key = process.argv.at(-1).replace("repos/octo/cao/", "");
  if (!Object.hasOwn(records, key)) process.exit(1);
  console.log(JSON.stringify(records[key]));
}
`, { mode: 0o700 });
    const args = ["scripts/collect-release-evidence.mjs", "--repository", repository,
      "--revision", revision, "--image", image, "--package-run", "42",
      "--azure-receipt", receipt, "--output", output];
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    execFileSync(process.execPath, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const bytes = await readFile(output, "utf8");
    const report = JSON.parse(bytes);
    assert.equal(report.deployment.sourceRevision, revision);
    assert.equal(report.status, "incomplete");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(!bytes.includes(secret));
    assert.throws(() => execFileSync(process.execPath, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      (error) => error.status === 1 && !error.stderr.includes(secret));
    assert.equal(await readFile(output, "utf8"), bytes);
    await writeFile(receipt, "x".repeat(1024 * 1024 + 1));
    assert.throws(() => execFileSync(process.execPath, args.slice(0, -1).concat(join(dir, "oversized.json")), {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }), (error) => error.status === 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("gh failures redact raw CLI diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cao-release-gh-"));
  try {
    await writeFile(join(dir, "gh"), `#!/bin/sh\nprintf '%s' '${secret}' >&2\nexit 1\n`, { mode: 0o700 });
    const path = process.env.PATH;
    process.env.PATH = dir;
    try { await assert.rejects(runGh(["api", "x"]), (error) => !error.message.includes(secret)); }
    finally { process.env.PATH = path; }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
