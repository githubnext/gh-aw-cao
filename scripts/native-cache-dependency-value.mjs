import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { operationalValuePeriod } from "../.github/skills/add-operational-value/scripts/measurement-period.mjs";
import { validateCustody } from "../docs/operational-value/proof/native-go-quality/custody.mjs";
import { cacheStrategyFacts } from "./native-cache-strategy-value.mjs";

const directory = new URL("../docs/operational-value/proof/native-cache-strategy/", import.meta.url);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => readJsonArchive(fileURLToPath(new URL(file, directory)));
let temporary, executable;

export function cacheYamlIdentity() {
  const filename = createRequire(import.meta.url).resolve("yaml/package.json"), home = path.dirname(filename);
  const metadata = JSON.parse(readFileSync(filename));
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(path.join(home, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push([file, hash(readFileSync(path.join(home, file)))]);
      else throw new Error("Unexpected YAML parser dependency entry");
    }
  };
  walk("dist");
  files.push(["package.json", hash(readFileSync(filename))]);
  files.sort(([left], [right]) => left.localeCompare(right, "en"));
  return { version: metadata.version, sha256: hash(JSON.stringify(files)), files: files.length };
}

export function closeCacheOracle() {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = executable = undefined;
}

export function analyzeCacheCompiler(before, after) {
  if (!executable) {
    temporary = mkdtempSync(path.join(tmpdir(), "cao-cache-oracle-"));
    process.once("exit", closeCacheOracle);
    executable = path.join(temporary, "oracle");
    const env = { ...process.env, GOENV: "off", GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local",
      GOPROXY: "off", GOSUMDB: "off", GOCACHE: path.join(temporary, "gocache"), GOPATH: path.join(temporary, "gopath") };
    assert.match(execFileSync("go", ["version"], { env, encoding: "utf8" }), /^go version go1\.25\.3 /);
    execFileSync("go", ["build", "-o", executable, fileURLToPath(new URL("oracle.go", directory))],
      { env, timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
  }
  return JSON.parse(execFileSync(executable, [], { input: JSON.stringify({ Before: before, After: after }),
    timeout: 30000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));
}

const oldCondition = "always() && needs.agent.result != 'skipped' && (needs.agent.outputs.output_types != '' || needs.agent.outputs.has_patch == 'true')";
const newCondition = "always() && needs.agent.result != 'skipped'";
const saveCondition = "always() && needs.detection.result == 'success' && needs.agent.result == 'success'";

export function verifyCacheDependencyWitness(sourceBefore, sourceAfter, before, after) {
  assert.equal(sourceBefore, sourceAfter, "Production source changed");
  assert.equal(cacheStrategyFacts(sourceBefore, before).eligible, true);
  const decode = text => {
    const document = parseDocument(text, { uniqueKeys: true, version: "1.2" });
    assert.equal(document.errors.length, 0);
    return document.toJS({ maxAliasCount: 0 });
  };
  const old = decode(before), next = decode(after);
  assert.equal(old.jobs.detection.if.trim(), oldCondition);
  assert.equal(next.jobs.detection.if.trim(), newCondition);
  const oldJob = structuredClone(old.jobs.detection), nextJob = structuredClone(next.jobs.detection);
  delete oldJob.if;
  delete nextJob.if;
  assert.deepEqual(oldJob, nextJob, "Other detection behavior changed");
  assert.deepEqual(old.jobs.update_cache_memory, next.jobs.update_cache_memory, "Cache consumer changed");
  const save = next.jobs.update_cache_memory;
  assert.equal(save.if.trim(), saveCondition);
  assert.ok(save.needs.includes("agent") && save.needs.includes("detection"));
  const actualSave = save.steps.filter(step => step.uses?.startsWith("actions/cache/save@"));
  assert.equal(actualSave.length, 1);
  assert.match(actualSave[0].uses, /^actions\/cache\/save@[a-f0-9]{40}$/);
  assert.equal(actualSave[0].with.path, "/tmp/gh-aw/cache-memory");
  assert.equal(actualSave[0].if, "steps.check_cache_default.outputs.has_content == 'true'");
  const cases = [];
  for (const result of ["success", "failure", "skipped"]) {
    for (const outputTypes of ["", "create_issue"]) {
      for (const hasPatch of [false, true]) {
        const beforeEligible = result !== "skipped" && (outputTypes !== "" || hasPatch);
        const afterEligible = result !== "skipped";
        cases.push({ agentResult: result, outputTypes, hasPatch, beforeEligible, afterEligible,
          conditionalCacheSaveBefore: beforeEligible && result === "success",
          conditionalCacheSaveAfter: afterEligible && result === "success" });
      }
    }
  }
  const restored = cases.filter(row => !row.conditionalCacheSaveBefore && row.conditionalCacheSaveAfter);
  assert.equal(restored.length, 1);
  return { cases, restored, guardrails: "Agent success, detection success and nonempty-cache guard unchanged.",
    interpretation: "Eligibility only, conditioned on successful dependency completion and available cache content." };
}

export function assessCacheDependency(pins) {
  assert.deepEqual(cacheYamlIdentity(), pins.yaml, "Native YAML parser closure changed");
  for (const [file, expected] of Object.entries(pins.files)) {
    assert.equal(hash(readFileSync(new URL(`../${file}`, import.meta.url))), expected, `Dependency changed: ${file}`);
  }
  const index = read("index.json.gz"), custody = read("custody.json.gz");
  assert.equal(hash(readFileSync(new URL("index.json.gz", directory))), pins.indexSha256);
  assert.equal(hash(readFileSync(new URL("custody.json.gz", directory))), pins.custodySha256);
  const contract = read("frozen-contract-v1.json"), partial = read("frozen-contract-v2.json");
  assert.equal(index.contractSha256, hash(readFileSync(new URL("frozen-contract-v1.json", directory))));
  const originals = {};
  for (const [label, receipt] of Object.entries(index.receipts)) {
    const bytes = readFileSync(new URL(receipt.file, directory));
    assert.equal(hash(bytes), receipt.archiveSha256, `Archive changed: ${label}`);
    const packet = read(receipt.file);
    assert.equal(hash(packet.body), receipt.bodySha256);
    assert.equal(packet.sha256, receipt.bodySha256);
    originals[label] = JSON.parse(packet.body);
  }
  assert.equal(originals.repository.id, contract.repositoryId);
  assert.equal(originals.repository.full_name, contract.repository);
  assert.equal(originals.repository.private, false);
  assert.equal(originals.repository.visibility, "public");
  assert.equal(index.revision, contract.revision);
  assert.equal(index.cutoff, contract.cutoff);
  const objects = custody.objects.map(entry => {
    const bytes = readFileSync(new URL(entry.file, directory));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(hash(bytes), entry.sha256);
    return read(entry.file);
  });
  const retained = validateCustody(custody, objects);
  const transition = partial.selectedTransition;
  assert.equal(retained.commit(transition.after).parents[0], transition.before);
  const pull = index.pulls.find(row => row.number === transition.pull);
  assert.equal(pull.actualParent, transition.before);
  assert.equal(pull.mergeCommit, transition.after);
  assert.equal(pull.mergedAt, transition.deliveredAt);
  const source = (phase, file) => retained.source(transition[phase], file);
  const native = analyzeCacheCompiler(source("before", transition.nativeSource), source("after", transition.nativeSource));
  assert.equal(native.nativeUnits, 1);
  const witness = verifyCacheDependencyWitness(source("before", transition.productionWitness),
    source("after", transition.productionWitness), source("before", transition.compiledWitness),
    source("after", transition.compiledWitness));
  return { schemaVersion: 1, workflow: contract.workflow, metric: partial.metric.id,
    nativeUnits: native.nativeUnits, event: { id: `${transition.after}:cache-save-content-gate`,
      at: transition.deliveredAt, commit: transition.after },
    native, witness, discovery: { roots: index.roots, candidates: index.pulls.length,
      completeGraphs: index.graphs.every(row => row.complete !== false) },
    qualification: "One outcome-informed conditional structural compiler repair; not cache execution or full acceptance.",
    fullGoalAcceptance: null, workflowContribution: null, costs: "not-measured", decision: "not-rated" };
}

export function cacheDependencyModule(pins) {
  const assessment = assessCacheDependency(pins), contract = read("frozen-contract-v1.json");
  const partial = read("frozen-contract-v2.json"), metric = {
    id: partial.metric.id, name: "Conditional cache dependency repairs", role: "primary",
    formula: "Count distinct independently AST-verified compiler content-gate removals with an unchanged production cache consumer, once at actual delivery.",
    direction: "increase", unit: partial.metric.unit,
    presentation: { name: "Conditional cache dependency repairs", legendLabel: "Dependency repairs", transform: "identity" },
  };
  const definition = {
    schemaVersion: 3, slug: contract.workflow, repository: contract.repository,
    workflowName: "Daily Cache Strategy Analyzer", sourcePath: contract.adoption.sourcePath,
    intent: { goal: contract.goal, acceptance: partial.metric.interpretation, temporalAnchor: "workflow-adoption" },
    adoption: { commit: contract.adoption.commit, adoptedAt: contract.adoption.adoptedAt,
      baselineCommit: contract.adoption.parent, baselineAt: contract.adoption.baselineAt },
    evaluation: { mode: "attainment-only",
      reason: "Only independently established delivered structural repairs are allocated. This does not assert exhausted baseline reconstruction or a problem created at adoption." },
    evidence: { key: "native-cache-dependency-v2", repositories: [contract.repository],
      opportunity: "Content-gated detection dependencies of successful cache-memory agents",
      filters: partial.metric.acceptance, collection: "Preserved public originals and complete selected Git commit/tree/blob custody; own native Go AST oracle; no target execution.",
      measurementKind: "interval", window: contract.window },
    model: { architecture: "One compiler repair, not every generated workflow or possible agent outcome",
      recommendation: "Not rated: actual cache persistence, hits, recomputation, costs and full acceptance remain unknown.",
      presentation: { label: "Conditional cache dependency repairs", betterLabel: "More independently repaired dependency gates" } },
    summary: { nativeLabel: partial.metric.unit }, metrics: [metric],
    validationExamples: { targetAttained: { schemaVersion: 1, native: 1 }, targetMissed: { schemaVersion: 1, native: 0 },
      missing: {}, malformed: { schemaVersion: 1, native: -1 } },
    assessmentPolicy: partial.authoring, nativeAssessment: assessment, dependencyIdentity: pins,
    originalAcceptance: contract.partialAcceptance, fullAcceptance: partial.fullGoalAcceptance,
    frozenSource: { revision: contract.revision, sourceBlob: contract.sourceBlob, cutoff: contract.cutoff },
    limitations: [...partial.sourceCorrections, partial.metric.interpretation],
  };
  return {
    definition,
    collectBatch(requests) {
      assert.ok(Array.isArray(requests));
      const periods = requests.map(request => {
        assert.ok(request.repository === undefined || request.repository.toLowerCase() === contract.repository, "Wrong repository");
        assert.ok(typeof request.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(request.observedAt)
          && Number.isFinite(Date.parse(request.observedAt))
          && new Date(request.observedAt).toISOString() === request.observedAt.replace("Z", ".000Z"),
        "Invalid cache observation timestamp");
        const period = operationalValuePeriod({ ...request, measurementKind: "interval", coverageStatus: "partial" },
          request.observedAt, "Cache dependency");
        assert.ok(Date.parse(period.windowEnd) <= Date.parse(contract.cutoff), "Cache observation exceeds frozen cutoff");
        return period;
      });
      const ordered = [...periods].sort((left, right) => left.windowStart.localeCompare(right.windowStart));
      assert.ok(ordered.every((period, index) => index === 0 || ordered[index - 1].windowEnd <= period.windowStart),
        "Overlapping cache delivery periods");
      return periods.map(period => {
        const delivered = Date.parse(period.windowStart) <= Date.parse(assessment.event.at)
          && Date.parse(assessment.event.at) < Date.parse(period.windowEnd);
        return { commit: contract.revision,
          evidence: { schemaVersion: 1, native: delivered ? assessment.nativeUnits : null,
            identities: delivered ? [assessment.event.id] : [], originalAcceptance: null,
            fullGoalAcceptance: null, workflowContribution: null, costs: null,
            interpretation: partial.metric.interpretation },
          provenance: [{ repository: contract.repository, kind: "git-commit",
            ref: `https://github.com/${contract.repository}/commit/${assessment.event.commit}` }] };
      });
    },
    scoreMetric(id, evidence) {
      assert.equal(id, metric.id, "Unknown cache metric");
      return evidence?.schemaVersion === 1 && Number.isSafeInteger(evidence.native) && evidence.native >= 0 && evidence.native <= 1
        ? evidence.native : null;
    },
  };
}
