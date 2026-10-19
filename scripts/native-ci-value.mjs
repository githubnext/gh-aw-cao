import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { parseWorkflowReference, validateRunReference } from "../.github/skills/add-operational-value/scripts/github-lineage.mjs";
import { operationalValuePeriod } from "../.github/skills/add-operational-value/scripts/measurement-period.mjs";
import { treeEntries, validateCustody } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const root = new URL("../", import.meta.url);
const directory = new URL("docs/operational-value/proof/native-ci/", root);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const read = name => readJsonArchive(fileURLToPath(new URL(name, directory)));
let temporary, executable;

export function closeCiOracle() {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = executable = undefined;
}

const goEnvironment = () => ({ ...process.env, GOENV: "off", GOWORK: "off", GOFLAGS: "",
  GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off",
  GOCACHE: process.env.NATIVE_CI_GOCACHE ?? path.join(temporary, "cache"),
  GOPATH: path.join(temporary, "gopath") });

export function analyzeCiSources(inputs) {
  if (!executable) {
    temporary = mkdtempSync(path.join(tmpdir(), "cao-native-ci-"));
    process.once("exit", closeCiOracle);
    executable = path.join(temporary, "oracle");
    assert.match(execFileSync("go", ["version"], { env: goEnvironment(), encoding: "utf8" }),
      /^go version go1\.25\.3 /, "Native CI oracle requires Go 1.25.3");
    execFileSync("go", ["build", "-o", executable, fileURLToPath(new URL("oracle.go", directory))],
      { env: goEnvironment(), timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
  }
  return JSON.parse(execFileSync(executable, [], { input: JSON.stringify(inputs),
    maxBuffer: 64 * 1024 * 1024, timeout: 120000 }));
}

export function verifyFuzzTransition(before, after, files) {
  const job = text => {
    assert.equal([...text.matchAll(/^  fuzz:$/gm)].length, 1, "Ambiguous fuzz job");
    const block = text.match(/^  fuzz:\n[\s\S]*?(?=^  [a-zA-Z][\w-]*:)/m)?.[0];
    assert.ok(block, "Missing bounded fuzz job");
    assert.ok(block.includes("    if: github.ref == 'refs/heads/main'\n"));
    assert.ok(block.includes("    runs-on: ubuntu-latest\n"));
    assert.ok(block.includes("          run_fuzz_test() {\n"));
    assert.ok(block.includes('            local fuzz_name=$1\n'));
    assert.ok(block.includes('            local package=$2\n'));
    assert.ok(block.includes('if go test -run=\'^$\' -fuzz="${fuzz_name}" -fuzztime=10s "${package}" 2>&1 | tee "${output_file}"; then'));
    assert.ok(!/^defaults:/m.test(text) && !/^\s+(?:shell|continue-on-error):/m.test(block), "Unsupported shell or error handling");
    return block;
  };
  const calls = block => [...block.matchAll(/^          run_fuzz_test "(Fuzz\w+)" "(\.\/pkg\/(?:parser|workflow)\/)"\n/gm)]
    .map(match => ({ line: match[0], package: match[2], pattern: match[1] }));
  const oldCalls = calls(job(before)), newCalls = calls(job(after));
  const oldLines = new Set(oldCalls.map(row => row.line));
  assert.equal(oldLines.size, oldCalls.length, "Duplicate original selector");
  assert.equal(new Set(newCalls.map(row => row.line)).size, newCalls.length, "Duplicate new selector");
  const added = newCalls.filter(row => !oldLines.has(row.line));
  assert.ok(added.length > 0);
  let stripped = after;
  for (const row of added) stripped = stripped.replace(row.line, "");
  assert.equal(stripped, before, "Unexpected CI changes beyond additive selectors");
  const native = analyzeCiSources({ files, selections: [...oldCalls, ...newCalls].map(({ package: packagePath, pattern }) =>
    ({ package: packagePath, pattern })) });
  const oldSelections = native.selections.slice(0, oldCalls.length);
  const newSelections = native.selections.slice(oldCalls.length);
  const previouslyMatched = new Set(oldSelections.filter(row => row.matches.length === 1)
    .map(row => `${row.package}:${row.matches[0]}`));
  assert.ok(oldSelections.every(row => row.matches.length === 1), "Original fuzz sequence already has unresolved selection");
  const accepted = [], rejected = [];
  let blocked = false;
  for (const row of newSelections) {
    const addedHere = added.some(candidate => candidate.package === row.package && candidate.pattern === row.pattern);
    if (row.matches.length !== 1) blocked = true;
    if (!addedHere) continue;
    if (blocked) {
      rejected.push({ ...row, reason: row.matches.length !== 1 ? "ambiguous-or-missing-selector" : "after-failing-selector" });
      continue;
    }
    const identity = `${row.package}:${row.matches[0]}`;
    assert.equal(previouslyMatched.has(identity), false, "New invocation duplicates existing target selection");
    const target = native.targets.find(candidate => "./" + path.posix.dirname(candidate.path) + "/" === row.package
      && candidate.name === row.matches[0]);
    assert.equal(target?.fuzzBody, true, "Missing native Fuzz body");
    accepted.push({ identity, path: target.path, name: target.name });
  }
  assert.equal(new Set(accepted.map(row => row.identity)).size, accepted.length);
  return { nativeSubtotal: accepted.length, accepted, rejected, parsedFiles: native.parsedFiles,
    excludedFiles: native.excludedFiles, nativeTargets: native.targets.length,
    originalInvocations: oldCalls.length, newInvocations: newCalls.length, targetCodeExecuted: false };
}

export function assessCiEvidence() {
  const contractBytes = readFileSync(new URL("frozen-contract-v1.json", directory));
  const contract = JSON.parse(contractBytes), partial = read("frozen-contract-v2.json"), index = read("index.json.gz");
  assert.equal(index.contractSha256, hash(contractBytes));
  const originals = {};
  for (const [label, receipt] of Object.entries(index.receipts)) {
    assert.match(receipt.file, /^originals\/[a-z0-9-]+\.json\.gz$/);
    const filename = new URL(receipt.file, directory);
    assert.equal(hash(readFileSync(filename)), receipt.archiveSha256, `Archive changed: ${label}`);
    const packet = read(receipt.file);
    assert.equal(hash(packet.body), receipt.bodySha256, `Original changed: ${label}`);
    assert.equal(packet.sha256, receipt.bodySha256);
    originals[label] = JSON.parse(packet.body);
  }
  assert.equal(originals.repository.id, contract.repositoryId);
  assert.equal(originals.repository.full_name, contract.repository);
  assert.equal(originals.repository.private, false);
  assert.equal(originals.source.sha, contract.sourceBlob);
  const selection = partial.selection, repair = originals[`merge-${selection.pull}`];
  assert.equal(repair.sha, selection.commit);
  assert.deepEqual(repair.parents.map(row => row.sha), [selection.parent]);
  assert.equal(repair.commit.committer.date, selection.deliveryAt);
  assert.deepEqual(repair.files.map(row => row.filename), [selection.path]);
  const comparison = originals["fuzz-repair-to-bound"];
  assert.equal(comparison.base_commit.sha, selection.commit);
  assert.equal(comparison.merge_base_commit.sha, selection.commit);
  assert.ok(["ahead", "identical"].includes(comparison.status));
  const { data, originals: gitObjects } = read("native-sources.json.gz");
  assert.equal(data.contractSha256, hash(contractBytes));
  const custody = validateCustody(data, gitObjects);
  const objects = new Map(gitObjects.map(row => [row.id, Buffer.from(row.contentBase64, "base64")]));
  for (const inventory of data.inventories) {
    const commit = objects.get(inventory.commit).toString();
    const rootTree = commit.match(/^tree ([a-f0-9]{40})$/m)?.[1];
    const rootEntries = treeEntries(objects.get(rootTree));
    const pkg = treeEntries(objects.get(rootEntries.get("pkg").id));
    const complete = partial.selection.sourcePackages.flatMap(packagePath => {
      const entries = treeEntries(objects.get(pkg.get(packagePath.split("/")[1]).id));
      return [...entries].filter(([name]) => name.endsWith("_test.go"))
        .map(([name, row]) => ({ path: `${packagePath}/${name}`, blob: row.id }));
    }).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual([...inventory.tests].sort((a, b) => a.path.localeCompare(b.path)), complete,
      "Incomplete native package inventory");
    assert.equal(complete.length, selection.expectedInventoryFilesPerEndpoint);
  }
  assert.deepEqual(data.inventories.map(row => row.commit), [selection.parent, selection.commit]);
  assert.deepEqual(data.inventories[0].tests, data.inventories[1].tests);
  assert.equal(custody.source(selection.parent, "go.mod"), custody.source(selection.commit, "go.mod"));
  assert.match(custody.source(selection.parent, "go.mod"), /^go 1\.25\.0$/m);
  const files = Object.fromEntries(data.inventories[0].tests.map(row => [row.path, custody.source(selection.parent, row.path)]));
  const transition = verifyFuzzTransition(custody.source(selection.parent, selection.path),
    custody.source(selection.commit, selection.path), files);
  const witness = spawnSync("go", ["-C", fileURLToPath(new URL("witness/", directory)), "test",
    "-run=^$", "-fuzz=FuzzParseInputDefinition", "-fuzztime=1x"],
  { env: goEnvironment(), encoding: "utf8", timeout: 120000 });
  if (witness.error) throw witness.error;
  assert.equal(witness.status, 1, "Go witness did not reject ambiguous selector");
  const witnessOutput = witness.stdout + witness.stderr;
  assert.match(witnessOutput, /-fuzz matches more than one fuzz test: \[FuzzParseInputDefinition FuzzParseInputDefinitions\]/);
  assert.equal(witnessOutput.includes("context deadline exceeded"), false);
  const pull = originals[`pull-${selection.pull}`];
  const reference = parseWorkflowReference(pull.body, contract.repository);
  assert.equal(reference.workflowId, contract.workflow);
  const runBinding = validateRunReference(reference, originals["fuzz-reporting-run"],
    contract.adoption.sourcePath, contract.repository);
  assert.ok(runBinding.createdAt < selection.deliveryAt);
  assert.ok(Buffer.from(originals["fuzz-reporting-source"].content, "base64").toString().includes("Fuzz"));
  return { schemaVersion: 1, workflow: contract.workflow, metricId: partial.nativePartial.id,
    ...transition, deliveryAt: selection.deliveryAt, caseIdentity: partial.nativePartial.caseIdentity,
    authoring: partial.authoring,
    contribution: { status: "corroborated-shared", receiptVerified: null, causal: null },
    runBinding, ambiguousSelectorWitness: { independentlyAuthored: true, exitCode: witness.status,
      targetCodeExecuted: false,
      diagnostic: witnessOutput.match(/^testing: will not fuzz, -fuzz matches more than one fuzz test: .+$/m)[0] },
    originalResponses: Object.keys(index.receipts).length, selectedRoots: index.graphs.length,
    discoveredPulls: index.pulls.length, fullAcceptance: null, safeguards: null, costs: null, decision: "not-rated" };
}

export function nativeCiModule(pins) {
  for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(hash(readFileSync(new URL(relative, root))), expected, `Dependency changed: ${relative}`);
  }
  const contract = read("frozen-contract-v1.json"), partial = read("frozen-contract-v2.json");
  const index = read("index.json.gz");
  const baseline = JSON.parse(read(index.receipts.baseline.file).body);
  assert.equal(baseline.sha, contract.adoption.parent);
  const assessment = assessCiEvidence();
  const metric = { id: partial.nativePartial.id, name: "Unambiguous fuzz targets restored", role: "primary",
    formula: partial.nativePartial.formula, direction: "increase", unit: partial.nativePartial.unit,
    presentation: { name: "Unambiguous fuzz targets restored", legendLabel: "Fuzz targets restored", transform: "identity" } };
  const definition = {
    schemaVersion: 3, slug: contract.workflow, repository: contract.repository, workflowName: "CI Optimization Coach",
    sourcePath: contract.adoption.sourcePath,
    intent: { goal: contract.goal, acceptance: contract.fullAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: { commit: contract.adoption.commit, adoptedAt: contract.adoption.adoptedAt,
      baselineCommit: contract.adoption.parent, baselineAt: baseline.commit.committer.date },
    evaluation: { mode: "attainment-only" },
    evidence: { key: "ci-native-fuzz-selection-v2", repositories: [contract.repository],
      opportunity: "Existing native Go fuzz targets omitted from the main-branch fuzz-mode selector",
      filters: ["Actual-parent additive CI-only transition", "Complete Git-bound native test inventory",
        "Go AST, build eligibility and native regexp matching", "Exclude ambiguous and later blocked invocations"],
      collection: "Bounded original API packets and Git objects; native source oracle and independently authored Go witness; no target execution",
      measurementKind: "interval", window: contract.periods },
    model: { architecture: "Acquire once, independently verify source-defined conditional coverage and allocate each delivery once",
      recommendation: "Not rated; actual fuzz execution, complete CI integrity, elapsed-time improvement, costs and keep threshold remain unknown",
      presentation: { label: partial.nativePartial.unit, betterLabel: "More independently verified conditional fuzz-target coverage" } },
    summary: { nativeLabel: partial.nativePartial.unit }, metrics: [metric],
    validationExamples: { targetAttained: { schemaVersion: 1, native: 9 }, targetMissed: { schemaVersion: 1, native: 0 },
      missing: {}, malformed: { schemaVersion: 1, native: -1 } },
    originalAcceptance: contract.partials, fullAcceptance: contract.fullAcceptance,
    limitations: [...contract.separateUnknowns, ...partial.rejectedClaims],
    assessmentPolicy: partial.authoring, nativeAssessment: assessment, dependencyIdentity: pins,
    frozenSource: { revision: contract.revision, sourceBlob: contract.sourceBlob, cutoff: contract.cutoff },
  };
  return {
    definition,
    collectBatch(requests) {
      assert.ok(Array.isArray(requests));
      const normalized = requests.map(request => {
        assert.ok(request.repository === undefined || request.repository.toLowerCase() === contract.repository,
          "Repository escaped frozen scope");
        assert.ok(typeof request.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(request.observedAt)
          && Number.isFinite(Date.parse(request.observedAt))
          && new Date(request.observedAt).toISOString() === request.observedAt.replace("Z", ".000Z"), "Invalid observation timestamp");
        const period = operationalValuePeriod({ ...request, measurementKind: "interval", coverageStatus: "partial" },
          request.observedAt, "CI request");
        assert.ok(Date.parse(period.windowEnd) <= Date.parse(contract.cutoff), "Period escaped frozen cutoff");
        return period;
      });
      const ordered = [...normalized].sort((a, b) => a.windowStart.localeCompare(b.windowStart));
      assert.ok(!ordered.some((row, position) => position > 0 && ordered[position - 1].windowEnd > row.windowStart),
        "Overlapping delivery periods");
      return normalized.map(period => {
        const delivered = Date.parse(assessment.deliveryAt) >= Date.parse(period.windowStart)
          && Date.parse(assessment.deliveryAt) < Date.parse(period.windowEnd);
        return { commit: contract.revision, evidence: { schemaVersion: 1,
          native: delivered ? assessment.nativeSubtotal : null,
          identities: delivered ? assessment.accepted.map(row => row.identity) : [],
          interpretation: partial.nativePartial.interpretation, rejected: delivered ? assessment.rejected : [],
          originalStrictAcceptance: null, fullAcceptance: null, safeguards: null,
          contribution: delivered ? assessment.contribution : null, costs: null },
        provenance: [{ repository: contract.repository, kind: "git-commit",
          ref: `https://github.com/${contract.repository}/commit/${partial.selection.commit}` }] };
      });
    },
    scoreMetric(id, evidence) {
      assert.equal(id, metric.id, "Unknown metric");
      return evidence?.schemaVersion === 1 && Number.isSafeInteger(evidence.native) && evidence.native >= 0
        ? evidence.native : null;
    },
  };
}
