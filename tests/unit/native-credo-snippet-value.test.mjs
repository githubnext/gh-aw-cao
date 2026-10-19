import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { credoHash, credoMarkdownPath, executeCredoSnippet, extractCredoSnippets,
  scanCredoSnippets, scoreCredoSnippets } from "../../scripts/native-credo-snippet-value.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const directory = "docs/operational-value/proof/credo-snippets";
const result = diagnostics => ({ status: "checked", contentSha256: "a".repeat(64), diagnostics,
  checkedFiles: 1, strict: true, credo: "1.7.12", elixir: "1.17.3", otp: "27" });
const evidence = snippets => ({ valid: true, complete: true, markdownFiles: 10,
  eligible: snippets.length, snippets });

test("Credo scope covers all source roots and Markdown extensions without unrelated files", () => {
  for (const file of ["docs/example.md", "docs/src/example.mdx", ".github/workflows/shared/example.markdown"]) {
    assert.equal(credoMarkdownPath(file), true);
  }
  for (const file of ["README.md", "pkg/example.md", "docs/example.exs", ".github/workflows/demo.lock.yml"]) {
    assert.equal(credoMarkdownPath(file), false);
  }
});

test("CommonMark extraction handles aliases, tilde fences, nesting and literal embedded fences", () => {
  const source = [
    "````text", "```elixir", "not a separate Elixir fence", "```", "````",
    "", "> ~~~ELIXIR title", "> IO.puts(:ok)", "> ~~~", "",
    "  ```exs", "  IO.inspect(:ok)", "  ```", "",
    "```ex", "defmodule Demo do", "end", "```", "",
    "```iex", "iex> IO.puts(:ok)", "```", "",
    "    IO.puts(:unlabelled_indented_code)", "",
    "```elixir-not-a-language", "false", "```",
  ].join("\n");
  const rows = extractCredoSnippets(source);
  assert.deepEqual(rows.map(row => row.language), ["elixir", "exs", "ex", "iex"]);
  assert.equal(rows[0].content, "IO.puts(:ok)");
  assert.equal(rows[0].contentSha256, credoHash("IO.puts(:ok)"));
  assert.equal(extractCredoSnippets("No snippets").length, 0);
});

test("native diagnostic score is identity, not a report/run or source-string proxy", () => {
  assert.equal(scoreCredoSnippets("native-credo-diagnostics", evidence([result(2), result(3)])), 5);
  assert.equal(scoreCredoSnippets("native-credo-diagnostics", evidence([result(0)])), 0);
  assert.throws(() => scoreCredoSnippets("successful-runs", evidence([result(0)])), /Unknown/);
});

test("empty opportunities, missing syntax/runtime/context and waivers are never compliant zero", () => {
  assert.equal(scoreCredoSnippets("native-credo-diagnostics", evidence([])), null);
  for (const status of ["invalid-syntax", "runtime-unavailable", "uncheckable-context", "suppressed-context"]) {
    const value = evidence([result(1), { status, contentSha256: "b".repeat(64), diagnostics: null }]);
    assert.equal(scoreCredoSnippets("native-credo-diagnostics", value), null);
    assert.equal(scanCredoSnippets(value).checked, 1);
  }
  for (const value of [null, {}, { ...evidence([result(0)]), complete: false },
    { ...evidence([result(0)]), eligible: 2 }, evidence([result(-1)]), evidence([result("0")]),
    evidence([{ ...result(0), strict: false }]), evidence([{ ...result(0), credo: "latest" }]),
    evidence([{ ...result(0), checkedFiles: 0 }]), evidence([{ ...result(0), contentSha256: "bad" }])]) {
    assert.equal(scoreCredoSnippets("native-credo-diagnostics", value), null);
  }
});

test("context and waiver guards do not execute snippets or need a native process", () => {
  for (const snippet of [{ language: "iex", content: "iex> :ok" },
    { language: "elixir", content: "" }, { language: "exs", content: "...> :ok" }]) {
    assert.equal(executeCredoSnippet(snippet, "/nonexistent-private-project").status, "uncheckable-context");
  }
  assert.equal(executeCredoSnippet({ language: "elixir", content: "# credo:disable-for-this-file\nIO.inspect(:ok)" },
    "/nonexistent-private-project").status, "suppressed-context");
  assert.throws(() => executeCredoSnippet({ content: ":ok", language: "elixir" }, null), /project/);
});

test("retained native probes independently distinguish lint validity from parse validity", {
  skip: !existsSync(`${directory}/probes.json`),
}, () => {
  const probes = readCensusJson(`${directory}/probes.json`);
  assert.equal(probes.synthetic, true);
  assert.equal(probes.neverRepositoryOutcomes, true);
  const byName = new Map(probes.probes.map(row => [row.name, row]));
  assert.equal(byName.get("clean-expression").result.diagnostics, 0);
  assert.equal(byName.get("native-warning").result.diagnostics, 1);
  assert.equal(byName.get("native-name").result.diagnostics, 1);
  assert.equal(byName.get("invalid").result.status, "invalid-syntax");
  assert.equal(byName.get("interactive").result.status, "uncheckable-context");
  assert.equal(byName.get("waiver").result.status, "suppressed-context");
  assert.equal(byName.get("not-executed").result.diagnostics, 0);
  for (const probe of probes.probes) assert.equal(probe.result.contentSha256, credoHash(probe.content));
});

test("real evidence retains every immutable Markdown input and does not inflate empty coverage", {
  skip: !existsSync(`${directory}/index.json`),
}, async () => {
  const index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`);
  const contract = readCensusJson(`${directory}/contract.json`);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.probesSha256, censusDigest(readCensusJson(`${directory}/probes.json`)));
  assert.equal(index.toolsSha256, censusDigest(readCensusJson(`${directory}/tools.json.gz`)));
  assert.equal(contract.collectorSha256, credoHash(readFileSync("scripts/collect-credo-snippet-history.mjs")));
  const blobs = new Map();
  for (const reference of index.sources) {
    const source = readCensusJson(`${directory}/${reference.file}`);
    assert.equal(reference.sha256, censusDigest(source));
    verifyPublicGitBlob(Buffer.from(source.native, "base64"), reference.gitBlob);
    assert.equal(credoHash(Buffer.from(source.content, "base64")), source.sha256);
    blobs.set(reference.gitBlob, source);
  }
  for (const state of facts.states) {
    const inventory = readCensusJson(`${directory}/inventory-${state.commit}.json.gz`);
    assert.equal(censusDigest(inventory), state.inventorySha256);
    assert.equal(state.markdownFiles, inventory.length);
    const eligible = inventory.flatMap(entry => {
      assert.equal(entry.mode, "100644");
      const source = blobs.get(entry.gitBlob);
      assert.ok(source, "Every inventory source must be retained");
      return extractCredoSnippets(Buffer.from(source.content, "base64").toString("utf8"));
    });
    assert.equal(state.eligible, eligible.length);
    assert.equal(state.snippets.length, eligible.length);
  }
  const module = await import("../../docs/operational-value/proof/functions/daily-elixir-credo-snippet-audit.mjs");
  const collections = module.collectBatch(facts.states.map(state => ({ windowEnd: state.windowEnd,
    windowStart: new Date(Date.parse(state.windowEnd) - 7 * 86400000).toISOString().replace(".000Z", "Z") })));
  if (!facts.states.some(state => state.eligible)) {
    assert.equal(index.measured, false);
    assert.equal(index.status, "no-eligible-opportunities");
    for (const collection of collections) {
      assert.equal(collection.evidence.noOpportunity, true);
      assert.equal(module.scoreMetric("native-credo-diagnostics", collection.evidence), null);
      assert.match(collection.evidence.missingReason, /No eligible/);
      assert.equal(collection.evidence.workflowContribution, null);
    }
  }
  assert.throws(() => module.collectBatch([{ repository: "other/repo" }]), /mismatch/);
});

test("exhaustive history replays every source transition and reconciles the complete terminal cohort", {
  skip: !existsSync(`${directory}/history-index.json`),
}, () => {
  const index = readCensusJson(`${directory}/history-index.json`);
  const history = readCensusJson(`${directory}/history.json.gz`);
  const contract = readCensusJson(`${directory}/contract.json`);
  assert.equal(index.complete, true);
  assert.equal(index.terminalReconciled, true);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.historySha256, censusDigest(history));
  assert.equal(index.collectorSha256, credoHash(readFileSync("scripts/collect-credo-snippet-transitions.mjs")));
  const eligible = new Map();
  for (const reference of index.sources) {
    const source = readCensusJson(`${directory}/${reference.file}`);
    assert.equal(reference.sha256, censusDigest(source));
    verifyPublicGitBlob(Buffer.from(source.native, "base64"), reference.gitBlob);
    eligible.set(reference.gitBlob, extractCredoSnippets(Buffer.from(source.content, "base64").toString("utf8")).length);
  }
  assert.equal(index.uniqueMarkdownBlobs, eligible.size);
  const inventory = new Map(history.initial.map(entry => [entry.path, entry]));
  const assertState = state => {
    assert.equal(state.markdownFiles, inventory.size);
    let total = 0;
    for (const entry of inventory.values()) {
      assert.ok(eligible.has(entry.gitBlob), "Every historical Markdown source must be retained");
      total += eligible.get(entry.gitBlob);
    }
    assert.equal(state.eligible, total);
  };
  assertState(history.states[0]);
  for (const [position, transition] of history.transitions.entries()) {
    for (const change of transition.changes) {
      if (change.beforeMode !== "000000") assert.equal(inventory.get(change.path)?.gitBlob, change.beforeBlob);
      else assert.equal(inventory.has(change.path), false);
      if (change.afterMode === "000000") inventory.delete(change.path);
      else inventory.set(change.path, { path: change.path, gitBlob: change.afterBlob, mode: change.afterMode });
    }
    assert.equal(history.states[position + 1].commit, transition.commit);
    assertState(history.states[position + 1]);
  }
  assert.equal(index.markdownChangingCommits, history.transitions.length);
  assert.equal(index.checkedStates, history.transitions.length + 1);
  assert.equal(censusDigest([...inventory.values()].sort((a, b) => a.path.localeCompare(b.path))),
    history.terminalInventorySha256);
  if (index.status === "no-eligible-opportunities") {
    assert.equal(index.nativeSnippets, 0);
    assert.equal(index.eligibleStates, 0);
    assert.ok(history.states.every(state => state.eligible === 0));
  }
});
