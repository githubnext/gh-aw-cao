import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

const [gitDirectory, historyDirectory] = process.argv.slice(2);
if (!gitDirectory || !historyDirectory) throw new Error("Expected read-only Git directory and production history directory");
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const root = "docs/operational-value/proof/daily-syntax-error-quality";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const git = args => execFileSync("git", ["--git-dir", gitDirectory, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 16 * 1024 * 1024,
});
const files = [
  ".github/workflows/daily-syntax-error-quality.md",
  ".github/workflows/daily-syntax-error-quality.lock.yml",
  ".github/workflows/shared/reporting.md", ".github/workflows/shared/otlp.md",
  "pkg/workflow/compiler.go", "pkg/workflow/compiler_error_formatter.go",
  "pkg/workflow/compiler_orchestrator.go", "pkg/workflow/compiler_orchestrator_frontmatter.go",
  "pkg/workflow/frontmatter_error.go", "pkg/workflow/workflow_errors.go",
  "pkg/workflow/error_message_quality_test.go", "pkg/workflow/compiler_error_formatter_test.go",
  "pkg/workflow/compiler_error_formatting_test.go",
  "pkg/parser/frontmatter.go", "pkg/parser/frontmatter_content.go",
  "pkg/parser/yaml_error.go", "pkg/parser/schema_errors.go",
  "pkg/parser/schema_validation.go", "pkg/parser/schema_compiler.go",
  "pkg/parser/schema_suggestions.go", "pkg/parser/schema_location_test.go",
  "pkg/parser/schemas/main_workflow_schema.json",
  "pkg/console/console.go", "pkg/console/console_types.go",
  "pkg/cli/compile_config.go", "pkg/cli/compile_output_formatter.go",
  "pkg/cli/compile_validation.go", "pkg/cli/compile_json_output_test.go",
  "pkg/cli/compile_workflow_processor.go",
  "pkg/cli/validation_issue.go",
  "go.mod", ".github/shared-instructions.md",
  "pkg/validationerror/validationerror.go",
  "pkg/console/testdata/TestGolden_ErrorFormatting/error_with_context.golden",
  "pkg/console/testdata/TestGolden_ErrorFormatting/basic_error.golden",
];
mkdirSync(path.join(root, "sources"), { recursive: true });
const sources = [], missing = [];
for (const file of files) {
  const result = spawnSync("git", ["--git-dir", gitDirectory, "show", `${revision}:${file}`], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = result.stderr.toString().trim();
    missing.push({ path: file, reason });
    console.error(reason);
    continue;
  }
  const bytes = result.stdout;
  const blob = git(["rev-parse", `${revision}:${file}`]).toString().trim();
  const object = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (object !== blob) throw new Error(`Git object mismatch: ${file}`);
  const output = `${String(sources.length + 1).padStart(3, "0")}.json.gz`;
  writeJsonArchive(path.join(root, "sources", output), {
    repository: "github/gh-aw", revision, path: file, gitBlob: blob,
    sha256: sha256(bytes), bytes: bytes.length, content: bytes.toString("utf8"),
  }, { spacing: 0 });
  sources.push({ path: file, gitBlob: blob, sha256: sha256(bytes), file: `sources/${output}` });
}
const { index, entities } = readOutputHistory(historyDirectory);
if (index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
  || index.sourceRevision !== revision || index.until !== "2026-10-18T15:00:12Z"
  || !index.complete || index.partitions.length !== 346 || entities.length !== 58048) {
  throw new Error("Unexpected shared production history identity");
}
const candidates = entities.filter(row => row.workflowReference?.workflowId === "daily-syntax-error-quality"
  || row.unverifiedWorkflowId === "daily-syntax-error-quality");
writeJsonArchive(path.join(root, "discovery.json.gz"), {
  schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
  revision, cutoff: index.until, fullInputVerified: { partitions: 346, entities: 58048 },
  historyIndexSha256: sha256(JSON.stringify(index)),
  candidates, authority: "Discovery only. Editable lineage, issue closure and merge do not prove native diagnostic quality or delivery.",
}, { spacing: 0 });
writeJsonArchive(path.join(root, "sources.json"), {
  repository: "github/gh-aw", repositoryId: 1036865607, revision,
  cutoff: index.until, sourceCommit: git(["show", "-s", "--format=%H%n%P%n%cI", revision]).toString(),
  files: sources, missing, optionalRuntimeImport: {
    path: ".github/shared-instructions.md",
    status: "Not included: optional runtime instruction is not a compiler diagnostic oracle.",
  },
}, { spacing: 2 });
console.log(JSON.stringify({ sources: sources.length, discoveryCandidates: candidates.length }));
