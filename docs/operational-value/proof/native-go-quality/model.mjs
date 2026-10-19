import { readFileSync } from "node:fs";
import { analyze, transitions } from "./native.mjs";
import { apiOriginals, base, cutoff, gitId, readCustody, readJson, repository, revision, sha256, verifyLock } from "./custody.mjs";

let evaluated;
export function evaluateNative() {
  if (evaluated) return evaluated;
  const custody = readCustody(), originals = apiOriginals();
  const inputs = new Map();
  function input(commit, file) {
    if (!custody.has(commit, file)) return null;
    const text = custody.source(commit, file);
    if (text === null) return null;
    const id = `${commit}:${file}`;
    inputs.set(id, { id, text });
    return id;
  }
  const pairs = [];
  for (const row of custody.data.implementations) {
    if (!row.paths || !row.parent) { pairs.push({ ...row, unavailable: true }); continue; }
    const actual = custody.commit(row.commit);
    if (actual.parents[0] !== row.parent || actual.at > cutoff || row.mergedAt >= cutoff) throw new Error("Not an actual in-cutoff first-parent transition");
    for (const file of row.paths) pairs.push({ ...row, file, before: input(row.parent, file), after: input(row.commit, file),
      runtime: row.slug === "go-logger" ? input(row.parent, "pkg/logger/logger.go") : null });
  }
  const healthCommit = "c5f36dd7a6c6309dead5ba037920324d08419ca5";
  const healthParent = custody.commit(healthCommit).parents[0];
  for (const commit of [healthParent, healthCommit]) {
    const mod = custody.source(commit, "go.mod");
    for (const [name, version] of [["github.com/spf13/cobra", "v1.10.2"], ["github.com/spf13/pflag", "v1.0.10"], ["github.com/stretchr/testify", "v1.11.1"]]) {
      if (!mod.includes(`${name} ${version}`) || new RegExp(`^replace\\s+${name.replaceAll(".", "\\.")}\\b`, "m").test(mod)) throw new Error("Unverified actual dependency pin");
    }
  }
  const health = input(healthCommit, "pkg/cli/health_command.go");
  const standards = originals.filter(row => row.file.startsWith("standard-") && row.body.content);
  for (const row of standards) {
    const bytes = Buffer.from(row.body.content, "base64");
    if (row.body.encoding !== "base64" || bytes.length !== row.body.size || gitId("blob", bytes) !== row.body.sha) throw new Error("Dependency source custody mismatch");
    inputs.set(row.file, { id: row.file, text: bytes.toString() });
  }
  const parsed = new Map(analyze([...inputs.values()]).map(row => [row.id, row]));
  const witness = analyze([{ id: "independent-local-witness", text: "package witness", mode: "failure-containment-witness" }])[0].witness;
  if (!witness?.nonfatalContinuationPanics || !witness.fatalContinuationAvoidsPanic) throw new Error("Independent Go failure-containment witness failed");
  const getStandard = name => parsed.get(`standard-${name}.json.gz`);
  const cobra = getStandard("cobra-command.go"), pflag = getStandard("pflag-flag.go");
  const require = getStandard("testify-require-require.go"), assert = getStandard("testify-assert-assertions.go");
  const declaration = (row, name, receiver = "") => row?.valid && row.declarations.find(d => d.name === name && d.receiver === receiver);
  const flags = declaration(cobra, "Flags", "*Command"), lookup = declaration(pflag, "Lookup", "*FlagSet");
  const fatal = declaration(require, "NotNil"), nonfatal = declaration(assert, "NotNil");
  const constructor = declaration(parsed.get(health), "NewHealthCommand");
  const standardProof = Boolean(flags?.type === "func() *flag.FlagSet"
    && cobra.imports["github.com/spf13/pflag"] === "flag" && lookup?.type === "func(name string) *Flag"
    && pflag.structFields.Flag?.DefValue === "string"
    && require.imports["github.com/stretchr/testify/assert"] === "assert"
    && fatal?.body === "{\n\tif h, ok := t.(tHelper); ok {\n\t\th.Helper()\n\t}\n\tif assert.NotNil(t, object, msgAndArgs...) {\n\t\treturn\n\t}\n\tt.FailNow()\n}"
    && nonfatal?.body === "{\n\tif !isNil(object) {\n\t\treturn true\n\t}\n\tif h, ok := t.(tHelper); ok {\n\t\th.Helper()\n\t}\n\treturn Fail(t, \"Expected value not to be nil.\", msgAndArgs...)\n}"
    && constructor?.type === "func() *cobra.Command"
    && parsed.get(health).imports["github.com/spf13/cobra"] === "cobra");
  if (!standardProof) throw new Error("Native pointer/fatal assertion source semantics are not established");
  const byImplementation = new Map();
  const dedup = new Set();
  for (const pair of pairs) {
    const key = `${pair.slug}:${pair.commit ?? pair.number}`;
    const row = byImplementation.get(key) ?? { id: key, slug: pair.slug, number: pair.number, commit: pair.commit,
      parent: pair.parent ?? null, at: pair.mergedAt ?? null, issues: pair.issues ?? [], value: null,
      sites: [], files: [], missing: [], corroborated: false, receiptBacked: null };
    byImplementation.set(key, row);
    if (pair.slug === "go-pattern-detector") {
      row.missing.push("Original dead-display-field recommendation and native before/after source retained, but the frozen required-JSON-field restoration condition has no independent consumer expectation.");
      continue;
    }
    if (pair.unavailable || !pair.before || !pair.after) { row.missing.push(pair.file ?? "missing implementation"); continue; }
    const before = parsed.get(pair.before), after = parsed.get(pair.after);
    const comparison = transitions(before, after, pair.slug);
    if (comparison.value === null || (pair.slug === "go-logger" && !parsed.get(pair.runtime)?.loggerRuntime)) {
      row.missing.push(pair.file); continue;
    }
    row.files.push({ file: pair.file, before: custody.resolve(pair.parent, pair.file), after: custody.resolve(pair.commit, pair.file),
      candidateTransitions: comparison.sites.length });
    if (row.value === null) row.value = 0;
    for (const site of comparison.sites) {
      if (pair.slug === "daily-testify-uber-super-expert"
        && (site.field !== "DefValue" || !/^cmd\.Flags\(\)\.Lookup\("(?:days|threshold)"\)$/.test(site.initializer)
          || pair.commit !== healthCommit || site.function !== "TestHealthCommand")) continue;
      const identity = `${pair.commit}:${pair.file}:${site.identity}`;
      if (dedup.has(identity)) continue;
      dedup.add(identity);
      row.value++;
      row.sites.push({ ...site, file: pair.file, identity });
    }
  }
  const rows = [...byImplementation.values()];
  const testifyIssue = originals.filter(row => row.file.startsWith("issues-")).flatMap(row =>
    Object.values(row.body.data.repository).filter(issue => issue?.number === 28585))[0];
  const discoveryIssue = readJson(new URL("discovery.json.gz", base)).direct["daily-testify-uber-super-expert"].find(row => row.number === 28585);
  for (const row of rows) {
    if (row.slug !== "daily-testify-uber-super-expert" || row.value <= 0) continue;
    const graph = testifyIssue?.timelineItems.nodes.find(event => {
      const pull = event.source ?? event.subject;
      return pull?.number === row.number && pull.mergeCommit?.oid === row.commit
        && event.createdAt <= row.at && event.createdAt < cutoff;
    });
    row.corroborated = row.issues.includes(28585) && Boolean(graph) && typeof testifyIssue?.body === "string"
      && sha256(Buffer.from(testifyIssue.body)) === discoveryIssue?.bodySha256
      && testifyIssue.body.includes("daysFlag.DefValue") && testifyIssue.body.includes("require.NotNil")
      && testifyIssue.body.includes("threshold") && testifyIssue.url === "https://github.com/github/gh-aw/issues/28585";
    if (!row.corroborated) throw new Error("Accepted improvement lacks retained recommendation corroboration");
    row.corroboration = { issue: 28585, pullRequest: row.number, graphEventAt: graph.createdAt,
      bodySha256: discoveryIssue.bodySha256, bodyObservedAt: discoveryIssue.observedAt,
      qualification: "Dated GitHub graph and unchanged discovery/current body corroborate shared contribution; neither is a creation receipt or proof of historical body contents." };
  }
  const pattern = originals.find(row => row.file === "pattern-issue-4145.json.gz")?.body;
  const patternGap = pattern ? {
    number: 4145, reason: "Unmarked historical detector issue recommends removing apparently dead excluded display fields, not restoring a required JSON field. Its prose is not independent native acceptance; the frozen JSON-restoration facet does not measure dead-field correctness.",
    status: "unmeasured-outside-frozen-facet", strictFullGoalAcceptance: null,
  } : { reason: "No retained independent required-JSON-field case", status: "missing" };
  evaluated = { rows, custody, standardProof, witness, patternGap, parsedFiles: parsed.size,
    invalidFiles: [...parsed.values()].filter(row => !row.valid).map(row => row.id) };
  return evaluated;
}

const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value));
export const validWindow = row => row && [row.windowStart, row.windowEnd, row.observedAt].every(iso)
  && row.windowStart < row.windowEnd && row.windowEnd <= row.observedAt
  && (row.repository === undefined || row.repository === repository);

export function qualityModule(config) {
  for (const [file, digest] of Object.entries(config.bindings)) {
    if (sha256(readFileSync(new URL(file, base))) !== digest) throw new Error(`Frozen native interpreter changed: ${file}`);
  }
  verifyLock();
  const contracts = readJson(new URL("contracts-v1.json", base));
  const version = readJson(new URL("contract-v2.json", base));
  if (version.predecessor.sha256 !== sha256(readFileSync(new URL("contracts-v1.json", base)))) throw new Error("Frozen predecessor mismatch");
  const contract = contracts.contracts.find(row => row.slug === config.slug);
  if (!contract) throw new Error("Unknown quality instrument");
  const data = readJson(new URL("custody.json.gz", base));
  const workflow = data.workflows.find(row => row.slug === config.slug);
  const metric = (id, name, role, legend) => ({ id, name, role, unit: contract.unit, direction: "increase",
    formula: id === "native-partial" ? "Sum independently source-verified useful partial sites in retained actual-parent implementations in this disjoint interval; no evaluated cases means null."
      : "The same independently verified native sites with retained original recommendation and downstream graph corroboration; not receipt-backed or exclusive causation.",
    presentation: { name, legendLabel: legend, transform: "identity" } });
  const loggerExample = guarded => ({
    kind: "native-validation-input", before: 'package p\nimport "github.com/github/gh-aw/pkg/logger"\nvar log=logger.New("p:f")\nfunc Run(){log.Printf("%s", makeText())}\n',
    after: `package p\nimport "github.com/github/gh-aw/pkg/logger"\nvar log=logger.New("p:f")\nfunc Run(){${guarded ? 'if log.Enabled(){log.Printf("%s", makeText())}' : 'log.Printf("%s", makeText())'}}\n`,
  });
  const testExample = fatal => ({
    kind: "native-validation-input", before: 'package p\nimport("testing";"github.com/stretchr/testify/assert";"github.com/stretchr/testify/require")\nfunc TestNative(t *testing.T){daysFlag:=cmd.Flags().Lookup("days");assert.NotNil(t,daysFlag);assert.Equal(t,"7",daysFlag.DefValue)}\n',
    after: `package p\nimport("testing";"github.com/stretchr/testify/assert";"github.com/stretchr/testify/require")\nfunc TestNative(t *testing.T){daysFlag:=cmd.Flags().Lookup("days");${fatal ? "require" : "assert"}.NotNil(t,daysFlag);assert.Equal(t,"7",daysFlag.DefValue)}\n`,
  });
  // JSON-restoration validation requires the independent expected bytes, not a tag count.
  const patternExample = attained => ({ kind: "native-json-validation", input: { expected: '{"Name":"value"}',
    before: 'package p\ntype Record struct { Name string `json:"-"` }\n',
    after: `package p\ntype Record struct { Name string \`json:"${attained ? "Name" : "-"}"\` }\n` } });
  const example = config.slug === "go-logger" ? loggerExample : config.slug === "go-pattern-detector" ? patternExample : testExample;
  const definition = {
    schemaVersion: 3, slug: config.slug, repository, workflowName: `${config.slug} — native quality outcome assessment`,
    sourcePath: `.github/workflows/${config.slug}.md`,
    intent: { goal: contract.goal, acceptance: contract.partialAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: { commit: workflow.adoption.commit, adoptedAt: workflow.adoption.adoptedAt, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only" },
    evidence: { key: `${config.slug}-native-quality-v2`, repositories: [repository], opportunity: contract.partialAcceptance,
      filters: ["Selected issue/PR discovery and actual-parent implementations; incomplete total output population.",
        "No-case periods remain null; zero is only a checked selected-case facet, not zero workflow value.",
        "Original full goal remains unknown; no target code, tests or workflows executed."],
      collection: "Dependency-free offline replay of original Git Merkle paths, exact public graph responses and independent Go AST analysis.",
      measurementKind: "interval", window: contracts.period, interpreterBindings: config.bindings,
      authoring: version.authoring, sourceReference: revision, sourceIntroductionIsNotExecutorContinuity: true },
    model: { architecture: "Frozen goal-native AST predicates and independent pinned library semantics, not output/merge counting.",
      recommendation: "Not rated: no agreed native keep bar, complete comparable periods, cost evidence or creation receipts.",
      presentation: { label: contract.unit, betterLabel: "More independently established useful partial sites" } },
    summary: { nativeLabel: contract.unit },
    metrics: [metric("native-partial", contract.unit, "primary", "Native partial sites"),
      metric("corroborated-partial", "Corroborated shared contribution", "diagnostic", "Corroborated sites")],
    signal: { metricId: "corroborated-partial", basis: "workflow-contribution" },
    validationExamples: { targetAttained: example(true), targetMissed: example(false), missing: {},
      malformed: { kind: "native-validation-input", before: 4, after: false } },
    limitations: { fullGoalAcceptance: null, strictAcceptanceRule: contract.strictAcceptance,
      safeguards: null, wholePopulationPeriodTotals: null, historicalExecutorContinuity: null,
      receiptBackedContribution: null, actualCosts: null, keepDecision: "not rated",
      predecessor: "contracts-v1.json", finiteUsefulOutcomeRequiredForMeasuredStatus: true,
      patternDetectionGap: config.slug === "go-pattern-detector" ? "Historical unmarked issue 4145 is retained but native correctness and downstream outcome are not established by the JSON-restoration facet." : null },
  };
  function select(request) {
    return evaluateNative().rows.filter(row => row.slug === config.slug && row.at >= request.windowStart && row.at < request.windowEnd);
  }
  function scoreMetric(id, evidence) {
    if (!definition.metrics.some(row => row.id === id) || !evidence) return null;
    if (evidence.kind === "native-validation-input") {
      if (typeof evidence.before !== "string" || typeof evidence.after !== "string") return null;
      return transitions(...analyze([{ id: "before.go", text: evidence.before }, { id: "after.go", text: evidence.after }]), config.slug).value;
    }
    if (evidence.kind === "native-json-validation" && config.slug === "go-pattern-detector") {
      const input = evidence.input;
      if (!input || ![input.expected, input.before, input.after].every(value => typeof value === "string")) return null;
      const [before, after] = analyze([{ id: "before.go", text: input.before }, { id: "after.go", text: input.after }]);
      return before.valid && after.valid && typeof before.jsonProjection === "string" && typeof after.jsonProjection === "string"
        ? Number(before.jsonProjection !== input.expected && after.jsonProjection === input.expected) : null;
    }
    if (evidence.kind !== "native-quality-cases" || evidence.instrument !== config.instrument
      || !validWindow(evidence) || evidence.windowStart < workflow.adoption.adoptedAt || evidence.windowEnd > cutoff) return null;
    const rows = select(evidence);
    if (JSON.stringify(evidence.caseIds) !== JSON.stringify(rows.map(row => row.id))) return null;
    const known = rows.filter(row => row.value !== null && (id === "native-partial" || row.corroborated));
    return known.length ? known.reduce((sum, row) => sum + row.value, 0) : null;
  }
  async function collectBatch(requests) {
    if (!Array.isArray(requests) || !requests.every(validWindow)) throw new Error("Invalid quality windows or repository");
    return requests.map(request => {
      const inScope = request.windowStart >= workflow.adoption.adoptedAt && request.windowEnd <= cutoff;
      const rows = inScope ? select(request) : [];
      return { evidence: { ...request, kind: "native-quality-cases", instrument: config.instrument,
        caseIds: rows.map(row => row.id), nativeFacts: rows.map(row => ({
          id: row.id, at: row.at, nativeValue: row.value, sites: row.sites, missing: row.missing,
          corroboratedSharedContribution: row.corroborated, receiptBacked: row.receiptBacked })),
        fullGoalAcceptance: null, safeguards: null, actualCosts: null, receiptBackedContribution: null,
        fullEligiblePopulation: null, completeComparablePeriod: false, keepDecision: "not rated",
        coverageStatus: rows.some(row => row.value !== null) ? "partial-selected-cases" : "missing",
        missingReason: rows.some(row => row.value !== null) ? null : inScope ? "No independently evaluated eligible retained case; not zero delivery." : "Outside frozen evidence scope.",
      }, provenance: [{ repository, kind: "frozen-goal-native-instrument", ref: config.instrument },
        { repository, kind: "actual-workflow-source", ref: `${revision}:${definition.sourcePath}` }] };
    });
  }
  return { definition, collectBatch, scoreMetric };
}
