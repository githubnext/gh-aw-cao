import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const sourcePath = ".github/workflows/step-name-alignment.md";
const glossaryPath = "docs/src/content/docs/reference/glossary.md";
const sourceBlob = "17e5d2e7270b0e3e185e670ce552bf8075c764b8";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const cutoff = "2026-10-18T15:00:12Z";
const eraAt = "2026-09-29T18:10:06Z";
const sourceSha256 = "6ae2dca511d567486345490656463431a210f4a3656184e2fb1a947c507ef234";
const nativeFile = fileURLToPath(new URL("../step-name-alignment/native-inputs.json.gz", import.meta.url));
const archiveOptions = { maxDecodedBytes: 256 * 1024 * 1024, maxParts: 1536 };
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(JSON.stringify(value));
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isFile = value => typeof value === "string" && /^\.github\/workflows\/(?:[\w.-]+\/)*[\w.-]+\.lock\.yml$/.test(value);

const rubyDecoder = String.raw`
require "json"
require "psych"
require "digest"
def canonical(x)
  case x
  when Hash
    x.keys.sort_by(&:to_s).each_with_object({}) { |k,h| h[k] = canonical(x[k]) }
  when Array
    x.map { |v| canonical(v) }
  else
    x
  end
end
def fingerprint(x)
  Digest::SHA256.hexdigest(JSON.generate(canonical(x)))
end
def validate_ast(node)
  raise "YAML aliases and anchors are unsupported" if node.is_a?(Psych::Nodes::Alias) || (node.respond_to?(:anchor) && node.anchor)
  if node.is_a?(Psych::Nodes::Mapping)
    keys = node.children.each_slice(2).map do |k,v|
      raise "Complex YAML keys are unsupported" unless k.is_a?(Psych::Nodes::Scalar)
      raise "YAML merge keys are unsupported" if k.value == "<<"
      k.value
    end
    raise "Duplicate YAML mapping key" unless keys.uniq.length == keys.length
  end
  (node.children || []).each { |child| validate_ast(child) } if node.respond_to?(:children)
end
request = JSON.parse(STDIN.read)
raise "Invalid native decoder request" unless request.is_a?(Array)
result = request.map do |item|
  begin
    text = item.fetch("content")
    raise "Non-string native YAML" unless text.is_a?(String)
    ast = Psych.parse_stream(text)
    raise "Expected one YAML document" unless ast.children.length == 1
    validate_ast(ast)
    value = Psych.safe_load(text, permitted_classes: [], permitted_symbols: [], aliases: false)
    raise "Expected workflow jobs mapping" unless value.is_a?(Hash) && value["jobs"].is_a?(Hash) && !value["jobs"].empty?
    workflow_context = value.reject { |k,v| ["jobs", "name", "run-name"].include?(k) }
    steps = []
    value["jobs"].each do |job_id,job|
      raise "Invalid job identity" unless job_id.is_a?(String) && job.is_a?(Hash)
      next if !job.key?("steps") && job["uses"].is_a?(String)
      raise "Expected job steps" unless job["steps"].is_a?(Array)
      ids = []
      job_context = job.reject { |k,v| ["steps", "name"].include?(k) }
      job["steps"].each_with_index do |step,index|
        raise "Invalid executable step" unless step.is_a?(Hash) && (step.key?("run") ^ step.key?("uses"))
        raise "Invalid executable content" unless (step["run"] || step["uses"]).is_a?(String)
        name = step["name"]
        raise "Invalid step name" unless name.nil? || name.is_a?(String)
        id = step["id"]
        raise "Invalid step id" unless id.nil? || id.is_a?(String)
        ids << id unless id.nil?
        steps << { "job" => job_id, "index" => index, "id" => id,
          "name" => name, "intentDigest" => fingerprint([workflow_context,job_context,step.reject { |k,v| k == "name" }]) }
      end
      raise "Duplicate step id" unless ids.uniq.length == ids.length
    end
    { "key" => item.fetch("key"), "steps" => steps }
  rescue Psych::Exception, KeyError, RuntimeError => error
    { "key" => item.fetch("key"), "error" => error.message }
  end
end
STDOUT.write(JSON.generate({ "engine" => "ruby/Psych", "version" => Psych::VERSION,
  "ruby" => RUBY_VERSION, "libyaml" => Psych::LIBYAML_VERSION, "results" => result }))
`;

const expectedParserVersion = "3.1.0";
const expectedRubyVersion = "2.6.10";
const expectedLibyamlVersion = "0.2.1";

export function decodeWorkflows(inputs) {
  if (!Array.isArray(inputs) || inputs.some(item => typeof item?.key !== "string"
    || typeof item.content !== "string" || Buffer.byteLength(item.content) > 8 * 1024 * 1024)
    || new Set(inputs.map(item => item.key)).size !== inputs.length) {
    throw new Error("Invalid bounded native YAML input");
  }
  const result = spawnSync("ruby", ["-e", rubyDecoder], {
    encoding: "utf8", input: JSON.stringify(inputs), maxBuffer: 128 * 1024 * 1024,
    timeout: 120000, env: { ...process.env, RUBYOPT: "", RUBYLIB: "", GEM_HOME: "", GEM_PATH: "" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Native YAML decoder failed: ${result.error?.message ?? result.stderr}`);
  }
  const decoded = JSON.parse(result.stdout);
  if (decoded.engine !== "ruby/Psych" || decoded.version !== expectedParserVersion
    || decoded.ruby !== expectedRubyVersion || decoded.libyaml !== expectedLibyamlVersion
    || !Array.isArray(decoded.results) || decoded.results.length !== inputs.length
    || decoded.results.some((row, i) => row.key !== inputs[i].key
      || !(typeof row.error === "string" || Array.isArray(row.steps)))) {
    throw new Error("Native YAML decoder/toolchain identity mismatch");
  }
  return decoded.results;
}

const rules = [
  { id: "frontmatter", heading: "Frontmatter", canonical: "frontmatter",
    pattern: /\bfront(?:[ -])matter\b/gi },
  { id: "agentic-workflow", heading: "Agentic Workflow", canonical: "agentic workflow",
    pattern: /\b(?:agent|agential) workflow(s?)\b/gi },
];

function glossaryTerms(text) {
  if (typeof text !== "string") return null;
  const sections = text.split(/(?=^### )/m);
  const terms = {};
  for (const rule of rules) {
    const section = sections.find(value => value.startsWith(`### ${rule.heading}\n`));
    if (!section || !section.slice(section.indexOf("\n") + 1).trim()) return null;
    terms[rule.id] = { heading: rule.heading, sectionSha256: hash(section), canonical: rule.canonical };
  }
  return terms;
}

function repairKinds(before, after) {
  if (typeof before !== "string" || typeof after !== "string" || before === after
    || before.includes("${{") || after.includes("${{")) return [];
  const applied = [];
  let corrected = before;
  for (const rule of rules) {
    corrected = corrected.replace(rule.pattern, (match, plural) => {
      applied.push(rule.id);
      const word = `${rule.canonical}${rule.id === "agentic-workflow" && plural === "s" ? "s" : ""}`;
      return /^[A-Z]/.test(match) ? word[0].toUpperCase() + word.slice(1) : word;
    });
  }
  return corrected === after ? [...new Set(applied)].sort() : [];
}

function validSteps(steps) {
  return Array.isArray(steps) && steps.every(row => typeof row?.job === "string" && row.job
    && Number.isSafeInteger(row.index) && row.index >= 0
    && (row.id === null || typeof row.id === "string")
    && (row.name === null || typeof row.name === "string")
    && sha256(row.intentDigest))
    && new Set(steps.map(row => `${row.job}\0${row.index}`)).size === steps.length;
}

export function compareSteps(before, after) {
  if (!validSteps(before) || !validSteps(after)) return null;
  const key = row => `${row.job}\0${row.intentDigest}`;
  const group = steps => {
    const result = new Map();
    for (const step of steps) result.set(key(step), [...(result.get(key(step)) ?? []), step]);
    return result;
  };
  const left = group(before), right = group(after);
  const repairs = [], regressions = [];
  let comparableSteps = 0, ambiguousSteps = 0;
  for (const [identity, previous] of left) {
    const next = right.get(identity);
    if (!next) continue;
    if (previous.length !== 1 || next.length !== 1) {
      ambiguousSteps += previous.length;
      continue;
    }
    comparableSteps++;
    const old = previous[0], current = next[0];
    const corrected = repairKinds(old.name, current.name);
    const regressed = repairKinds(current.name, old.name);
    if (corrected.length) repairs.push({ job: old.job, beforeIndex: old.index, afterIndex: current.index,
      id: old.id, intentDigest: old.intentDigest, before: old.name, after: current.name, rules: corrected });
    if (regressed.length) regressions.push({ job: old.job, beforeIndex: old.index, afterIndex: current.index,
      id: old.id, intentDigest: old.intentDigest, before: old.name, after: current.name, rules: regressed });
  }
  return { comparableSteps, ambiguousSteps, repairs, regressions };
}

export const interpreterIdentity = digest([
  rubyDecoder, expectedParserVersion, expectedRubyVersion, expectedLibyamlVersion,
  rules.map(rule => ({ ...rule, pattern: rule.pattern.source })),
  decodeWorkflows.toString(), glossaryTerms.toString(), repairKinds.toString(), validSteps.toString(),
  compareSteps.toString(), validateEvidence.toString(), scoreMetric.toString(), loadNative.toString(),
  checkRequest.toString(), collectBatch.toString(),
]);

const fixtureDigest = hash("native-fixture-unchanged-execution");
const fixtureSteps = name => [{ job: "agent", index: 0, id: "parse", name, intentDigest: fixtureDigest }];
const fixturePair = (before, after, suffix) => ({
  commit: hash(`commit-${suffix}`).slice(0, 40), parent: hash(`parent-${suffix}`).slice(0, 40),
  at: "2026-10-01T00:00:00Z", path: `.github/workflows/${suffix}.lock.yml`,
  beforeBlob: hash(`before-${suffix}`).slice(0, 40), afterBlob: hash(`after-${suffix}`).slice(0, 40),
  before: fixtureSteps(before), after: fixtureSteps(after),
});
const fixtureGlossary = "### Frontmatter\nConfiguration at the top of a workflow.\n\n### Agentic Workflow\nAI-powered repository automation.\n";
const example = repairs => ({
  nativeContract: "glossary-spelling-facet-v1", glossary: glossaryTerms(fixtureGlossary),
  windowStart: "2026-09-30T15:00:12Z", windowEnd: "2026-10-07T15:00:12Z",
  nativePairs: [fixturePair("Parse front matter", repairs ? "Parse frontmatter" : "Parse front matter", "parse"),
    fixturePair("Generate agent workflow", repairs ? "Generate agentic workflow" : "Generate agent workflow", "generate")],
  coverageStatus: "complete",
});
const metric = (id, name, role, formula, unit, legendLabel) => ({
  id, name, role, formula, direction: "increase", unit,
  presentation: { name, legendLabel, transform: "identity" },
});

export const definition = {
  schemaVersion: 3, slug: "step-name-alignment", repository: "github/gh-aw",
  workflowName: "Step Name Alignment", sourcePath,
  intent: {
    goal: "Maintain consistent, accurate, descriptive compiled workflow step names under project terminology.",
    acceptance: "An immutable first-parent change replaces an explicit noncanonical project term with its glossary form, changes no other name wording, and preserves the parsed executable step and execution context. This verifies spelling only, not complete semantic naming quality.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "8705ccfc3f1113fde75ac041aa73e177c5b57603", adoptedAt: "2026-01-13T14:26:57Z",
    baselineCommit: "8b9ecffc4e5fa3e8a16072c359f37e74a969afcd", baselineAt: "2026-01-13T13:49:33Z",
  },
  evaluation: { mode: "attainment-only",
    reason: "Naming defects pre-existed adoption. Adoption source/lock blobs are missing; no valid pre-adoption repair observation or historical semantic oracle is established." },
  sourceIdentity: {
    repositoryId: 1036865607, revision, cutoff, gitBlob: sourceBlob, sha256: sourceSha256,
    profileStart: eraAt, interpreterSha256: interpreterIdentity,
    parser: "Ruby 2.6.10 / Psych 3.1.0 / libyaml 0.2.1",
    codecSha256: "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b",
    sourcePolicy: "Only the exact frozen workflow/import profile with contemporaneously readable glossary terms is interpreted. Earlier eras remain unknown, not backdated current policy.",
    imports: [
      { path: ".github/workflows/shared/reporting.md", blob: "263d2413472e62582c578897a8b06462da5ef171" },
      { path: ".github/workflows/shared/otlp.md", blob: "f68eee05a7f9d4379511148f65aa2ed8bf7667dd" },
      { path: ".github/workflows/shared/ai-coding-dictionary.md", blob: "50d7cc06d563bdb36ae31efa9f227d2c254bca58" },
    ],
    rules: [
      { id: "frontmatter", independentHeading: "Frontmatter", variants: ["front matter", "front-matter"], replacement: "frontmatter" },
      { id: "agentic-workflow", independentHeading: "Agentic Workflow", variants: ["agent workflow", "agential workflow"], replacement: "agentic workflow", plurals: true },
    ],
  },
  evidence: {
    key: "step-name-alignment-native-glossary-repairs-v1",
    repositories: ["github/gh-aw"],
    opportunity: "Statically named executable .github/workflows/**/*.lock.yml step occurrences changed on the frozen first-parent repository history, matched uniquely within a file/job by the complete parsed non-name execution context.",
    filters: [
      "Exclude deleted/added/unmatched steps, changed executable context, ambiguous duplicate contexts and dynamic names from accepted repairs; retain their missing/unsupported scope.",
      "Only exact canonical replacement of glossary-backed variants; style, generic clarity, casing preferences and arbitrary abbreviations are not lexical corrections.",
      "Current source profile only. No claim that a missing object, issue, PR merge, editable marker or successful run proves improvement.",
      "One repaired occurrence per file/job/unchanged context at its delivery commit, even when two term rules apply. Compiled occurrences are not deduplicated into presumed compiler templates.",
      "Disjoint windows use inclusive start/exclusive end and committer time on retained first-parent history; later acquisition timestamps are provenance, not historical outcomes.",
    ],
    collection: "Read the portable digest-checked immutable Git archive once per process, decode actual workflow YAML with pinned safe Psych, compare unique unchanged execution contexts and independent glossary headings. Reuse the native projections for all requested windows. No GitHub/API/database queries or execution of target code.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Source-grounded deterministic partial native terminology instrument; whole-period total, semantic quality, safeguards and contribution remain separate from observed lexical repair subtotals.",
    recommendation: "Not rated: no source-derived keep bar, weights, target or cost model. Incomplete coverage never establishes zero total delivery.",
    presentation: { label: "Observed glossary spelling repairs", betterLabel: "More verified repairs, not more reports" },
  },
  summary: { nativeLabel: "Verified spelling repairs in readable unchanged compiled step occurrences; not full semantic acceptance or attributable value." },
  metrics: [
    metric("glossary-repairs", "Observed glossary spelling repairs", "primary",
      "Count distinct uniquely matched compiled step occurrences whose only name change replaces one or more explicit glossary-backed variant spellings with canonical terms; each occurrence counts once. A partial subtotal is not the unknown complete-period total.",
      "step occurrences", "Spelling repairs"),
    metric("frontmatter-repairs", "Observed frontmatter spelling repairs", "diagnostic",
      "Count the accepted native repair occurrences containing a front matter/front-matter to frontmatter replacement.", "step occurrences", "Frontmatter repairs"),
    metric("agentic-workflow-repairs", "Observed agentic workflow term repairs", "diagnostic",
      "Count the accepted native repair occurrences containing agent/agential workflow to agentic workflow replacement.", "step occurrences", "Agentic term repairs"),
  ],
  metricDispositions: {
    primary: "Repository-native lexical improvement counts regardless of actor and without any workflow output.",
    nativeManifestStepCount: "Opportunity inventory diagnostic only; a manifest contains names and action_uses, not independently established intent or accepted repairs.",
    consistencyAccuracyClarity: "Full semantic dimensions unknown without independent intent adjudication; not replaced by name-change volume.",
    issueCountsAndRunSummaries: "Rejected output/engagement proxies.",
    cacheReviewCadenceAndTopCandidates: "Mechanism/runtime optimization, not outcome eligibility or value thresholds.",
    sourceVsCompiled: "Measure real compiled step occurrences; source/compiler origin and broad functional regression acceptance remain unverified.",
    aiCodingDictionary: "Secondary URL only, no retained independent content; no generic-AI dictionary rule is inferred.",
  },
  limitations: [
    "Only two explicitly source-backed terminology spellings are implemented. This is not a general semantic naming oracle.",
    "The full historical opportunity population and period totals are unknown through missing native blobs and earlier intent profiles.",
    "Native repair diagnostics can be numeric under partial coverage; complete period totals, full semantic quality and contribution remain null.",
    "Current inventory is a cutoff snapshot, never fresh delivered value in later periods.",
    "Lineage acquired after cutoff preserves discovery only; current mutable state and creation markers are not backdated.",
    "A repeated repair after a genuine regression is a separate repair transition; retained repairs are not recounted in later periods.",
  ],
  validationExamples: {
    targetAttained: example(true), targetMissed: example(false), missing: {},
    malformed: { ...example(true), nativePairs: "not native steps" },
  },
};

function validateEvidence(evidence) {
  if (!evidence || evidence.nativeContract !== "glossary-spelling-facet-v1"
    || !iso(evidence.windowStart) || !iso(evidence.windowEnd)
    || Date.parse(evidence.windowStart) >= Date.parse(evidence.windowEnd)
    || !["complete", "partial"].includes(evidence.coverageStatus)
    || !Array.isArray(evidence.nativePairs) || evidence.nativePairs.length === 0
    || !rules.every(rule => evidence.glossary?.[rule.id]?.canonical === rule.canonical
      && evidence.glossary?.[rule.id]?.heading === rule.heading
      && sha256(evidence.glossary?.[rule.id]?.sectionSha256))) return null;
  const keys = new Set(), results = [];
  for (const pair of evidence.nativePairs) {
    if (!sha(pair?.commit) || !sha(pair.parent) || !sha(pair.beforeBlob) || !sha(pair.afterBlob)
      || !iso(pair.at) || pair.at < evidence.windowStart || pair.at >= evidence.windowEnd
      || !isFile(pair.path)) return null;
    const key = `${pair.commit}\0${pair.path}`;
    if (keys.has(key)) return null;
    keys.add(key);
    const compared = compareSteps(pair.before, pair.after);
    if (!compared) return null;
    results.push({ ...compared, pair });
  }
  return results;
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) return null;
  const results = validateEvidence(evidence);
  if (!results) return null;
  const ruleId = id === "frontmatter-repairs" ? "frontmatter"
    : id === "agentic-workflow-repairs" ? "agentic-workflow" : null;
  return results.reduce((sum, result) => sum + result.repairs.filter(repair =>
    ruleId === null || repair.rules.includes(ruleId)).length, 0);
}

const loaded = new Map();
function loadNative(file) {
  if (loaded.has(file)) return loaded.get(file);
  const archive = readJsonArchive(file, archiveOptions);
  if (archive?.kind !== "step-name-alignment-native-inputs" || archive.schemaVersion !== 1
    || archive.frozen?.repository !== definition.repository || archive.frozen?.repositoryId !== 1036865607
    || archive.frozen?.revision !== revision || archive.frozen?.cutoff !== cutoff
    || archive.frozen?.sourceBlob !== sourceBlob || !Array.isArray(archive.changes)
    || !Array.isArray(archive.currentFiles) || !archive.profiles || !archive.blobs
    || !archive.history?.index?.complete || archive.history.index.totalEntities !== 58048
    || !Array.isArray(archive.history.selectedEntities)) throw new Error("Native input scope/schema mismatch");
  for (const [id, blob] of Object.entries(archive.blobs)) {
    if (!sha(id) || blob.blob !== id || !["missing", "readable"].includes(blob.status)) {
      throw new Error("Malformed native content descriptor");
    }
    if (blob.status === "readable") {
      if (typeof blob.content !== "string" || hash(blob.content) !== blob.sha256) {
        throw new Error("Native content SHA-256 mismatch");
      }
      const bytes = Buffer.from(blob.content);
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== id) {
        throw new Error("Native content Git blob identity mismatch");
      }
    }
  }
  if (archive.blobs[sourceBlob]?.sha256 !== sourceSha256) throw new Error("Frozen native source missing");
  const sourceGlossary = archive.sources.find(row => row.path === glossaryPath);
  const terms = glossaryTerms(archive.blobs[sourceGlossary?.blob]?.content);
  if (!terms) throw new Error("Independent source glossary unavailable");
  const nativeIds = new Set(archive.currentFiles.map(row => row.blob));
  const commits = new Set();
  for (const commit of archive.changes) {
    if (!sha(commit.commit) || commits.has(commit.commit) || !sha(commit.parents?.[0])
      || !iso(commit.at) || commit.at >= cutoff || !Array.isArray(commit.changes)) {
      throw new Error("Invalid native transition identity/temporal closure");
    }
    commits.add(commit.commit);
    for (const change of commit.changes) {
      if (!isFile(change.path)) throw new Error("Out-of-scope native change");
      for (const id of [change.beforeBlob, change.afterBlob]) if (id) nativeIds.add(id);
    }
  }
  const available = [...nativeIds].filter(id => archive.blobs[id]?.status === "readable");
  const projections = new Map();
  for (let offset = 0; offset < available.length; offset += 32) {
    const inputs = available.slice(offset, offset + 32).map(id => ({ key: id, content: archive.blobs[id].content }));
    for (const row of decodeWorkflows(inputs)) projections.set(row.key, row);
  }
  const acceptedProfiles = new Map();
  for (const [commit, profile] of Object.entries(archive.profiles)) {
    const workflow = profile.find(row => row.path === sourcePath);
    const glossary = profile.find(row => row.path === glossaryPath);
    const observedTerms = glossaryTerms(archive.blobs[glossary?.blob]?.content);
    const importsAgree = definition.sourceIdentity.imports.every(expected => profile.some(row =>
      row.path === expected.path && row.blob === expected.blob && archive.blobs[row.blob]?.status === "readable"));
    acceptedProfiles.set(commit, workflow?.blob === sourceBlob && importsAgree && observedTerms
      && rules.every(rule => observedTerms[rule.id].sectionSha256 === terms[rule.id].sectionSha256));
  }
  const value = { archive, projections, acceptedProfiles, terms };
  loaded.set(file, value);
  return value;
}

function checkRequest(request) {
  if (!request || !iso(request.windowStart) || !iso(request.windowEnd) || !iso(request.observedAt)
    || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
    || (request.repository !== undefined && request.repository !== definition.repository)) {
    throw new Error("Invalid bounded step-name-alignment window/repository");
  }
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests)) throw new Error("Expected native observation batch");
  requests.forEach(checkRequest);
  if (requests.length === 0) return [];
  const file = context.nativeArchive ?? nativeFile;
  const { archive, projections, acceptedProfiles, terms } = loadNative(file);
  return requests.map(request => {
    const withinFrozenScope = request.windowEnd <= cutoff && request.windowStart >= eraAt;
    const nativePairs = [], unavailable = [], events = [];
    const transitions = archive.changes.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
    for (const commit of transitions) {
      for (const change of commit.changes) {
        const key = { commit: commit.commit, parent: commit.parents[0], at: commit.at, path: change.path,
          beforeBlob: change.beforeBlob, afterBlob: change.afterBlob };
        if (commit.at < eraAt || commit.at >= cutoff || !acceptedProfiles.get(commit.commit)
          || !acceptedProfiles.get(commit.parents[0])) {
          unavailable.push({ ...key, reason: "Contemporaneous source/import/glossary profile not accepted." });
          continue;
        }
        if (!change.beforeBlob || !change.afterBlob) {
          unavailable.push({ ...key, reason: "Added/deleted file cannot establish an unchanged-step repair." });
          continue;
        }
        if (change.beforeMode !== "100644" || change.afterMode !== "100644") {
          unavailable.push({ ...key, reason: "Unsupported native file mode." });
          continue;
        }
        const before = projections.get(change.beforeBlob), after = projections.get(change.afterBlob);
        if (!before?.steps || !after?.steps) {
          unavailable.push({ ...key, reason: before?.error ?? after?.error ?? "Required immutable native blob is missing." });
          continue;
        }
        const pair = { ...key, before: before.steps, after: after.steps };
        nativePairs.push(pair);
        for (const repair of compareSteps(pair.before, pair.after).repairs) events.push({
          id: digest([commit.commit, change.path, repair.job, repair.intentDigest]), at: commit.at,
          path: change.path, commit: commit.commit, ...repair,
        });
      }
    }
    const observed = nativePairs.length > 0;
    const coverageStatus = withinFrozenScope && unavailable.length === 0 ? "complete"
      : observed ? "partial" : "missing";
    const evidence = {
      ...definition.evidence, ...request, nativeContract: "glossary-spelling-facet-v1",
      glossary: terms, nativePairs, events, unavailable,
      coverageStatus, eligibleCount: null, populationDigest: null,
      examinedFileTransitions: nativePairs.length, discoveredFileTransitions: transitions.reduce((sum, row) => sum + row.changes.length, 0),
      completePeriodRepairTotal: null,
      maturityStatus: Date.parse(request.windowEnd) - Date.parse(request.windowStart) < 7 * 86400000
        ? "interim" : "mature",
      dubious: coverageStatus !== "complete"
        || Date.parse(request.windowEnd) - Date.parse(request.windowStart) < 7 * 86400000,
      missingReason: coverageStatus === "complete" ? null : !withinFrozenScope
        ? "Requested period is not wholly within the frozen readable current-source era. Any retained native subtotal covers accepted contemporaneous pairs only; other historical/prospective facts remain unknown."
        : "Only readable unchanged native step pairs are assessed; unavailable objects/profiles prevent a complete period total.",
      fullSemanticQuality: { value: null, reason: "No independent complete name-to-intent, consistency/clarity or regression adjudication." },
      workflowContribution: { value: null, reason: "Retained issue/run markers and candidate body references do not independently prove original production or downstream accepted contribution." },
      lineage: {
        selectedEntities: archive.history.selectedEntities.length,
        originalMarkerCandidates: archive.history.selectedEntities.filter(row =>
          row.workflowReference?.workflowId === definition.slug || row.unverifiedWorkflowId === definition.slug).length,
        archive: "native-inputs.json.gz#/history", outcomesInferred: false,
      },
      readiness: {
        producerDecoding: true,
        nativeEvidence: observed,
        completeNativePeriod: coverageStatus === "complete",
        fullFunction: false,
      },
    };
    const scores = definition.metrics.map(metric => scoreMetric(metric.id, evidence));
    if (coverageStatus === "complete" && !observed) {
      evidence.coverageStatus = "unknown";
      evidence.missingReason = "No replayable native transition observation establishes a denominator or zero delivery.";
      evidence.readiness.completeNativePeriod = false;
      evidence.dubious = true;
    }
    if (evidence.coverageStatus === "complete" && scores[0] !== null) evidence.completePeriodRepairTotal = scores[0];
    return {
      evidence,
      provenance: [
        { repository: definition.repository, kind: "immutable-source", ref: `${revision}:${sourcePath}:${sourceBlob}` },
        { repository: definition.repository, kind: "immutable-native-inputs", ref: `sha256:${digest({
          revision, cutoff, changes: transitions.map(row => row.commit), sourceBlob, interpreterIdentity,
        })}` },
        { repository: definition.repository, kind: "native-interpreter", ref: `sha256:${interpreterIdentity}:ruby-Psych-${expectedParserVersion}` },
        { repository: definition.repository, kind: "later-discovery-only", ref: `sha256:${digest(archive.history.index)}:no-outcome-inference` },
      ],
    };
  });
}
