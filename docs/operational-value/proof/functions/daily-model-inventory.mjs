import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const cutoff = "2026-10-18T15:00:12Z";
const activatedAt = "2026-10-18T06:32:44Z";
const repository = "github/gh-aw";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const digest = value => sha256(JSON.stringify(value));
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const has = (value, key) => Object.hasOwn(value, key);
const providers = ["copilot", "anthropic", "openai", "gemini"];
const prefixes = {
  copilot: ["copilot", "github-copilot"],
  anthropic: ["anthropic"], openai: ["openai", "codex"], gemini: ["gemini", "google"],
};
const endpoints = {
  copilot: "http://api-proxy:10000/reflect",
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
};
const canonical = value => providers.find(provider => prefixes[provider].includes(value.toLowerCase())) ?? null;

class InvalidEvidence extends Error {}
function requireFact(condition, message) {
  if (!condition) throw new InvalidEvidence(message);
}

function identifier(value) {
  requireFact(text(value), "Empty model identifier");
  const [base, query, ...extra] = value.split("?");
  requireFact(extra.length === 0 && /^[A-Za-z0-9_][A-Za-z0-9_.*-]*(?:\/[A-Za-z0-9_.*-]+)?$/.test(base),
    "Unsupported or malformed model identifier");
  if (base.includes("/")) requireFact(/^[A-Za-z][A-Za-z0-9-]*$/.test(base.split("/")[0]), "Invalid provider");
  if (query !== undefined) {
    requireFact(query.length > 0, "Empty model parameter list");
    for (const parameter of query.split("&")) {
      requireFact(/^[A-Za-z][A-Za-z0-9-]*=[A-Za-z0-9_.-]+$/.test(parameter), "Invalid model parameter");
      const [key, value] = parameter.split("=");
      if (key === "effort") requireFact(["low", "medium", "high"].includes(value), "Invalid effort");
      if (key === "temperature") requireFact(/^\d+(?:\.\d+)?$/.test(value)
        && Number(value) <= 2, "Invalid temperature");
    }
  }
  return base;
}

function validateAliases(aliases) {
  requireFact(object(aliases), "Alias map is not an object");
  for (const [alias, patterns] of Object.entries(aliases)) {
    requireFact(alias === "" || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(alias), "Invalid alias key");
    requireFact(Array.isArray(patterns) && patterns.length > 0, "Empty or invalid pattern list");
    patterns.forEach(identifier);
  }
  const completed = new Set();
  function visit(alias, stack) {
    requireFact(!stack.has(alias), `Cyclic alias: ${alias}`);
    requireFact(stack.size <= 10, "Alias depth exceeds specification limit");
    if (completed.has(alias)) return;
    const next = new Set([...stack, alias]);
    for (const entry of aliases[alias]) {
      const base = identifier(entry);
      if (has(aliases, base)) visit(base, next);
    }
    completed.add(alias);
  }
  Object.keys(aliases).forEach(alias => visit(alias, new Set()));
}

export function globMatch(pattern, entry) {
  const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${regex}$`, "i").test(entry);
}

// This is a presence oracle, not model selection: ranking and forwarded parameters cannot change existence.
function expandedPatterns(alias, aliases, memo) {
  if (memo.has(alias)) return memo.get(alias);
  const result = [];
  for (const value of aliases[alias]) {
    const base = identifier(value);
    result.push(...(has(aliases, base) ? expandedPatterns(base, aliases, memo) : [base]));
  }
  // The source resolver also tries the alias's exact bare model ID after exhausting its list.
  if (alias) result.push(alias);
  const unique = [...new Set(result)];
  memo.set(alias, unique);
  return unique;
}

export function decodeInventory(inventory) {
  requireFact(object(inventory) && providers.includes(inventory.provider), "Unknown inventory provider");
  requireFact(inventory.repository === repository && inventory.repositoryId === 1036865607,
    "Inventory repository authority mismatch");
  requireFact(iso(inventory.capturedAt) && text(inventory.accessScope), "Inventory lacks cutoff/access scope");
  requireFact(object(inventory.receipt) && inventory.receipt.kind === "protected-provider-capture"
    && hex(inventory.receipt.sha256) && text(inventory.receipt.ref), "Independent capture receipt required");
  requireFact(inventory.endpoint === endpoints[inventory.provider], "Provider endpoint mismatch");
  requireFact(Array.isArray(inventory.pages) && inventory.pages.length > 0, "Provider pages missing");
  requireFact(object(inventory.receipt.capture)
    && digest(inventory.receipt.capture) === inventory.receipt.sha256
    && inventory.receipt.capture.repository === inventory.repository
    && inventory.receipt.capture.repositoryId === inventory.repositoryId
    && inventory.receipt.capture.provider === inventory.provider
    && inventory.receipt.capture.capturedAt === inventory.capturedAt
    && inventory.receipt.capture.accessScope === inventory.accessScope
    && inventory.receipt.capture.endpoint === inventory.endpoint
    && inventory.receipt.capture.pagesSha256 === digest(inventory.pages)
    && inventory.receipt.capture.complete === inventory.complete,
  "Capture receipt does not bind the exact source, scope, cutoff and page chain");
  let continuation = null;
  const ids = new Set(), cursors = new Set();
  let unavailable = inventory.complete !== true;
  for (const [index, page] of inventory.pages.entries()) {
    requireFact(object(page) && object(page.body) && hex(page.sha256)
      && digest(page.body) === page.sha256, "Provider page digest mismatch");
    requireFact(page.cursor === continuation, "Provider pagination gap");
    if (page.status !== 200 || has(page.body, "error")) {
      unavailable = true;
      requireFact(index === inventory.pages.length - 1, "Unexpected pages after provider error");
      continue;
    }
    let rows;
    const body = page.body, provider = inventory.provider;
    if (provider === "copilot") {
      requireFact(inventory.pages.length === 1 && Array.isArray(body.endpoints), "Invalid reflect response");
      const selected = body.endpoints.filter(endpoint => endpoint?.provider === "copilot"
        && endpoint.configured === true);
      requireFact(selected.length <= 1, "Ambiguous Copilot endpoint");
      const endpoint = selected[0];
      if (!endpoint || !Array.isArray(endpoint.models) || has(endpoint, "error")
        || body.models_fetch_complete !== true) {
        unavailable = true;
        rows = [];
      } else rows = endpoint.models.map(id => ({ id }));
    } else if (provider === "gemini") {
      rows = body.models;
      requireFact(body.nextPageToken === undefined || body.nextPageToken === null
        || typeof body.nextPageToken === "string", "Invalid Gemini pagination token");
      continuation = body.nextPageToken || null;
    } else {
      rows = body.data;
      if (provider === "anthropic") {
        requireFact(typeof body.has_more === "boolean", "Anthropic pagination state missing");
        continuation = body.has_more ? body.last_id : null;
        if (body.has_more) requireFact(text(continuation), "Missing Anthropic continuation");
      } else {
        // The frozen OpenAI acquisition has no pagination. Unexpected pagination is not silently truncated.
        requireFact(!body.has_more && !body.next_page && !body.nextPageToken, "Unsupported OpenAI pagination");
      }
    }
    requireFact(Array.isArray(rows), "Malformed provider model array");
    if (provider === "anthropic" && body.has_more) {
      requireFact(rows.at(-1)?.id === continuation, "Anthropic cursor is not the last returned model ID");
    }
    for (const row of rows) {
      requireFact(object(row) && text(provider === "gemini" ? row.name : row.id), "Malformed live model record");
      const id = provider === "gemini" ? row?.name?.replace(/^models\//, "") : row?.id;
      requireFact(text(id) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(id), "Malformed live model ID");
      requireFact(!ids.has(id), "Duplicate provider model ID");
      ids.add(id);
    }
    if (continuation !== null) {
      requireFact(text(continuation) && !cursors.has(continuation), "Invalid or repeated pagination cursor");
      cursors.add(continuation);
    }
    requireFact(index === inventory.pages.length - 1 || continuation !== null, "Pages after terminal response");
  }
  if (continuation !== null || ids.size === 0) unavailable = true;
  return { provider: inventory.provider, complete: !unavailable,
    capturedAt: inventory.capturedAt, accessScope: inventory.accessScope,
    catalog: [...ids].flatMap(id => [id, ...prefixes[inventory.provider].map(prefix => `${prefix}/${id}`)]),
    ref: inventory.receipt.ref, sha256: digest(inventory) };
}

export function assessAliases(aliases, inventories) {
  validateAliases(aliases);
  requireFact(Array.isArray(inventories), "Inventories are not an array");
  const decoded = inventories.map(decodeInventory);
  requireFact(new Set(decoded.map(row => row.provider)).size === decoded.length, "Duplicate provider inventories");
  const complete = decoded.filter(row => row.complete);
  const catalog = complete.flatMap(row => row.catalog);
  const memo = new Map();
  const rows = Object.keys(aliases).sort().map(alias => {
    const patterns = expandedPatterns(alias, aliases, memo);
    // Bare-ID fallback could match any configured provider, so absence needs all four inventories.
    const applicable = new Set(patterns.flatMap(pattern =>
      pattern.includes("/") ? [canonical(pattern.split("/")[0])] : providers));
    const unsupported = applicable.has(null);
    const match = catalog.find(entry => patterns.some(pattern => globMatch(pattern, entry))) ?? null;
    const missingProviders = [...applicable].filter(provider => !complete.some(row => row.provider === provider));
    return { alias, patterns, status: match ? "supported"
      : unsupported || missingProviders.length ? "unknown" : "stale", match, missingProviders };
  });
  const count = status => rows.filter(row => row.status === status).length;
  return { rows, eligibleCount: rows.length, supportedCount: count("supported"),
    staleCount: count("stale"), unknownCount: count("unknown"), completeProviders: complete.length,
    populationDigest: digest(Object.keys(aliases).sort()),
    policyDigest: digest(aliases),
    coverageStatus: count("unknown") === 0 ? "complete" : complete.length ? "partial" : "missing" };
}

const exampleInventory = (provider, ids) => {
  const body = provider === "copilot"
    ? { models_fetch_complete: true, endpoints: [{ provider, configured: true, models: ids }] }
    : provider === "gemini" ? { models: ids.map(id => ({ name: `models/${id}` })) }
      : { data: ids.map(id => ({ id })), ...(provider === "anthropic" ? { has_more: false } : {}) };
  const inventory = { provider, repository, repositoryId: 1036865607, capturedAt: cutoff,
    accessScope: "synthetic-test-only", endpoint: endpoints[provider], complete: true,
    pages: [{ cursor: null, status: 200, body, sha256: digest(body) }] };
  const capture = { provider, repository, repositoryId: 1036865607, capturedAt: cutoff,
    accessScope: inventory.accessScope, endpoint: inventory.endpoint, complete: true,
    pagesSha256: digest(inventory.pages) };
  return { ...inventory, receipt: { kind: "protected-provider-capture",
    sha256: digest(capture), capture, ref: "synthetic:test-only" } };
};
const example = supported => ({ sourceReady: true, aliasMap: { family: ["copilot/desired*"] },
  inventories: providers.map(provider => exampleInventory(provider, [supported ? "desired-5" : "other-5"])),
  windowEnd: cutoff, observedAt: cutoff });
const metric = (id, name, role, formula, direction, legendLabel) => ({
  id, name, role, formula, direction, unit: "aliases",
  presentation: { name, legendLabel, transform: "identity" },
});

export const definition = {
  schemaVersion: 3, slug: "daily-model-inventory", repository,
  workflowName: "Daily Model Inventory Checker",
  sourcePath: ".github/workflows/daily-model-inventory.md",
  intent: {
    goal: "Keep the built-in model alias mapping usable against live applicable provider inventories.",
    acceptance: "An alias has at least one source-defined recursive pattern or exact fallback matching an independently complete applicable live provider inventory.",
    temporalAnchor: "contract-activation",
  },
  adoption: { commit: revision, adoptedAt: activatedAt, baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: {
    key: "current-source-live-alias-support", repositories: [repository],
    opportunity: "Each built-in alias key at the pinned current-source cutoff, including meta-aliases and per-engine aliases; each key counted once.",
    filters: ["Built-in alias map only; no workflow overrides or task-family usefulness inference.",
      "Case-insensitive literal provider matching; star cannot cross slash; strip parameters before presence checks.",
      "Use complete independent account-scoped inventory; errors, skipped/empty/paginated-incomplete providers are unknown.",
      "Current source predicates never applied to an unknown historical source era.",
      "models.json pricing/history is not live inventory; retain historical entries without automatic removal."],
    collection: "Batch offline replay of retained whole immutable sources and protected provider capture pages. Canonical activity discovery lacks live provider facts. No network or fetched-code execution.",
    measurementKind: "snapshot",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 },
  },
  model: {
    architecture: "Deterministic source-matched presence oracle; repository outcome is independent of workflow output and actor.",
    recommendation: "Report native aliases and unknown coverage; no thresholds or keep decision are inferred.",
    presentation: { label: "Stale alias definitions", betterLabel: "Fewer stale aliases" },
  },
  summary: { nativeLabel: "Aliases without live support" },
  metrics: [
    metric("stale-aliases", "Stale alias definitions", "primary",
      "Count aliases with no live resolution; null unless the entire alias population is independently assessed.",
      "decrease", "Stale aliases"),
    metric("known-stale-aliases", "Established stale subtotal", "diagnostic",
      "Count positively established stale aliases among assessed opportunities; a lower bound during partial coverage, not an all-clear.",
      "decrease", "Known stale subtotal"),
    metric("supported-aliases", "Independently supported aliases", "diagnostic",
      "Count alias keys with a live matching candidate from at least one complete applicable inventory; preserve partial support independently of full acceptance.",
      "increase", "Supported aliases"),
  ],
  validationExamples: {
    targetAttained: example(true), targetMissed: example(false),
    missing: { sourceReady: true, aliasMap: { family: ["copilot/desired*"] },
      inventories: [], windowEnd: cutoff, observedAt: cutoff },
    malformed: { sourceReady: true, aliasMap: { family: [] }, inventories: [] },
  },
  sourceProfile: {
    revision, cutoff, workflowGitBlob: "809b23ebbfc03d891701382286cf0c3417c6b153",
    retainedSha256: "598da2b86274b5cdf911be8a6d572208e3987d6286d213663fedfb4d6efc2852",
    sourcesArchiveSha256: "f7fa02fd6558a0d4302f7e3c8690395cda633b2d14a1621b10ebe3e2e6a5e491",
    resolverSha256: "39528919527af89e76154e9e80c08b6ef38361290ae097d58ad26a3154d1d015",
    nativePort: "Existence subset of resolveModelAlias/buildProviderCatalog/globMatch; no remote code executed. Ranking is immaterial to existence; no engine invocation success is claimed.",
    addition: { commit: "a38bf5047d5f3823d4008d161a56d0bb735d98cc",
      parent: "7c1cc96022a05da6c253224b9d0f0bddae68d19b", actualParentVerified: true,
      adoptedAt: "2026-05-03T20:03:36Z", contents: "retained",
      importGap: "shared/observability-otlp.md blob bb9913da15c04bce33be1c2cda580b3a1e409b4d absent offline",
      compiledGitBlob: "e59422ca7af808a73c507f4bb312ace31a7ca18b" },
  },
  antecedent: {
    result: "pre-existing-but-not-reconstructable",
    qualification: "Reconstruction unavailable in supplied offline evidence, not exhausted globally. Source addition, actual parent, adoption workflow and original alias checker retained; dated provider inventories missing. One transitive historical telemetry import is missing.",
    counterfactual: "A maintainer can restore alias live support without this workflow; the same native unit can predate adoption.",
  },
  safeguards: {
    fullAcceptance: "Not measured: pricing mirror equality/history preservation, SDK routing, billing agreement, capability/task semantics and all provider coverage remain distinct.",
    contribution: "Not measured. Discovery issue/PR/run links are not native acceptance or creation receipts.",
    delivery: "Snapshot state is not delivered work; never sum daily backlog snapshots or award repeated repair credit.",
    costs: "Not measured; no savings, weights or cost-per-report.",
    comparison: "Compare only adjacent equal-duration complete cutoffs with equal population, source profile and access scopes. No source-era mixing or adoption-relative claim.",
    rejected: ["Issue and PR counts", "Run success", "Agent no-change claims", "models.json historical entries as live support",
      "Inferred family pricing as independently established billing", "Arbitrary thresholds or normalized scores"],
    nativeMeasures: {
      liveSupport: "Primary native stale burden and diagnostic supported/known-stale counts.",
      providerCounts: "Evidence coverage only, not value.",
      pricingGaps: "Separate acceptance dimension; no current authority.",
      taskAliasGaps: "Not selected: usefulness/capability intent has no frozen deterministic eligibility.",
      proposedAliasChanges: "Rejected output proxy.",
      preservedPricingMirrors: "Repository guard, not live availability evidence.",
    },
  },
};

function assessEvidence(evidence) {
  requireFact(object(evidence) && evidence.sourceReady === true, "Source unavailable");
  requireFact(iso(evidence.windowEnd) && iso(evidence.observedAt)
    && evidence.observedAt >= evidence.windowEnd, "Invalid evidence times");
  requireFact(Array.isArray(evidence.inventories), "Inventories are not an array");
  requireFact(evidence.inventories.every(inventory => object(inventory) && inventory.capturedAt === evidence.windowEnd),
    "No interpolation or backdating of provider inventories");
  return assessAliases(evidence.aliasMap, evidence.inventories);
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) return null;
  try {
    const facts = assessEvidence(evidence);
    if (facts.eligibleCount === 0 || facts.completeProviders === 0) return null;
    if (id === "stale-aliases") return facts.unknownCount === 0 ? facts.staleCount : null;
    if (id === "known-stale-aliases") return facts.staleCount;
    return facts.supportedCount;
  } catch (error) {
    if (error instanceof InvalidEvidence) return null;
    throw error;
  }
}

function loadBundle() {
  const base = new URL("../daily-model-inventory/", import.meta.url);
  const sourcesFile = new URL("sources.json.gz", base), retainedFile = new URL("retained.json", base);
  requireFact(sha256(readFileSync(sourcesFile)) === definition.sourceProfile.sourcesArchiveSha256,
    "Retained source archive identity mismatch");
  requireFact(sha256(readFileSync(retainedFile)) === definition.sourceProfile.retainedSha256,
    "Retained source index identity mismatch");
  const sources = readJsonArchive(fileURLToPath(sourcesFile));
  const retained = readJsonArchive(fileURLToPath(retainedFile));
  for (const record of sources.records) {
    const bytes = Buffer.from(record.body);
    requireFact(sha256(bytes) === record.sha256 && bytes.length === record.bytes
      && createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === record.gitBlob,
    "Retained original source digest mismatch");
  }
  const selected = sources.records.find(record => record.path === "pkg/workflow/data/model_aliases.json"
    && record.revision === revision);
  requireFact(selected?.gitBlob === "6f9804b612e45d4721635b9b3bff4ab56b661ed4", "Alias source unavailable");
  return { retained, aliases: JSON.parse(selected.body).aliases };
}

export async function collectBatch(requests, context = {}) {
  requireFact(Array.isArray(requests), "Requests must be an array");
  if (!requests.length) return [];
  const { retained, aliases } = loadBundle();
  const captures = context.inventories ?? [];
  requireFact(Array.isArray(captures), "Inventory capture batch must be an array");
  captures.forEach(decodeInventory);
  const captureKeys = captures.map(capture => `${capture.capturedAt}|${capture.provider}`);
  requireFact(new Set(captureKeys).size === captureKeys.length, "Duplicate provider/cutoff capture");
  const memo = new Map();
  return requests.map(request => {
    requireFact(object(request) && iso(request.windowStart) && iso(request.windowEnd) && iso(request.observedAt)
      && request.windowStart < request.windowEnd && request.observedAt >= request.windowEnd,
    "Invalid bounded observation request");
    requireFact(!request.repository || request.repository.toLowerCase() === repository, "Unsupported repository");
    const sourceReady = request.windowEnd === cutoff;
    const inventories = sourceReady ? captures.filter(capture => capture.capturedAt === request.windowEnd) : [];
    const evidence = {
      ...definition.evidence, windowStart: request.windowStart, windowEnd: request.windowEnd,
      observedAt: request.observedAt, sourceReady, sourceProfile: revision,
      aliasMap: sourceReady ? aliases : null, inventories,
      measurementKind: "snapshot", coverageStatus: "missing",
      missingReason: sourceReady ? "Complete applicable independent provider inventories were not retained."
        : "No exact source/provider snapshot at the requested cutoff; current source is not backdated or carried forward.",
      maturityStatus: Date.parse(request.windowEnd) - Date.parse(activatedAt) < 86400000 ? "interim" : "mature",
      dubious: Date.parse(request.windowEnd) - Date.parse(activatedAt) < 86400000,
      fullAcceptance: null, workflowContribution: null, costs: null,
      baselineReadiness: retained.readiness.baseline,
    };
    if (sourceReady) {
      if (!memo.has(cutoff)) memo.set(cutoff, assessAliases(aliases, inventories));
      evidence.native = memo.get(cutoff);
      evidence.eligibleCount = evidence.native.eligibleCount;
      evidence.populationDigest = evidence.native.populationDigest;
      evidence.coverageStatus = evidence.native.coverageStatus;
      if (evidence.coverageStatus === "complete") delete evidence.missingReason;
      else if (evidence.coverageStatus === "partial") {
        evidence.missingReason = "Only a subset of aliases has independently established support or absence.";
      }
    }
    return { evidence, provenance: [
      { repository, kind: "immutable-source-profile", ref: `${revision}:.github/workflows/daily-model-inventory.md` },
      { repository, kind: "retained-input-sha256", ref: definition.sourceProfile.retainedSha256 },
      ...inventories.map(inventory => ({ repository, kind: "protected-provider-capture",
        ref: `${inventory.receipt.ref}#sha256=${inventory.receipt.sha256}` })),
    ], ...(sourceReady ? { commit: revision } : {}) };
  });
}
