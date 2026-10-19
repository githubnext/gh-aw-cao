import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";
import { reusableArtifactPaths, sha256 } from "./reusable-artifact-value.mjs";

const cache = process.argv[2];
if (!cache) throw new Error("Usage: node scripts/author-reusable-artifact-value.mjs BARE_CACHE");
const repository = "github/gh-aw", sourceRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const workflowId = "smoke-workflow-call-with-inputs", sourcePath = `.github/workflows/${workflowId}.md`;
const reader = publicGitSourceReader(cache, repository);
const adoption = "9e1a4f71fca4274be4caec23cfb09b40995fd7b5";
const baseline = reader.metadata(["rev-parse", `${adoption}^`]);
const date = ref => new Date(reader.metadata(["show", "-s", "--format=%cI", ref])).toISOString().replace(".000Z", "Z");
for (const file of [sourcePath, sourcePath.replace(".md", ".lock.yml"), ".github/workflows/smoke-multi-caller.yml"]) {
  if (reader.metadata(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, adoption, "--", file]) !== `A\t${file}`) {
    throw new Error("Reusable workflow adoption is not a true addition");
  }
}
const files = [sourcePath, sourcePath.replace(".md", ".lock.yml"), ".github/workflows/smoke-multi-caller.yml",
  ".github/workflows/shared/otlp.md", "actions/setup/sh/compute_artifact_prefix.sh", "pkg/workflow/compiler_workflow_call.go",
  "pkg/workflow/compiler_yaml_artifacts.go", "actions/setup/js/noop.cjs"];
const sources = [];
for (const revision of [adoption, sourceRevision]) {
  for (const file of files) {
    const record = reader.read(revision, file);
    if (record) sources.push({ revision, path: file, gitBlob: record.id, sha256: record.sha256, content: record.bytes.toString("base64") });
  }
}
if (reader.read(sourceRevision, sourcePath).id !== "08d153af00652b150838280e72700fcd9a3a36af") throw new Error("Assigned source identity changed");
const caller = parse(reader.read(sourceRevision, ".github/workflows/smoke-multi-caller.yml").bytes.toString());
const locked = parse(reader.read(sourceRevision, sourcePath.replace(".md", ".lock.yml")).bytes.toString());
const contract = {
  schemaVersion: 1, workflowId, repository, repositoryId: 1036865607, sourceRevision, sourcePath,
  sourceGitBlob: "08d153af00652b150838280e72700fcd9a3a36af", until: "2026-10-18T15:00:12Z",
  adoption: { commit: adoption, adoptedAt: date(adoption), baselineCommit: baseline, baselineAt: date(baseline) },
  goal: "Keep concurrent and sequential reusable-workflow callers isolated: each invocation uploads uniquely input-correlated artifacts whose contents and downstream consumer belong to that invocation.",
  acceptance: "All task-a/task-b concurrent and task-c sequential invocations have distinct provider artifact identities/names, SHA256-verified activation and agent payloads containing their exact declared task input, correct noop content, and source-bound protected consumer readback. All additional invocation-scoped artifact families must also be isolated when emitted.",
  filters: ["Only source-defined smoke-multi-caller opportunities; standalone schedule/dispatch runs do not exercise multiple callers and are inventoried separately.",
    "Initial attempts only; inventory later attempts without counting the same opportunity twice.",
    "GitHub pull_request uses a merge checkout: missing immutable workflow execution identity remains unknown.",
    "Source profiles preserve original caller inputs/defaults, producer/consumer steps and namespace algorithm; incompatible historical profiles remain unknown.",
    "SHA256 namespace prefix depends on exact toJSON(inputs) serialization and run attempt. Never hash a guessed JSON serialization.",
    "Identical-input calls are an explicitly documented unsupported edge case, not proven safe.",
    "Jobs, successful uploads, artifact counts, task echoes and agent-authored noop text alone are not accepted outcome evidence."],
  limitations: ["Historical payloads and protected readback can expire independently of run/job metadata.",
    "Eight hex characters are a collision-resistant namespace, not a mathematical uniqueness guarantee.",
    "Shared overwrite-enabled telemetry (aic-usage-scan-v2) is not invocation payload isolation; its isolation is not established.",
    "No cost, universal race-safety, sole attribution or causal improvement claim.",
    "The scenario was introduced at adoption; the repository reliability problem predates it, but no symmetric preserved pre-adoption three-caller payload evidence exists."],
  antecedent: { outcome: "pre-existing-but-not-reconstructable",
    evidence: "Adoption adds the callee, compiled lock and three-caller test against actual parent. Native artifact collision risk predates this test; neither workflow trace absence nor test creation proves zero collisions.",
    classification: "attainment-only", baselineProbe: { commit: baseline,
      files: [sourcePath, ".github/workflows/smoke-multi-caller.yml"].map(file => ({ path: file, exists: reader.read(baseline, file) !== null })) } },
  metricDisposition: { primary: "Independent complete three-caller artifact isolation proofs",
    diagnostics: ["Complete period proof count", "Eligible/unknown/source-incompatible inventories"],
    rejected: ["Overall run/job success", "Artifact count alone", "Self-reported noop alone", "Static namespace code alone"] },
  callerJobs: Object.fromEntries(Object.entries(caller.jobs).map(([id, job]) => [id, { with: job.with, needs: job.needs ?? [], uses: job.uses }])),
  declaredInputs: locked.on.workflow_call.inputs,
  artifactSteps: Object.entries(locked.jobs).flatMap(([job, value]) => (value.steps ?? [])
    .filter(step => /actions\/(?:upload|download)-artifact@/.test(step.uses ?? ""))
    .map(step => ({ job, name: step.name, uses: step.uses, with: step.with, if: step.if ?? null }))),
  history: Object.fromEntries([sourcePath, ".github/workflows/smoke-multi-caller.yml", "actions/setup/sh/compute_artifact_prefix.sh"]
    .map(file => [file, reader.metadata(["log", "--first-parent", "--format=%H %cI %s", sourceRevision, "--", file]).split("\n")])),
  sourceClosureSha256: censusDigest(sources), interpreterSha256: sha256(readFileSync("scripts/reusable-artifact-value.mjs")),
};
mkdirSync(reusableArtifactPaths.directory, { recursive: true });
if (execFileSync("git", ["status", "--porcelain", "--", reusableArtifactPaths.contract], { encoding: "utf8" }).trim()) {
  throw new Error("Refusing to overwrite a frozen reusable artifact contract");
}
writeCensusJson(reusableArtifactPaths.contract, contract);
writeCensusJson(`${reusableArtifactPaths.directory}/sources.json.gz`, sources);
const modulePath = `docs/operational-value/proof/functions/${workflowId}.mjs`;
writeFileSync(modulePath, `import { readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";\nimport { reusableArtifactModule } from "../../../../scripts/reusable-artifact-value.mjs";\nconst module = reusableArtifactModule(readCensusJson("${reusableArtifactPaths.contract}"));\nexport const { definition, collectBatch, scoreMetric } = module;\n`);
console.log(JSON.stringify({ modulePath, contractSha256: censusDigest(contract), sources: sources.length }));
