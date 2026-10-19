import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicable, referenceRepairs, references } from "../../docs/operational-value/proof/doc-accuracy/checker.mjs";
import { archive, base, contract, gitId, iso, verifyCompiler } from "../../docs/operational-value/proof/doc-accuracy/objects.mjs";
import { createFunction } from "../../docs/operational-value/proof/doc-accuracy/runtime.mjs";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import {
  authenticationRepair, compileFlagRepair, explicitParentRepair, goTokens, networkGuidance,
  outputGuidance, toolsetRepairs,
} from "../../docs/operational-value/proof/doc-accuracy/factual.mjs";

test("local-reference oracle verifies a real native condition, not edits or deletion", () => {
  const file = "docs/src/content/docs/reference/example.md";
  const old = "[Guide](missing.md)\n";
  const repaired = "[Guide](existing.md)\n";
  const check = referenceRepairs(file, old, repaired, () => false, p => p.endsWith("/existing.md"));
  assert.equal(check.repairs.length, 1);
  assert.equal(check.repairs[0].newTarget, "docs/src/content/docs/reference/existing.md");
  assert.equal(referenceRepairs(file, old, "", () => false, () => true).repairs.length, 0);
  assert.equal(referenceRepairs(file, old, repaired, () => false, () => false).assessed[0].repaired, false);
  assert.equal(referenceRepairs(file, repaired, repaired, () => true, () => true).assessed.length, 0);
});

test("unchanged references count only when missing target becomes present", () => {
  const text = "Read `.github/aw/syntax.md` for details.";
  assert.equal(referenceRepairs(".github/aw/designer.md", text, text, () => false, () => true).repairs.length, 1);
  assert.equal(referenceRepairs(".github/aw/designer.md", text, text, () => false, () => false).repairs.length, 0);
});

test("oracle refuses ambiguous context and unsupported links", () => {
  const file = "docs/src/content/docs/example.md";
  for (const text of ["[x](https://example.org/a.md)", "[x](a.md#anchor)", "[x](/site/a.md)",
    "[x](../../../../../escape.md)", "[x](a.md \"title\")", "[x](${path}.md)",
    "```\n[x](a.md)\n```"]) assert.deepEqual(references(file, text), []);
  assert.equal(referenceRepairs(file, "[x](a.md)\n[x](a.md)", "[x](b.md)", () => false, () => true).repairs.length, 0);
});

test("source-era applicability is workflow specific", () => {
  assert.equal(applicable("designer-drift-audit", "workflow designer: stale references"), true);
  assert.equal(applicable("designer-drift-audit", "changed designer file"), false);
  assert.equal(applicable("daily-doc-healer", "Documentation gaps DDUw missed"), true);
  assert.equal(applicable("daily-doc-updater", "documentation based on recent code changes"), true);
  assert.equal(applicable("daily-doc-updater", null), false);
});

test("native identity and clock primitives are strict", () => {
  assert.equal(gitId("blob", Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(iso("2026-10-18T15:00:12Z"), true);
  assert.equal(iso("2026-02-30T00:00:00Z"), false);
  assert.equal(iso("2026-10-18"), false);
});

test("all three source additions replay against actual parents, not shallow boundaries", () => {
  const originals = archive();
  const plan = JSON.parse(readFileSync(path.join(base, "plan.json")));
  for (const addition of plan.additions) {
    assert.equal(originals.commit(addition.commit).parents[0], addition.parent);
    for (const extension of ["md", "lock.yml"]) {
      assert.equal(originals.resolve(addition.parent, `.github/workflows/${addition.slug}.${extension}`), null);
      assert.notEqual(originals.resolve(addition.commit, `.github/workflows/${addition.slug}.${extension}`), null);
    }
  }
  for (const [slug, source] of Object.entries(contract.sources)) {
    assert.equal(originals.resolve(contract.frozenRevision, `.github/workflows/${slug}.md`).oid, source.blob);
    assert.equal(applicable(slug, originals.text(contract.frozenRevision, `.github/workflows/${slug}.md`)), true);
  }
});

test("collector consumes canonical request shape and rejects malformed clocks, sources and scope", async () => {
  const module = createFunction("daily-doc-updater");
  const request = { observedAt: contract.cutoff, windowStart: "2026-10-11T15:00:12Z", windowEnd: contract.cutoff };
  const [result] = await module.collectBatch([request]);
  assert.equal(result.evidence.windowStart, request.windowStart);
  assert.equal(result.evidence.semanticAccepted, null);
  assert.equal(result.evidence.linkedRepairs, null);
  assert.equal(module.scoreMetric("semanticAccepted", result.evidence), null);
  for (const bad of [
    { ...request, observedAt: "2026-10-19T15:00:12Z" },
    { ...request, windowEnd: "2026-10-19T15:00:12Z" },
    { ...request, windowStart: request.windowEnd },
    { ...request, repository: "another/repo" },
    { ...request, observedAt: "2026-02-30T15:00:12Z" },
  ]) await assert.rejects(module.collectBatch([bad]), /Invalid request/);
  assert.equal(module.scoreMetric("unknown", result.evidence), null);
  assert.equal(module.scoreMetric("referenceRepairs", module.definition.validationExamples.targetMissed), 0);
  assert.equal(module.scoreMetric("referenceRepairs", module.definition.validationExamples.missing), null);
});

test("canonical cohorts are cutoff-aligned, disjoint and not overlapping weekly snapshots", () => {
  for (const slug of Object.keys(contract.sources)) {
    const module = createFunction(slug);
    const windows = observationWindows(module.definition, module.definition.adoption.adoptedAt, contract.cutoff);
    assert.equal(windows.at(-1).windowEnd, contract.cutoff);
    assert.equal(windows[0].windowStart, module.definition.adoption.adoptedAt);
    for (let i = 1; i < windows.length; i++) {
      assert.equal(windows[i - 1].windowEnd, windows[i].windowStart);
      assert.equal(Date.parse(contract.cutoff) - Date.parse(windows[i].windowEnd),
        (windows.length - 1 - i) * 7 * 86400000);
    }
  }
});

test("mutation and missing originals fail explicitly, rather than manufacturing no-op evidence", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "doc-accuracy-mutation-"));
  try {
    cpSync(path.join(base, "originals"), path.join(temporary, "originals"), { recursive: true });
    cpSync(path.join(base, "originals.json"), path.join(temporary, "originals.json"));
    const manifest = JSON.parse(readFileSync(path.join(temporary, "originals.json")));
    const part = path.join(temporary, "originals", manifest.objects[0].parts[0].file);
    writeFileSync(part, "not the original object");
    assert.throws(() => archive(temporary), /custody mismatch/);
    rmSync(part);
    assert.throws(() => archive(temporary), /ENOENT/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});

test("network mappings require exact independent stable authority, not name mentions", () => {
  const reference = "## Invalid Shorthands\n| Invalid | Description | Correct |\n| `gem` or `gems` | Ruby | `ruby` |";
  const document = "### Invalid Network Shorthands\n| Invalid | Correct |\n| `gem` or `gems` | `ruby` |";
  assert.equal(networkGuidance("", document, reference, reference).length, 2);
  assert.equal(networkGuidance(document, document, reference, reference).length, 0);
  assert.equal(networkGuidance("", document, reference.replaceAll("ruby", "python"), reference).length, 0);
  assert.equal(networkGuidance("", "Mentions `gem` and `ruby`", reference, reference).length, 0);
});

test("safe-output mapping intersects exact schema and operation identities", () => {
  const schema = JSON.stringify({ properties: { "safe-outputs": { properties: { "repo-memory": {} } } } });
  const registry = 'var ValidationConfig = map[string]TypeValidationConfig{ "push_repo_memory": {DefaultMax: 1}, }';
  const after = '## Safe Output Mapping\n| User says | Maps to |\n| "persist" | `push-repo-memory` |';
  const result = outputGuidance("", after, schema, schema, registry, registry);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].identity, "push-repo-memory");
  assert.equal(outputGuidance("", after, schema.replace("repo-memory", "push-repo-memory"),
    schema.replace("repo-memory", "push-repo-memory"), registry, registry).accepted.length, 1);
});

test("genuine rejected toolset predicates remain rejected when the schema is stale", () => {
  const data = JSON.stringify({ toolsets: { repos: {} } });
  const staleSchema = JSON.stringify({ $defs: { github_toolset_name: { enum: ["repos", "search"] } } });
  const cleanSchema = JSON.stringify({ $defs: { github_toolset_name: { enum: ["repos"] } } });
  const before = "**Available**: `repos`, `search`", after = "**Available**: `repos`";
  assert.equal(toolsetRepairs(before, after, data, data, staleSchema, staleSchema).accepted.length, 0);
  assert.equal(toolsetRepairs(before, after, data, data, staleSchema, staleSchema).rejected.length, 1);
  assert.equal(toolsetRepairs(before, after, data, data, cleanSchema, cleanSchema).accepted.length, 1);
});

test("auth factual repair needs the actual error literal and conditional return, not comments", () => {
  const originals = archive(), change = "dcd3641adfa184b3ae0c6e45d7ea639f63d396e3";
  const parent = originals.commit(change).parents[0];
  const file = "docs/src/content/docs/setup/quick-start.mdx";
  const before = originals.text(parent, file), after = originals.text(change, file);
  const code = originals.text(change, "pkg/cli/engine_secrets.go");
  assert.equal(authenticationRepair(before, after, code, code).length, 1);
  assert.equal(authenticationRepair(before, after, "// " + code.replaceAll("\n", "\n// "), code).length, 0);
  assert.equal(authenticationRepair(before, after, code.replace("return \"\", \"\", false, errUnsupportedClaudeOAuthToken",
    'return "", "", false, nil'), code).length, 0);
  assert.deepEqual(goTokens('// return unsupported\nvar x = "not code"; /* no code */'),
    ["var", "x", "=", '"not code"', ";"]);
  assert.throws(() => goTokens('"unfinished'), /Unterminated/);
});

test("explicit parent option requires both schema and independent runtime behavior", () => {
  const originals = archive(), commit = "462ed682857c4ab64d40f2c85e3738fa27834839", parent = originals.commit(commit).parents[0];
  const file = "docs/src/content/docs/reference/safe-outputs.md", schemaFile = "pkg/parser/schemas/main_workflow_schema.json";
  const before = originals.text(parent, file), after = originals.text(commit, file);
  const schema = originals.text(commit, schemaFile), handler = originals.text(commit, "actions/setup/js/link_sub_issue.cjs");
  assert.equal(explicitParentRepair(before, after, schema, schema, handler, handler).length, 1);
  assert.equal(explicitParentRepair(after, after, schema, schema, handler, handler).length, 0);
  assert.equal(explicitParentRepair(before, after, schema, schema,
    handler.replace('targetConfig === "*"', 'targetConfig === "triggering"'), handler).length, 0);
  const changedSchema = JSON.parse(schema);
  changedSchema.properties["safe-outputs"].properties["link-sub-issue"].oneOf.find(item =>
    item.type === "object").properties.target = { type: "string", enum: ["triggering"] };
  assert.equal(explicitParentRepair(before, after, JSON.stringify(changedSchema), schema, handler, handler).length, 0);
});

test("compile predicate is not relaxed from exact row to an options-list mention", () => {
  const originals = archive(), commit = "462ed682857c4ab64d40f2c85e3738fa27834839", parent = originals.commit(commit).parents[0];
  const before = originals.text(parent, "docs/src/content/docs/setup/cli.md");
  const after = originals.text(commit, "docs/src/content/docs/setup/cli.md");
  const main = originals.text(commit, "cmd/gh-aw/main.go"), runtime = originals.text(commit, "pkg/cli/compile_development.go");
  assert.equal(compileFlagRepair(before, after, main, main, runtime, runtime).length, 0);
  assert.equal(compileFlagRepair("", "| `--allow-experimental` | Flag |\n", main, main, runtime, runtime).length, 1);
});

test("native replay preserves 12, 2 and 1 useful partials, zero rejected cases, and null unknown history", async () => {
  const expected = { "designer-drift-audit": 12, "daily-doc-healer": 2, "daily-doc-updater": 1 };
  for (const [slug, quantity] of Object.entries(expected)) {
    const module = createFunction(slug);
    const requests = observationWindows(module.definition, module.definition.adoption.adoptedAt, contract.cutoff);
    const collections = await module.collectBatch(requests);
    assert.equal(collections.reduce((sum, item) => sum + (module.scoreMetric("factualRepairs", item.evidence) ?? 0), 0), quantity);
    assert.equal(collections.every(item => module.scoreMetric("semanticAccepted", item.evidence) === null
      && module.scoreMetric("linkedRepairs", item.evidence) === null), true);
    assert.equal(collections.some(item => item.evidence.factualRepairs === null), true);
    const rejected = collections.flatMap(item => item.evidence.cases.flatMap(native => native.factual.rejected));
    assert.equal(rejected.length, slug === "daily-doc-healer" ? 2 : 1);
  }
});

test("compiler/source contract mutation cannot silently produce a new observation", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "doc-accuracy-source-"));
  try {
    const lock = JSON.parse(readFileSync(path.join(base, "compiler-lock.json")));
    for (const entry of lock.files) {
      cpSync(path.join(base, entry.path), path.join(temporary, entry.path), { recursive: true });
    }
    cpSync(path.join(base, "compiler-lock.json"), path.join(temporary, "compiler-lock.json"));
    verifyCompiler(temporary);
    writeFileSync(path.join(temporary, "contract-v1.json"), "{}");
    assert.throws(() => verifyCompiler(temporary), /Frozen compiler\/source mutation/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});
