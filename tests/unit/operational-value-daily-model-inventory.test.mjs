import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assessAliases, collectBatch, decodeInventory, definition, globMatch, scoreMetric } from "../../docs/operational-value/proof/functions/daily-model-inventory.mjs";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = value => structuredClone(value);
const cutoff = definition.sourceProfile.cutoff;
const inventories = () => clone(definition.validationExamples.targetMissed.inventories);
const capture = (provider, mutate) => {
  const inventory = inventories().find(row => row.provider === provider);
  mutate(inventory);
  inventory.pages.forEach(page => { page.sha256 = hash(page.body); });
  const bound = inventory.receipt.capture;
  for (const field of ["provider", "repository", "repositoryId", "capturedAt", "accessScope", "endpoint", "complete"]) {
    bound[field] = inventory[field];
  }
  bound.pagesSha256 = hash(inventory.pages);
  inventory.receipt.sha256 = hash(bound);
  return inventory;
};
const request = { windowStart: definition.adoption.adoptedAt, windowEnd: cutoff, observedAt: cutoff };

test("native examples obey each declared direction, missing is never zero", () => {
  for (const metric of definition.metrics) {
    const attained = scoreMetric(metric.id, definition.validationExamples.targetAttained);
    const missed = scoreMetric(metric.id, definition.validationExamples.targetMissed);
    assert.equal(metric.direction === "increase" ? attained > missed : attained < missed, true);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
});

test("wildcard is case-insensitive, literal regex punctuation, and cannot cross slash", () => {
  assert.equal(globMatch("copilot/*SONNET*", "CoPiLoT/claude-sonnet-5"), true);
  assert.equal(globMatch("copilot/gpt-5.5*", "copilot/gpt-5x5"), false);
  assert.equal(globMatch("copilot/*", "copilot/a/b"), false);
  assert.equal(globMatch("google/*", "gemini/gemini-pro"), false);
});

test("complete pattern list and all recursive branches define one alias opportunity", () => {
  const aliases = { parent: ["child?effort=high"], child: ["copilot/missing*", "openai/other*"] };
  const result = assessAliases(aliases, inventories());
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.supportedCount, 2);
  assert.equal(result.staleCount, 0);
});

test("one failed candidate does not make an alias stale while another live branch matches", () => {
  const aliasMap = { family: ["copilot/missing*", "openai/other*"] };
  const result = assessAliases(aliasMap, [inventories().find(row => row.provider === "openai")]);
  assert.equal(result.rows[0].status, "supported");
  assert.equal(result.coverageStatus, "complete");
});

test("missing, empty, partial, failed and unconfigured provider inventories remain unknown", () => {
  const aliases = { family: ["copilot/desired*"] };
  assert.equal(assessAliases(aliases, []).rows[0].status, "unknown");
  for (const altered of [
    capture("copilot", value => { value.pages[0].body.endpoints[0].models = []; }),
    capture("copilot", value => { value.pages[0].body.endpoints[0].configured = false; }),
    capture("copilot", value => { value.pages[0].body.models_fetch_complete = false; }),
    capture("copilot", value => { value.complete = false; }),
    capture("copilot", value => { value.pages[0].status = 503; value.pages[0].body = { error: "unavailable" }; }),
  ]) {
    const population = inventories().map(row => row.provider === "copilot" ? altered : row);
    assert.equal(assessAliases(aliases, population).rows[0].status, "unknown");
  }
});

test("complete absence is stale; removing a missing provider never creates absence proof", () => {
  const aliases = { family: ["copilot/desired*"] };
  assert.equal(assessAliases(aliases, inventories()).staleCount, 1);
  assert.equal(assessAliases({ family: ["COPILOT/desired*"] }, inventories()).staleCount, 1);
  for (const provider of ["copilot", "openai", "anthropic", "gemini"]) {
    assert.equal(assessAliases(aliases, inventories().filter(row => row.provider !== provider)).staleCount, 0);
  }
});

test("exact bare model fallback is retained after pattern exhaustion", () => {
  const aliases = { family: ["copilot/missing*"] };
  const live = capture("openai", value => { value.pages[0].body.data = [{ id: "FaMiLy" }]; });
  assert.equal(assessAliases(aliases, [live]).rows[0].status, "supported");
});

test("provider canonical synonyms reflect source scoped catalog conventions", () => {
  const live = capture("gemini", value => { value.pages[0].body.models = [{ name: "models/gemini-3-pro" }]; });
  const result = assessAliases({ family: ["google/gemini*"], other: ["gemini/gemini*"] }, [live]);
  assert.equal(result.supportedCount, 2);
});

test("invalid aliases are errors, not a clean empty population", () => {
  for (const aliases of [
    null, [], { a: [] }, { a: "copilot/a" }, { a: ["b"], b: ["a"] },
    { a: ["copilot/a?effort=extreme"] }, { a: ["copilot/a?temperature=3"] },
    { a: ["copilot/a?temperature=NaN"] }, { a: ["copilot/a/b"] },
    { a: ["copilot/a?broken"] }, { a: ["copilot/[abc]"] }, { "bad key": ["copilot/a"] },
  ]) assert.throws(() => assessAliases(aliases, []));
  assert.equal(assessAliases({}, inventories()).eligibleCount, 0);
});

test("partial native support survives missing full goal acceptance", () => {
  const evidence = clone(definition.validationExamples.targetAttained);
  evidence.aliasMap = { supported: ["copilot/desired*"], unknown: ["anthropic/missing*"] };
  evidence.inventories = evidence.inventories.filter(row => row.provider === "copilot");
  assert.equal(scoreMetric("supported-aliases", evidence), 1);
  assert.equal(scoreMetric("known-stale-aliases", evidence), 0);
  assert.equal(scoreMetric("stale-aliases", evidence), null);
  evidence.fullAcceptance = null;
  evidence.workflowContribution = null;
  assert.equal(scoreMetric("supported-aliases", evidence), 1);
});

test("scores reject malformed, forged, late, ambiguous and incomplete evidence", () => {
  const base = clone(definition.validationExamples.targetAttained);
  for (const mutate of [
    value => { delete value.inventories; },
    value => { value.inventories = [null]; },
    value => { value.inventories[0].pages[0].body.endpoints[0].models.push("forged"); },
    value => { value.inventories[0].capturedAt = "2026-10-19T00:00:00Z"; },
    value => { value.inventories[0].receipt.sha256 = "0".repeat(64); },
    value => { value.inventories[0].repositoryId = 1; },
    value => { value.inventories.push(clone(value.inventories[0])); },
    value => { value.observedAt = "2026-10-17T00:00:00Z"; },
  ]) {
    const evidence = clone(base);
    mutate(evidence);
    assert.equal(scoreMetric("stale-aliases", evidence), null);
  }
});

test("Anthropic pagination requires a linked, complete and digest-checked page chain", () => {
  const partial = capture("anthropic", value => {
    value.pages[0].body.has_more = true;
    value.pages[0].body.last_id = "other-5";
  });
  assert.equal(decodeInventory(partial).complete, false);
  const full = capture("anthropic", value => {
    value.pages[0].body.has_more = true;
    value.pages[0].body.last_id = "other-5";
    value.pages.push({ cursor: "other-5", status: 200, body: { data: [{ id: "last-model" }], has_more: false } });
  });
  assert.equal(decodeInventory(full).complete, true);
  const gap = clone(full);
  gap.pages[1].cursor = "wrong";
  gap.receipt.capture.pagesSha256 = hash(gap.pages);
  gap.receipt.sha256 = hash(gap.receipt.capture);
  assert.throws(() => decodeInventory(gap), /pagination gap/);
});

test("Gemini nextPageToken and empty terminal pages do not discard earlier models", () => {
  const full = capture("gemini", value => {
    value.pages[0].body.nextPageToken = "next";
    value.pages.push({ cursor: "next", status: 200, body: { models: [] } });
  });
  assert.equal(decodeInventory(full).complete, true);
  const partial = capture("gemini", value => { value.pages[0].body.nextPageToken = "next"; });
  assert.equal(decodeInventory(partial).complete, false);
});

test("a failed later provider page cannot erase other providers' independently supported aliases", () => {
  const failure = capture("anthropic", value => {
    value.pages[0].body.has_more = true;
    value.pages[0].body.last_id = "other-5";
    value.pages.push({ cursor: "other-5", status: 503, body: { error: "unavailable" } });
  });
  assert.equal(decodeInventory(failure).complete, false);
  const partial = assessAliases({ family: ["openai/other*"], unknown: ["anthropic/missing*"] },
    [failure, inventories().find(row => row.provider === "openai")]);
  assert.equal(partial.supportedCount, 1);
  assert.equal(partial.unknownCount, 1);
});

test("collector evaluates retained whole source; no inventory is not zero stale aliases", async () => {
  const [collection] = await collectBatch([request]);
  assert.equal(collection.evidence.native.eligibleCount, 62);
  assert.equal(collection.evidence.native.unknownCount, 62);
  assert.equal(collection.evidence.coverageStatus, "missing");
  assert.equal(collection.evidence.workflowContribution, null);
  assert.equal(collection.evidence.fullAcceptance, null);
  assert.equal(collection.commit, definition.sourceProfile.revision);
  for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, collection.evidence), null);
});

test("collector can consume independently retained provider captures, not just fixtures in scoreMetric", async () => {
  const [collection] = await collectBatch([request], { inventories: inventories() });
  assert.equal(typeof scoreMetric("stale-aliases", collection.evidence), "number");
  assert.equal(collection.evidence.coverageStatus, "complete");
  assert.equal(collection.provenance.filter(row => row.kind === "protected-provider-capture").length, 4);
});

test("batch preserves ordering, immutable cutoff, and explicit newer missingness", async () => {
  const newer = { windowStart: cutoff, windowEnd: "2026-10-19T15:00:12Z", observedAt: "2026-10-19T15:00:12Z" };
  const old = { windowStart: "2026-05-03T00:00:00Z", windowEnd: "2026-05-04T00:00:00Z",
    observedAt: "2026-05-04T00:00:00Z" };
  const values = await collectBatch([newer, request, old]);
  assert.deepEqual(values.map(row => row.evidence.sourceReady), [false, true, false]);
  assert.equal(values[0].evidence.eligibleCount, undefined);
  assert.equal(values[2].evidence.aliasMap, null);
  assert.deepEqual(await collectBatch([]), []);
  await assert.rejects(collectBatch([{ ...request, repository: "other/repo" }]), /Unsupported repository/);
  await assert.rejects(collectBatch([{ ...request, windowStart: cutoff }]), /Invalid bounded/);
  await assert.rejects(collectBatch([request], { inventories: [{ provider: "invalid" }] }), /Unknown inventory/);
});

test("production interval scheduler stays disjoint; this snapshot function does not claim deliveries", () => {
  const start = "2026-10-01T00:00:00Z", end = "2026-10-18T00:00:00Z";
  const intervals = observationWindows({ ...definition,
    evidence: { ...definition.evidence, measurementKind: "interval",
      window: { durationDays: 7, cadenceDays: 1, maturationDays: 0 } } }, start, end);
  for (let index = 1; index < intervals.length; index += 1) {
    assert.equal(intervals[index - 1].windowEnd, intervals[index].windowStart);
  }
  assert.equal(intervals[0].windowStart, start);
  assert.equal(intervals.at(-1).windowEnd, end);
  assert.equal(definition.evidence.measurementKind, "snapshot");
  assert.match(definition.safeguards.delivery, /not delivered work/);
});
