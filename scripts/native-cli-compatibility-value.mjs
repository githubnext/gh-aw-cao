import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { parseWorkflowReference, validateRunReference } from "../.github/skills/add-operational-value/scripts/github-lineage.mjs";

const root = new URL("../", import.meta.url);
const directory = new URL("docs/operational-value/proof/cli-compatibility/", root);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let executable;
let temporary;

export function closeOracle() {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  executable = undefined;
  temporary = undefined;
}

export function analyzeMigrationSources(inputs) {
  if (!executable) {
    temporary = mkdtempSync(path.join(tmpdir(), "cao-cli-compatibility-"));
    process.once("exit", closeOracle);
    executable = path.join(temporary, "oracle");
    const version = execFileSync("go", ["version"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" } }).trim();
    assert.match(version, /^go version go1\.25\.3 /, "Native oracle requires pinned Go 1.25.3");
    execFileSync("go", ["build", "-o", executable, fileURLToPath(new URL("oracle.go", directory))], {
      env: { ...process.env, GOENV: "off", GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local",
        GOPROXY: "off", GOSUMDB: "off", GOPATH: path.join(temporary, "gopath"),
        GOCACHE: process.env.CLI_COMPATIBILITY_GOCACHE ?? path.join(temporary, "cache") },
      stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
    });
  }
  return JSON.parse(execFileSync(executable, [], {
    input: JSON.stringify(inputs), timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  }));
}

const canonical = text => text.replace(/\s+/g, " ").trim();

export function verifyMigrationTransition(before, after, patterns) {
  const oldDetection = before.hasDeprecatedAppField, newDetection = after.hasDeprecatedAppField;
  const oldRewrite = before.renameAppToGitHubApp, newRewrite = after.renameAppToGitHubApp;
  assert.ok(oldDetection && newDetection && oldRewrite && newRewrite, "Missing migration function");
  assert.equal(oldDetection.statements.length, 4, "Unexpected pre-repair detection shape");
  for (const [position, prefix] of [
    'if toolsAny, hasTools := frontmatter["tools"]; hasTools',
    'if soAny, hasSO := frontmatter["safe-outputs"]; hasSO',
    'if checkoutAny, hasCheckout := frontmatter["checkout"]; hasCheckout',
  ].entries()) assert.ok(canonical(oldDetection.statements[position]).startsWith(prefix), "Existing detection is not nested-only");
  assert.equal(oldDetection.statements.at(-1), "return false");
  assert.equal(newDetection.statements.length, oldDetection.statements.length + 1, "Unexpected detection changes");
  assert.equal(canonical(newDetection.statements[0]), canonical(patterns.detection), "Wrong top-level detection guard");
  assert.deepEqual(newDetection.statements.slice(1), oldDetection.statements, "Nested detection changed");
  assert.deepEqual(newRewrite.outside, oldRewrite.outside, "Rewriter setup or return changed");
  const added = newRewrite.range.filter(statement => canonical(statement) === canonical(patterns.rewrite));
  assert.equal(added.length, 1, "Missing exact top-level replacement and continuation");
  assert.deepEqual(newRewrite.range.filter(statement => statement !== added[0]), oldRewrite.range,
    "Unexpected rewriter changes beyond the top-level guard");
  assert.equal(before.getGitHubAppCodemod.apply, after.getGitHubAppCodemod.apply, "Production Apply closure changed");
  assert.ok(after.getGitHubAppCodemod.apply.includes("applyFrontmatterLineTransform(content, renameAppToGitHubApp)"),
    "Migration does not use production frontmatter transform");
  return { verified: true, nativeSubtotal: 1 };
}

export function assessCompatibilityEvidence() {
  const contractFile = new URL("frozen-contract-v1.json", directory);
  const contract = JSON.parse(readFileSync(contractFile));
  const partial = JSON.parse(readFileSync(new URL("frozen-contract-v2.json", directory)));
  const index = readJsonArchive(fileURLToPath(new URL("index.json.gz", directory)));
  assert.equal(index.contractSha256, hash(readFileSync(contractFile)));
  const originals = {};
  const endpoints = {};
  for (const [label, receipt] of Object.entries(index.receipts)) {
    assert.match(receipt.file, /^originals\/[a-z0-9-]+\.json\.gz$/);
    const file = new URL(receipt.file, directory);
    assert.equal(hash(readFileSync(file)), receipt.archiveSha256, `Archive changed: ${label}`);
    const packet = readJsonArchive(fileURLToPath(file));
    assert.equal(hash(packet.body), receipt.bodySha256, `Original changed: ${label}`);
    assert.equal(packet.sha256, receipt.bodySha256);
    originals[label] = JSON.parse(packet.body);
    endpoints[label] = packet.endpoint;
  }
  assert.equal(originals.repository.id, contract.repositoryId);
  assert.equal(originals.repository.full_name, contract.repository);
  assert.equal(originals.repository.private, false);
  assert.equal(originals.source.sha, contract.sourceBlob);
  const text = label => {
    const blob = originals[label];
    assert.equal(blob.encoding, "base64");
    const bytes = Buffer.from(blob.content, "base64");
    assert.equal(bytes.length, blob.size);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob.sha);
    return bytes.toString("utf8");
  };
  const repair = originals["merge-42794"];
  assert.equal(repair.sha, "7bc15e21c80d251de946b34e2798afe58fcfaf62");
  assert.deepEqual(repair.parents.map(parent => parent.sha), ["375b4ea31602a598069772db17f7673e9e7b9517"]);
  assert.equal(repair.commit.committer.date, "2026-07-01T18:10:03Z");
  assert.equal(originals["repair-to-bound"].base_commit.sha, repair.sha);
  assert.equal(originals["repair-to-bound"].merge_base_commit.sha, repair.sha, "Repair is not an ancestor of the bound source");
  assert.ok(["ahead", "identical"].includes(originals["repair-to-bound"].status));
  assert.equal(originals["pull-42794"].base.repo.id, contract.repositoryId);
  assert.equal(originals["pull-42794"].merge_commit_sha, repair.sha);
  const input = [];
  for (const [position, file] of index.nativeCandidate.sourcePaths.entries()) {
    for (const side of ["before", "after"]) {
      const revision = side === "before" ? repair.parents[0].sha : repair.sha;
      assert.equal(endpoints[`native-${side}-${position}`],
        `repos/${contract.repository}/contents/${file}?ref=${revision}`, "Native source is not bound to actual parent/repair");
      assert.equal(originals[`native-${side}-${position}`].path, file);
    }
    if (![0, 1, 4].includes(position)) {
      assert.equal(originals[`native-before-${position}`].sha, originals[`native-after-${position}`].sha,
        "Unrelated production dependency changed");
    }
  }
  for (const side of ["before", "after"]) {
    for (const position of [0, 2, 5, 7]) {
      const label = `native-${side}-${position}`;
      assert.equal(originals[label].path, index.nativeCandidate.sourcePaths[position]);
      assert.equal(originals[label].path, [
        "pkg/cli/codemod_github_app.go", "", "pkg/cli/fix_command.go", "", "",
        "pkg/cli/fix_codemods.go", "", "pkg/cli/yaml_frontmatter_utils.go",
      ][position]);
      input.push({ id: `${side}-${position}`, text: text(label) });
      if (side === "after") assert.equal(
        originals[label].sha, originals["repair-tree"].tree.find(row => row.path === originals[label].path).sha,
      );
      assert.equal(originals[label].sha, position === 0
        ? side === "after" ? "6057e70511fcfb902b86da7904ea2c9c6e0b2b53" : originals["native-before-0"].sha
        : originals[`native-before-${position}`].sha, "Unrelated production helper changed");
    }
  }
  const detection = 'if _, hasApp := frontmatter["app"]; hasApp { return true }';
  const rewrite = `if strings.HasPrefix(trimmed, "app:") && isTopLevelKey(line) {
    newLine, replaced := findAndReplaceInLine(line, "app", "github-app")
    if replaced { result = append(result, newLine); modified = true; continue }
  }`;
  const native = analyzeMigrationSources([...input, { id: "patterns", text: `package fixture
    func detection(frontmatter map[string]any) bool { ${detection}; return false }
    func rewrite() { ${rewrite} }` }]);
  const patterns = { detection: native.sources.patterns.detection.statements[0],
    rewrite: native.sources.patterns.rewrite.statements[0] };
  const transition = verifyMigrationTransition(native.sources["before-0"], native.sources["after-0"], patterns);
  assert.equal(native.independentBoundedWitness, true);
  const helpers = native.sources["after-7"];
  assert.equal(canonical(helpers.getIndentation.body),
    '{ return line[:len(line)-len(strings.TrimLeft(line, " \\t"))] }');
  assert.ok(canonical(helpers.isTopLevelKey.body).includes('return indent == "" && strings.Contains(line, ":")'));
  assert.ok(canonical(helpers.findAndReplaceInLine.body).includes('parts := strings.SplitN(line, ":", 2)'));
  assert.ok(canonical(helpers.findAndReplaceInLine.body).includes('return fmt.Sprintf("%s%s:%s", leadingSpace, newKey, valueAndComment), true'));
  assert.ok(helpers.applyFrontmatterLineTransform.body.includes("transform(frontmatterLines)"));
  assert.ok(helpers.applyFrontmatterLineTransform.body.includes("reconstructContent(result, markdown)"));
  assert.ok(native.sources["after-5"].GetAllCodemods.body.includes("getGitHubAppCodemod()"));
  assert.ok(native.sources["after-2"].processWorkflowFileWithInfo.body.includes("codemod.Apply(currentContent, currentResult.Frontmatter)"));
  const promise = text("native-before-4");
  assert.ok(promise.includes("\n  app:\n") && promise.includes("run `gh aw fix` to update existing workflows"),
    "Missing independently pre-existing top-level migration promise");
  const schema = JSON.parse(text("native-after-3"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, "app"), false);
  assert.equal(schema.properties["github-app"].$ref, "#/$defs/github_app");
  assert.equal(schema.$defs.github_app.type, "object");
  assert.equal(schema.$defs.github_app.properties["app-id"].type, "string");
  assert.equal(schema.$defs.github_app.properties["private-key"].type, "string");
  assert.ok(schema.$defs.github_app.anyOf.some(branch =>
    JSON.stringify(branch.required) === JSON.stringify(["app-id", "private-key"])));
  const reference = parseWorkflowReference(originals["issue-42793"].body, contract.repository);
  const runBinding = validateRunReference(reference, originals["report-run"], contract.adoption.sourcePath, contract.repository);
  assert.equal(runBinding.createdAt < repair.commit.committer.date, true);
  assert.ok(originals["issue-42793"].body.includes("Verify codemod correctness before release"));
  const graph = index.roots.find(row => row.number === 42793);
  assert.ok(graph.timelineComplete);
  assert.ok(graph.timelineLabels.flatMap(label => originals[label]).some(event =>
    event.event === "cross-referenced" && event.source?.issue?.number === 42794
      && event.source.issue.repository?.id === contract.repositoryId && event.created_at < contract.cutoff),
  "Missing independent dated downstream graph");
  return { schemaVersion: 1, workflow: contract.workflow, metricId: partial.nativePartial.id,
    nativeSubtotal: transition.nativeSubtotal, qualifiedWorkflows: 1,
    deliveryAt: repair.commit.committer.date, caseIdentity: partial.nativePartial.caseIdentity,
    sourceGitBlob: contract.sourceBlob, selectedRoots: index.roots.length,
    discoveredPulls: index.pulls.map(pull => pull.number), originalResponses: Object.keys(index.receipts).length,
    contribution: { status: "corroborated-shared", receiptVerified: null, causal: null },
    fullAcceptance: null, safeguards: null, costs: null, decision: "not-rated",
    authoring: partial.authoring, limitation: partial.unknownPolicy, runBinding };
}

export function cliCompatibilityModule(pins) {
  for (const [relative, expected] of Object.entries(pins)) {
    assert.equal(hash(readFileSync(new URL(relative, root))), expected, `Dependency changed: ${relative}`);
  }
  const contract = JSON.parse(readFileSync(new URL("frozen-contract-v1.json", directory)));
  const partial = JSON.parse(readFileSync(new URL("frozen-contract-v2.json", directory)));
  const assessment = assessCompatibilityEvidence();
  const index = readJsonArchive(fileURLToPath(new URL("index.json.gz", directory)));
  const baseline = JSON.parse(readJsonArchive(fileURLToPath(new URL(index.receipts.baseline.file, directory))).body);
  assert.equal(baseline.sha, contract.adoption.parent);
  const metric = {
    id: partial.nativePartial.id, name: "Verified automatic migration repairs", role: "primary",
    formula: partial.nativePartial.formula, direction: "increase", unit: partial.nativePartial.unit,
    presentation: { name: "Verified automatic migration repairs", legendLabel: "Migration repairs", transform: "identity" },
  };
  const definition = {
    schemaVersion: 3, slug: contract.workflow, repository: contract.repository,
    workflowName: "Breaking Change Checker", sourcePath: contract.adoption.sourcePath,
    intent: { goal: contract.originalCensusProposal.goal, acceptance: contract.fullAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: { commit: contract.adoption.commit, adoptedAt: contract.adoption.adoptedAt,
      baselineCommit: contract.adoption.parent, baselineAt: baseline.commit.committer.date },
    evaluation: { mode: "attainment-only" },
    evidence: { key: "cli-compatibility-native-v2", repositories: [contract.repository],
      opportunity: partial.nativePartial.scope,
      filters: ["Actual single-parent source transition", "Independent pre-repair migration promise",
        "Native AST and unchanged production wiring", "No output/merge/fixture credit"],
      collection: "Immutable original API packets, Git blob verification and locally authored Go AST oracle; target code is never executed",
      measurementKind: "interval", window: contract.periods },
    model: { architecture: "Acquire bounded originals once, verify native source facts, allocate disjoint delivery periods and render with the portable skill",
      recommendation: "Not rated; full compatibility, safeguards, matched costs and an agreed keep bar are unknown",
      presentation: { label: partial.nativePartial.unit, betterLabel: "More independently verified migration repairs" } },
    summary: { nativeLabel: partial.nativePartial.unit }, metrics: [metric],
    validationExamples: { targetAttained: { schemaVersion: 1, native: 1 }, targetMissed: { schemaVersion: 1, native: 0 },
      missing: {}, malformed: { schemaVersion: 1, native: -1 } },
    originalAcceptance: contract.nativePartial, fullAcceptance: contract.fullAcceptance,
    limitations: [...contract.separateUnknowns, ...partial.rejectedClaims],
    frozenSource: { revision: contract.revision, sourceBlob: contract.sourceBlob, cutoff: contract.cutoff },
    assessmentPolicy: partial.authoring, nativeAssessment: assessment, dependencyIdentity: pins,
  };
  const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    && Number.isFinite(Date.parse(value));
  return {
    definition,
    collectBatch(requests) {
      assert.ok(Array.isArray(requests));
      for (const request of requests) {
        assert.ok(request.repository === undefined || request.repository.toLowerCase() === contract.repository);
        assert.ok(utc(request.windowStart) && utc(request.windowEnd) && utc(request.observedAt)
          && request.windowStart < request.windowEnd && request.windowEnd <= request.observedAt
          && request.windowEnd <= contract.cutoff, "Invalid, immature or out-of-cutoff period");
      }
      const ordered = [...requests].sort((a, b) => a.windowStart.localeCompare(b.windowStart));
      assert.ok(!ordered.some((request, position) => position > 0
        && ordered[position - 1].windowEnd > request.windowStart), "Overlapping delivery periods");
      return requests.map(request => {
        const delivered = assessment.deliveryAt >= request.windowStart && assessment.deliveryAt < request.windowEnd;
        return { commit: contract.revision, evidence: { schemaVersion: 1,
          native: delivered ? 1 : null, knownSubtotal: delivered ? 1 : 0,
          caseIdentities: delivered ? [assessment.caseIdentity] : [], coverageStatus: "partial",
          originalStrictAcceptance: null, fullAcceptance: null, safeguards: null,
          contribution: delivered ? assessment.contribution : null, costs: null },
        provenance: [{ repository: contract.repository, kind: "git-commit",
          ref: `https://github.com/${contract.repository}/commit/7bc15e21c80d251de946b34e2798afe58fcfaf62` }] };
      });
    },
    scoreMetric(id, evidence) {
      assert.equal(id, metric.id, "Unknown metric");
      return evidence?.schemaVersion === 1 && Number.isSafeInteger(evidence.native) && evidence.native >= 0
        ? evidence.native : null;
    },
  };
}
