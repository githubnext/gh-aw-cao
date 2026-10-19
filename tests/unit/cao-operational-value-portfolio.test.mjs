import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowPortfolio } from "../../.github/skills/add-operational-value/scripts/portfolio-model.mjs";
import { readOutputHistory } from "../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { currentPortfolioInputs as loadPortfolioInputs, hostMeasurementReady, nativeGapReportReady, nativeReportReady, writeWorkflowPortfolio } from "../../scripts/build-gh-aw-value-portfolio.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { fileDietValueEvents } from "../../scripts/build-file-diet-value-events.mjs";
import { readLifetime } from "../../scripts/measure-file-diet-lifetime.mjs";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";

let retainedInputs;
const currentPortfolioInputs = () => (retainedInputs ??= loadPortfolioInputs());
const input = JSON.parse(readFileSync(new URL("../../docs/operational-value/proof/reports/file-diet-value-events.json", import.meta.url)));
const workflow = id => ({ id, path: `.github/workflows/${id}.md`, gitBlob: "a".repeat(40) });
const history = () => ({
  index: { complete: true, repository: "github/gh-aw", repositoryId: 9, sourceRevision: "b".repeat(40),
    until: "2026-10-18T15:00:12Z", workflows: ["daily-file-diet", "unmeasured", "unresolved", "changed"].map(workflow),
    startedAt: input.observedAt, completedAt: input.observedAt, totalEntities: 3, knownRunReferences: 1, limitations: [] },
  entities: [
    { id: "issue", number: 1, kind: "Issue", createdAt: "2026-01-01T00:00:00Z", relatedCandidates: [],
      workflowReference: { workflowId: "daily-file-diet", additionalRunReferences: [{ workflowId: "unmeasured" }] } },
    { id: "pull", number: 2, kind: "PullRequest", mergedAt: "2026-02-01T00:00:00Z", relatedCandidates: [1] },
    { id: "future-merge", number: 3, kind: "PullRequest", mergedAt: "2026-10-18T15:01:00Z", relatedCandidates: [1] },
  ],
});
const proposals = () => history().index.workflows.map(row => ({
  path: row.path, sourceGitBlob: row.id === "changed" ? "c".repeat(40) : row.gitBlob,
  goal: "Improve a native outcome", acceptance: "Independently verified", metricName: "Native quantity",
  formula: "count verified facts", unit: "files", direction: "decrease",
  designStatus: row.id === "unresolved" ? "unresolved" : "candidate", limitation: "Not causal attribution",
}));
const measurements = () => [{ workflowId: "daily-file-diet", input: structuredClone(input) }];

test("portfolio distinguishes real evaluations, missing instrumentation, unresolved goals and changed sources", () => {
  const model = workflowPortfolio(history(), proposals(), measurements());
  assert.deepEqual(model.totals, { workflows: 4, measured: 1, inProgress: 0, evidenceUnavailable: 0, needsInstrumentation: 1,
    needsOutcomeContract: 1, needsIntentReview: 1 });
  const diet = model.workflows[0];
  assert.equal(diet.measurement.model.metrics[0].observedTotal, 48);
  assert.equal(diet.discovery.mergedCandidates, 1);
  assert.equal(diet.discovery.relatedPullRequestCandidates, 2);
  assert.equal(diet.discovery.adoptionAt, null);
  assert.equal(model.workflows[1].discovery.markerLinkedOutputs, 0);
  assert.equal(model.workflows[1].measurement.signal, null);
  assert.equal(Object.hasOwn(model.totals, "value"), false);
});

test("in-progress native work is visible without being counted as a completed evaluation", () => {
  const progress = [{ workflowId: "unmeasured", sourceGitBlob: "a".repeat(40), stage: "linkage acquisition",
    functionReady: true, evidenceReady: true, evaluationReady: false, plotReady: false,
    detail: "Native evidence retained; downstream links still pending." }];
  const model = workflowPortfolio(history(), proposals(), measurements(), progress);
  assert.equal(model.totals.measured, 1);
  assert.equal(model.totals.inProgress, 1);
  assert.equal(model.workflows[1].measurement.status, "evaluation-in-progress");
  assert.equal(model.workflows[1].measurement.model, null);
  assert.equal(model.workflows[1].measurement.progress.functionReady, true);
  assert.throws(() => workflowPortfolio(history(), proposals(), [], [{ ...progress[0], sourceGitBlob: "f".repeat(40) }]), /progress/);
});

test("host proof acquisition cannot promote a missing, stale or all-unknown evaluation into coverage", () => {
  const index = { complete: true, proven: 1 };
  const sha = "a".repeat(64);
  const timeline = { valueFunction: { sha256: sha }, snapshots: [{
    metrics: { "observed-proofs": 1 },
    provenance: [{ kind: "native-host-assertion-index", ref: censusDigest(index) }],
  }] };
  assert.equal(hostMeasurementReady(index, timeline, sha), true);
  assert.equal(hostMeasurementReady(index, null, sha), false);
  assert.equal(hostMeasurementReady(index, timeline, "b".repeat(64)), false);
  assert.equal(hostMeasurementReady({ ...index, proven: 2 }, timeline, sha), false);
  assert.equal(hostMeasurementReady(index, { ...timeline,
    snapshots: [{ ...timeline.snapshots[0], metrics: { "observed-proofs": null } }] }, sha), false);
  assert.equal(nativeReportReady(index, { ...timeline,
    snapshots: [{ ...timeline.snapshots[0], metrics: { "observed-proofs": null } }] }, sha,
  "native-host-assertion-index"), true);
  assert.equal(nativeReportReady(index, { ...timeline, snapshots: [] }, sha, "native-host-assertion-index"), false);
});

test("assigning a workflow does not imply a function, evidence or native measurement exists", () => {
  const progress = [{ workflowId: "unmeasured", sourceGitBlob: "a".repeat(40),
    stage: "parallel workflow authoring", detail: "An isolated session owns this workflow.",
    functionReady: false, evidenceReady: false, evaluationReady: false, plotReady: false }];
  const model = workflowPortfolio(history(), proposals(), measurements(), progress);
  assert.equal(model.totals.measured, 1);
  assert.equal(model.totals.inProgress, 1);
  const assigned = model.workflows[1].measurement;
  assert.equal(assigned.status, "evaluation-in-progress");
  assert.equal(assigned.signal, null);
  assert.equal(assigned.model, null);
  assert.deepEqual(assigned.progress, progress[0]);
});

test("gap reports require frozen function/provenance bindings and explicitly unknown primary values", () => {
  const sha = "a".repeat(64), ref = "b".repeat(64), kind = "reviewed-source-index";
  const timeline = { valueFunction: { sha256: sha }, snapshots: [{
    metrics: { native: null }, provenance: [{ repository: "github/gh-aw", kind, ref }],
  }] };
  const ready = value => nativeGapReportReady(value, sha, "native", kind, ref);
  assert.equal(ready(timeline), true);
  assert.equal(ready({ ...timeline, snapshots: [] }), false);
  assert.equal(ready({ ...timeline, valueFunction: { sha256: ref } }), false);
  for (const metric of [undefined, 0, 1]) {
    const changed = structuredClone(timeline);
    changed.snapshots[0].metrics.native = metric;
    assert.equal(ready(changed), false);
  }
  for (const [field, value] of [["repository", "other/repo"], ["kind", "unreviewed"], ["ref", sha]]) {
    const changed = structuredClone(timeline);
    changed.snapshots[0].provenance[0][field] = value;
    assert.equal(ready(changed), false);
  }
});

test("an incomplete traversal or mismatched measurement cannot establish portfolio coverage", () => {
  const partial = history(); partial.index.complete = false;
  assert.throws(() => workflowPortfolio(partial, proposals()), /partial/);
  const wrong = measurements(); wrong[0].input.repository = "other/repository";
  assert.throws(() => workflowPortfolio(history(), proposals(), wrong), /scope/);
  const future = history(); future.index.until = "2026-10-01T00:00:00Z";
  assert.throws(() => workflowPortfolio(future, proposals(), measurements()), /cutoff/);
  assert.throws(() => workflowPortfolio(history(), proposals(), [...measurements(), ...measurements()]), /Duplicate/);
  const unsafe = history(); unsafe.index.workflows[0].id = "../escape";
  assert.throws(() => workflowPortfolio(unsafe, proposals()), /Invalid portfolio/);
});

test("old native values remain available without presenting a stale signal as current", () => {
  const old = history(); old.index.until = "2027-01-01T00:00:00Z";
  const measured = workflowPortfolio(old, proposals(), measurements()).workflows[0].measurement;
  assert.equal(measured.fresh, false);
  assert.equal(measured.signal.status, "insufficient-evidence");
  assert.equal(measured.signal.attention, "evidence-needed");
  assert.equal(measured.signal.current, null);
  assert.equal(measured.model.metrics[0].observedTotal, 48);
});

test("partitioned reports expose absent measurements without invented flat-zero plots", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "value-portfolio-"));
  try {
    const goals = proposals(); goals[1].goal = '<img src=x onerror="alert(1)">';
    const model = workflowPortfolio(history(), goals, measurements());
    writeWorkflowPortfolio(directory, model);
    const index = readFileSync(path.join(directory, "index.html"), "utf8");
    assert.match(index, /4 workflows inventoried; 1 have native evaluations/);
    assert.match(index, /workflows-001.html#unmeasured/);
    const details = readFileSync(path.join(directory, "workflows-001.html"), "utf8");
    assert.ok(!details.includes('<img src=x'));
    assert.match(details, /&lt;img/);
    assert.match(details, /No missing value is replaced with zero/);
    assert.ok(!readdirSync(directory).includes("unmeasured-pulse.html"));
    const meta = readCensusJson(path.join(directory, "portfolio.json.gz"));
    assert.match(meta.progressUpdatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok(index.includes(meta.progressUpdatedAt));
    for (const part of meta.partitions) assert.equal(
      censusDigest(readCensusJson(path.join(directory, part.file))), part.sha256);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the retained repository-wide proof replays coverage rather than promoting merges into value", async () => {
  const directory = path.resolve("docs/operational-value/gh-aw-workflows");
  const archived = readCensusJson(path.join(directory, "portfolio.json.gz"));
  const acquired = readOutputHistory(path.join(directory, "evidence"));
  const stored = archived.partitions.flatMap(part => {
    const rows = readCensusJson(path.join(directory, part.file));
    assert.equal(censusDigest(rows), part.sha256);
    assert.equal(rows.length, part.count);
    return rows;
  });

  const lifetime = readLifetime("docs/operational-value/proof/file-diet-lifetime");
  const replayedEvents = fileDietValueEvents(lifetime.proof, lifetime.inventories);
  assert.deepEqual(replayedEvents, input);
  const { measurements, progress } = await currentPortfolioInputs();
  for (const { workflowId, input: timeline } of measurements) {
    const definition = timeline.valueFunction?.definition;
    if (definition?.evidence.measurementKind !== "interval") continue;
    const scheduled = observationWindows(definition, timeline.window.startAt, timeline.window.endAt);
    const expected = timeline.reportKind === "same-source-retrospective-cutoff-reconstruction"
      ? scheduled.map(request => ({ ...request, observedAt: timeline.window.endAt }))
      : scheduled;
    assert.deepEqual(timeline.snapshots.map(snapshot => ({
      observedAt: snapshot.observedAt, windowStart: snapshot.window.startAt, windowEnd: snapshot.window.endAt,
    })), expected,
    `${workflowId}: active interval delivery cohorts must follow the disjoint production scheduler`);
  }
  assert.deepEqual(measurements.find(entry => entry.workflowId === "daily-file-diet").input, replayedEvents);
  const model = workflowPortfolio(acquired,
    readCensusJson("docs/operational-value/gh-aw-census/contracts.json.gz").contracts, measurements, progress);
  assert.deepEqual(model.workflows, stored);
  assert.equal(acquired.index.totalEntities, 58048);
  assert.equal(model.totals.workflows, 344);
  for (const id of ["daily-model-resolution", "daily-model-inventory",
    "daily-credit-limit-test", "daily-aw-cross-repo-compile-check", "avenger",
    "step-name-alignment", "workflow-normalizer", "cli-consistency-checker", "daily-syntax-error-quality",
    "artifacts-summary",
    "dependabot-burner", "dependabot-go-checker", "go-fan", "eslint-miner", "eslint-refiner", "linter-miner"]) {
    const row = model.workflows.find(workflow => workflow.id === id);
    assert.equal(row.measurement.status, "evaluation-in-progress");
    for (const key of ["functionReady", "evidenceReady", "evaluationReady", "plotReady"]) {
      assert.equal(row.measurement.progress[key], false);
    }
    assert.equal(row.measurement.model, null);
  }
  assert.equal(model.totals.measured, 61);
  assert.equal(model.totals.workflows - model.totals.measured, 283);
  assert.deepEqual(archived.totals, model.totals);
  const index = readFileSync(path.join(directory, "index.html"), "utf8");
  const percentage = (100 * model.totals.measured / model.totals.workflows).toFixed(1);
  assert.ok(index.includes(`${percentage}% native evaluation coverage: ${model.totals.measured} / ${model.totals.workflows} workflows.`));
  assert.ok(index.includes(`${model.totals.workflows - model.totals.measured} still lack a native evaluation.`));
  assert.ok(index.includes(`<progress max="${model.totals.workflows}" value="${model.totals.measured}"`));
  assert.equal(model.totals.needsInstrumentation + model.totals.needsOutcomeContract
    + model.totals.needsIntentReview + model.totals.inProgress + model.totals.evidenceUnavailable + model.totals.measured, 344);
  assert.equal(archived.historyIndexSha256, censusDigest(acquired.index));
});

test("portable cohort bootstraps preserve exact frozen intent bytes without claiming complete evidence", () => {
  const directory = "docs/operational-value/proof/cohort-inputs";
  for (const [cohort, expectedHash, workflows] of [
    ["go-dependency", "05f2735a796ac6c833ef39bbab254bc23999fd22782e792f53c9232b416b0b8e",
      ["dependabot-burner", "dependabot-go-checker", "go-fan"]],
    ["lint-rule", "abde598e90796f2a84cdc088960af9f1e3ea581e40cf394a453d5235d0c9fe85",
      ["eslint-miner", "eslint-refiner", "linter-miner"]],
  ]) {
    const file = path.join(directory, `${cohort}.json.gz`);
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), expectedHash);
    const bootstrap = readCensusJson(file);
    assert.equal(bootstrap.kind, "frozen-workflow-source-bootstrap");
    assert.equal(bootstrap.repository, "github/gh-aw");
    assert.equal(bootstrap.revision, "c86377ec47b38f0b5af463277ee55d1d03d08da8");
    assert.deepEqual(bootstrap.workflows, workflows);
    assert.equal(bootstrap.paths.length, workflows.length);
    assert.equal(bootstrap.objects.length, workflows.length);
    for (const workflowId of workflows) {
      const reference = bootstrap.paths.find(row => row.path === `.github/workflows/${workflowId}.md`);
      const object = bootstrap.objects.find(row => row.gitBlob === reference.gitBlob);
      const bytes = Buffer.from(object.contentBase64, "base64");
      assert.equal(bytes.length, object.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), object.sha256);
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), object.gitBlob);
      assert.ok(bootstrap.unresolved.some(row => row.path === `.github/workflows/${workflowId}.lock.yml`));
    }
    assert.match(bootstrap.authority, /not instructions, accepted outcomes, adoption or execution evidence/);
    assert.equal(bootstrap.origin.lazyFetch, false);
  }
});

test("Pydantic native Python read does not satisfy strict read_file or full goal, and CI gaps stay unmeasured", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  const pydantic = measurements.find(entry => entry.workflowId === "smoke-pydantic").input;
  assert.equal(pydantic.snapshots.length, 11);
  const latest = pydantic.snapshots.at(-1);
  assert.equal(latest.metrics["native-read-cases"], 0);
  assert.equal(latest.metrics["python-filesystem-read-cases"], 1);
  assert.equal(latest.metrics["linked-python-read-cases"], 1);
  for (const id of ["inference-cases", "mcp-cases", "transport-cases", "persisted-issues", "full-goal-cases"]) {
    assert.equal(latest.metrics[id], null);
  }
  assert.ok(pydantic.snapshots.slice(0, -1).every(snapshot =>
    Object.values(snapshot.metrics).every(value => value === null)));
  assert.equal(progress.find(row => row.workflowId === "smoke-pydantic").partial, true);
  assert.equal(measurements.some(row => row.workflowId === "smoke-ci"), false);
  const ci = progress.find(row => row.workflowId === "smoke-ci");
  assert.equal(ci.functionReady, true);
  assert.equal(ci.blocked, true);
  assert.equal(ci.reportAvailable, true);
  for (const key of ["evidenceReady", "evaluationReady", "plotReady"]) assert.equal(ci[key], false);
  assert.match(readFileSync("docs/operational-value/gh-aw-workflows/smoke-ci-pulse.html", "utf8"),
    /<!doctype html>/i);
});

test("documentation native partials preserve rejected predicates, historical gaps and scoped nonacceptance", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  for (const [workflowId, metric, expected, periods] of [
    ["designer-drift-audit", "factualRepairs", [12, 0], 20],
    ["daily-doc-healer", "factualRepairs", [2], 34],
    ["daily-doc-updater", "factualRepairs", [0, 1], 53],
    ["claude-code-user-docs-review", "native-improvements", [1], 39],
    ["developer-docs-consolidator", "native-improvements", [0], 50],
  ]) {
    const timeline = measurements.find(row => row.workflowId === workflowId).input;
    assert.equal(timeline.snapshots.length, periods);
    assert.deepEqual(timeline.snapshots.map(snapshot => snapshot.metrics[metric]).filter(value => value !== null), expected);
    const work = progress.find(row => row.workflowId === workflowId);
    assert.equal(work.partial, true);
    assert.equal(work.evaluationReady, true);
    const accuracy = metric === "factualRepairs";
    for (const snapshot of timeline.snapshots) {
      assert.equal(snapshot.metrics[accuracy ? "semanticAccepted" : "full-goal"], null);
      assert.equal(snapshot.metrics[accuracy ? "linkedRepairs" : "workflow-contribution"], null);
      if (accuracy) assert.ok(snapshot.metrics.referenceRepairs === null || snapshot.metrics.referenceRepairs === 0);
    }
    if (accuracy) assert.match(timeline.valueFunction.definition.assessment, /Outcome-informed retrospective/);
  }
  const claude = measurements.find(row => row.workflowId === "claude-code-user-docs-review").input;
  assert.equal(claude.snapshots.at(-1).metrics["native-improvements"], null);
  assert.equal(measurements.some(row => row.workflowId === "unbloat-docs"), false);
  const unbloat = progress.find(row => row.workflowId === "unbloat-docs");
  assert.equal(unbloat.blocked, true);
  assert.equal(unbloat.reportAvailable, true);
  for (const key of ["evidenceReady", "evaluationReady", "plotReady"]) assert.equal(unbloat[key], false);
});

test("positive partial native evaluations retain unknown completion and open-history labels", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  for (const [workflowId, primary, latest] of [
    ["smoke-test-tools", "observed-tool-proofs", 34],
    ["smoke-temporary-id", "resolved-references", 6],
    ["lockfile-stats", "verified-statistical-facts", 726],
    ["purelock", "observed-fully-covered", 1696],
    ["smoke-multi-pr", "verified-payload-deliveries", 4],
  ]) {
    const work = progress.find(row => row.workflowId === workflowId);
    const timeline = measurements.find(row => row.workflowId === workflowId)?.input;
    assert.ok(timeline, `${workflowId} requires a production-replayed native timeline`);
    assert.equal(work.partial, true);
    assert.equal(work.evaluationReady, true);
    assert.equal(timeline.snapshots.at(-1).metrics[primary], latest);
    if (workflowId === "lockfile-stats") {
      assert.equal(timeline.snapshots.at(-1).metrics["incorrect-statistical-facts"], 156);
      assert.match(work.detail, /Full workflow acceptance.*not established/);
    } else if (workflowId === "purelock") {
      assert.equal(timeline.snapshots.at(-1).metrics["observed-executed"], 2397);
      assert.match(work.detail, /uninstrumented pure functions remain null/);
    } else if (workflowId === "smoke-multi-pr") {
      assert.equal(timeline.snapshots.at(-1).metrics["verified-crlf-deliveries"], 2);
      assert.match(work.detail, /eligible denominator.*unknown/);
    } else {
      assert.ok(Object.values(timeline.snapshots.at(-1).metrics).includes(null),
        `${workflowId} must not convert unknown complete acceptance into zero or success`);
    }
    const acquired = history();
    acquired.index.workflows = [{ ...workflow(workflowId), gitBlob: work.sourceGitBlob }];
    const model = workflowPortfolio(acquired, [], [{ workflowId, input: timeline }], [work]);
    assert.equal(model.totals.measured, 1);
    assert.equal(model.workflows[0].measurement.progress.partial, true);
    assert.equal(model.workflows[0].measurement.signal.status, "insufficient-evidence");
  }
});

test("native Multi-PR cohorts retain all 44/21 deliveries without summing overlapping archived observations", () => {
  const directory = "docs/operational-value/proof/reports/github-gh-aw";
  const timeline = readCensusJson(`${directory}/smoke-multi-pr-timeline.json`);
  for (let index = 1; index < timeline.snapshots.length; index++) {
    assert.ok(timeline.snapshots[index - 1].window.endAt <= timeline.snapshots[index].window.startAt);
  }
  for (const [metric, expected] of [["verified-payload-deliveries", 44], ["verified-crlf-deliveries", 21]]) {
    assert.equal(timeline.snapshots.reduce((sum, snapshot) => sum + (snapshot.metrics[metric] ?? 0), 0), expected);
  }
  const archive = readCensusJson(`${directory}/smoke-multi-pr-evidence-archive.json.gz`);
  const originalIdentity = "0ba2ae5905c4dccf126c8728aa375fb7359b1b3f21bee5fda500b5a12124e6af";
  assert.notEqual(timeline.valueFunction.sha256, originalIdentity);
  assert.ok(archive.functions[originalIdentity].snapshots.some(snapshot =>
    snapshot.window.endAt === "2026-10-17T02:35:50Z"));
});

test("completed container acquisition preserves the exact immutable v2 predecessor", () => {
  const predecessor = readCensusJson("docs/operational-value/proof/smoke-test-tools/versions/pre-acquisition-completion-v2.json");
  const bytes = Buffer.from(predecessor.archive, "base64");
  assert.equal(bytes.length, predecessor.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "308d37505efe7399617562d6f4f1ffe0a9e29e652af37541c6ae17ec2832add9");
  const index = readCensusJson("docs/operational-value/proof/smoke-test-tools/index.json");
  assert.equal(index.acquisitionComplete, true);
  assert.equal(index.provenRunTools, 98);
});

test("disjoint interval migration preserves every exact original report and frozen function", () => {
  const closure = readCensusJson("docs/operational-value/proof/interval-schedule/pre-disjoint-resampling-v1.json");
  assert.equal(closure.contractsUnchanged.length, 17);
  assert.equal(closure.files.length, 85);
  assert.equal(new Set(closure.files.map(record => record.path)).size, 85);
  const directory = mkdtempSync(path.join(os.tmpdir(), "value-original-intervals-"));
  try {
    for (const record of closure.files) {
      const destination = path.resolve(directory, record.path);
      assert.ok(destination.startsWith(`${directory}${path.sep}`));
      const bytes = Buffer.from(record.base64, "base64");
      assert.equal(bytes.length, record.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    for (const contract of closure.contractsUnchanged) {
      assert.equal(censusDigest(readCensusJson(path.join(directory, contract.timelinePath))), contract.timelineDigest);
      assert.equal(createHash("sha256").update(readFileSync(contract.functionPath)).digest("hex"), contract.functionSha256);
      assert.equal(readCensusJson(contract.timelinePath).valueFunction.sha256, contract.functionSha256);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registered gap reports remain available without inflating native coverage", async () => {
  const progress = (await currentPortfolioInputs()).progress;
  for (const workflowId of ["smoke-workflow-call-with-inputs", "smoke-work-queue", "smoke-create-cross-repo-pr",
    "smoke-update-cross-repo-pr", "smoke-checkout-pr-dispatch", "daily-elixir-credo-snippet-audit"]) {
  const work = progress.find(row => row.workflowId === workflowId);
  assert.equal(work.reportAvailable, true);
  assert.equal(work.blocked, true);
  assert.equal(work.evaluationReady, false);
  const acquired = history();
  acquired.index.workflows = [{ ...workflow(work.workflowId), gitBlob: work.sourceGitBlob }];
  acquired.entities = [];
  const model = workflowPortfolio(acquired, [], [], [work]);
  assert.equal(model.totals.measured, 0);
  assert.equal(model.totals.evidenceUnavailable, 1);
  assert.equal(model.workflows[0].measurement.model, null);
  assert.equal(model.workflows[0].measurement.signal, null);
  const directory = mkdtempSync(path.join(os.tmpdir(), "value-gap-report-"));
  try {
    writeWorkflowPortfolio(directory, model);
    assert.ok(readFileSync(path.join(directory, "workflows-001.html"), "utf8").includes(
      `${workflowId}-pulse.html">Open evidence-gap plot and retained evidence`));
    assert.equal(readFileSync(path.join(directory, `${workflowId}-pulse.html`), "utf8"),
      readFileSync(work.reportPath ?? `docs/operational-value/proof/reports/github-gh-aw/${workflowId}-pulse.html`, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  }
});

test("pending native reports preserve provisional zeros and original diagnostics without claiming outcomes", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  for (const workflowId of ["blog-auditor", "weekly-editors-health-check", "daily-cli-performance",
    "daily-safe-outputs-conformance", "daily-observability-report", "daily-model-resolution"]) {
    assert.equal(measurements.some(row => row.workflowId === workflowId), false);
    const work = progress.find(row => row.workflowId === workflowId);
    assert.equal(work.functionReady, workflowId !== "daily-model-resolution");
    assert.equal(work.reportAvailable, true);
    for (const field of ["blocked", "evidenceReady", "evaluationReady", "plotReady"]) assert.equal(work[field], false);
    const acquired = history();
    acquired.index.workflows = [{ ...workflow(workflowId), gitBlob: work.sourceGitBlob }];
    acquired.entities = [];
    const model = workflowPortfolio(acquired, [], [], [work]);
    assert.equal(model.totals.measured, 0);
    assert.equal(model.totals.inProgress, 1);
    assert.equal(model.totals.evidenceUnavailable, 0);
    assert.equal(model.workflows[0].measurement.signal, null);
    const directory = mkdtempSync(path.join(os.tmpdir(), "value-pending-report-"));
    try {
      writeWorkflowPortfolio(directory, model);
      assert.equal(readFileSync(path.join(directory, `${workflowId}-pulse.html`), "utf8"),
        readFileSync(work.reportPath, "utf8"));
      if (work.diagnosticReportPath) {
        const diagnostic = path.join(directory, `${workflowId}-native-diagnostic.html`);
        assert.equal(readFileSync(diagnostic, "utf8"), readFileSync(work.diagnosticReportPath, "utf8"));
        assert.match(readFileSync(path.join(directory, "workflows-001.html"), "utf8"),
          /Open original diagnostic \(not accepted outcome value\)/);
        model.workflows[0].measurement.progress = { ...work, diagnosticReportPath: diagnostic };
        assert.throws(() => writeWorkflowPortfolio(directory, model), /workflow-owned/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const blog = readCensusJson("docs/operational-value/proof/blog-auditor/reports/github-gh-aw/blog-auditor-timeline.json");
  assert.ok(blog.snapshots.some(snapshot => snapshot.metrics["page-checks"] === 0));
  assert.ok(blog.snapshots.some(snapshot => snapshot.metrics["page-checks"] === null));
});

test("source corrections and unsupported producer schemas stay visible without admitting prospective reports", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  const expectedStages = new Map([
    ["daily-model-resolution", /independent child-to-proxy binding unavailable/],
    ["daily-model-inventory", /independent provider inventories missing/],
    ["daily-credit-limit-test", /predecessor trigger contract not admitted/],
    ["daily-aw-cross-repo-compile-check", /protected producer and cohort missing/],
    ["avenger", /original failure and landing proofs missing/],
    ["cli-consistency-checker", /runtime and full command acceptance missing/],
    ["workflow-normalizer", /protected production bindings missing/],
    ["daily-syntax-error-quality", /production originals unavailable/],
    ["step-name-alignment", /complete semantics and contribution missing/],
  ]);
  for (const [workflowId, stage] of expectedStages) {
    assert.equal(measurements.some(row => row.workflowId === workflowId), false);
    const work = progress.find(row => row.workflowId === workflowId);
    assert.match(work.stage, stage);
    for (const field of ["functionReady", "evidenceReady", "evaluationReady", "plotReady"]) {
      assert.equal(work[field], false, `${workflowId}: ${field}`);
    }
    if (["daily-credit-limit-test", "daily-aw-cross-repo-compile-check",
      "cli-consistency-checker", "workflow-normalizer"].includes(workflowId)) {
      assert.notEqual(work.reportAvailable, true);
      assert.equal(work.reportPath, undefined);
      assert.match(work.detail, /(?:after|follows) the frozen cutoff/);
    }
  }
  assert.match(progress.find(row => row.workflowId === "daily-credit-limit-test").detail, /bypasses every workflow_dispatch/);
  for (const workflowId of ["step-name-alignment", "daily-syntax-error-quality"]) {
    assert.equal(progress.find(row => row.workflowId === workflowId).reportAvailable, true);
  }
  assert.match(progress.find(row => row.workflowId === "step-name-alignment").detail, /not zero total workflow value/);
  assert.match(progress.find(row => row.workflowId === "cli-consistency-checker").detail, /22 of 22.*partial facet/);
});

test("changeset native structural delivery counts without fabricating latest value or semantic acceptance", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  const timeline = measurements.find(row => row.workflowId === "changeset").input;
  const work = progress.find(row => row.workflowId === "changeset");
  assert.equal(work.partial, true);
  assert.equal(work.functionReady, true);
  assert.equal(work.evaluationReady, true);
  assert.equal(timeline.window.endAt, "2026-10-18T15:00:12Z");
  assert.equal(timeline.snapshots.at(-2).metrics["release-readable"], 21);
  assert.equal(timeline.snapshots.at(-1).metrics["release-readable"], null);
  assert.ok(timeline.snapshots.every(snapshot => snapshot.evidence.fullGoal.value === null));
  assert.ok(timeline.snapshots.every(snapshot => snapshot.evidence.workflowContribution.value === null));
  assert.match(work.detail, /snapshot, not recurring delivery/);
});

test("SDK and explicit retrospective Redis native facts retain their different temporal contracts", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  const sdk = measurements.find(row => row.workflowId === "smoke-copilot-sdk").input;
  assert.equal(sdk.snapshots.length, 36);
  assert.equal(sdk.snapshots.filter(row => row.metrics["native-facets"] !== null).length, 1);
  assert.deepEqual(sdk.snapshots.at(-1).metrics, {
    "native-facets": 2, "file-effects": null, "cat-readbacks": 1, "bash-calculations": 1,
  });

  const redis = measurements.find(row => row.workflowId === "smoke-service-ports").input;
  assert.deepEqual(redis.snapshots.map(row => row.metrics["verified-redis-cases"]), [null, 3]);
  assert.equal(redis.snapshots.at(-1).metrics["host-bound-sessions"], 1);
  assert.equal(redis.snapshots.at(-1).metrics["workflow-contribution"], 3);
  const invocation = readCensusJson("docs/operational-value/proof/smoke-service-ports/frozen-standard-invocation.json");
  assert.equal(invocation.status, 1);
  assert.match(invocation.stderr, /evaluation end must follow/);
  assert.match(progress.find(row => row.workflowId === "smoke-service-ports").stage,
    /retrospective.*standard cutoff rejection preserved/);
  assert.match(progress.find(row => row.workflowId === "smoke-service-ports").reportPath,
    /retrospective-pulse\.html$/);
  for (const id of ["smoke-service-ports", "smoke-copilot-sdk"]) {
    const work = progress.find(row => row.workflowId === id);
    assert.equal(work.partial, true);
    assert.equal(work.evidenceReady, true);
    assert.equal(work.evaluationReady, true);
    assert.equal(work.plotReady, true);
  }
});

test("small-model arithmetic does not turn newline counts or pipeline exit into full acceptance", async () => {
  const { measurements } = await currentPortfolioInputs();
  const timeline = measurements.find(row => row.workflowId === "smoke-copilot-small").input;
  assert.equal(timeline.snapshots.length, 15);
  assert.deepEqual(timeline.snapshots.at(-1).metrics, {
    arithmetic: 1, readback: null, written: null, fullAcceptance: null,
  });
  assert.equal(timeline.snapshots.filter(row => row.metrics.arithmetic !== null).length, 1);
});

test("blocked drive attempts establish scoped zero without inventing persistence or a complete census", async () => {
  const { measurements, progress } = await currentPortfolioInputs();
  const timeline = measurements.find(row => row.workflowId === "smoke-drive").input;
  assert.equal(timeline.snapshots.length, 9);
  assert.deepEqual(timeline.snapshots.at(-1).metrics, {
    "same-run": 0, persistence: null, "repository-access": null, "full-goal": 0,
  });
  assert.equal(timeline.snapshots.at(-1).evidence.assessedAttemptCount, 2);
  assert.equal(timeline.snapshots.at(-1).evidence.coverageStatus, "partial");
  assert.equal(timeline.snapshots.filter(row => row.metrics["same-run"] !== null).length, 1);
  const work = progress.find(row => row.workflowId === "smoke-drive");
  assert.equal(work.partial, true);
  assert.match(work.detail, /not a complete execution census/);
});
