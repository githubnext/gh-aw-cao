import { readFileSync } from "node:fs";
import { analyze, consolidation, sha256 } from "./native.mjs";
import { base, cutoff, originals, packageFiles, read, repository, sourceCustody, verifyLock } from "./custody.mjs";

let cached;
export function evaluateNative() {
  if (cached) return cached;
  const custody = sourceCustody(), api = originals();
  const metadata = api.find(row => row.file === "repository.json.gz")?.body;
  if (metadata?.id !== 1036865607 || metadata.full_name !== repository || metadata.private !== false || metadata.visibility !== "public") throw new Error("Public source authority mismatch");
  for (const workflow of custody.data.workflows) {
    const id = workflow.adoption.commit, actual = custody.commit(id), parent = actual.parents[0];
    if (actual.at !== workflow.adoption.adoptedAt) throw new Error("Adoption timestamp mismatch");
    for (const suffix of ["md", "lock.yml"]) {
      const file = `.github/workflows/${workflow.slug}.${suffix}`;
      if (custody.resolve(parent, file) !== null || !custody.source(id, file)) throw new Error("Not an actual source and compiled introduction");
    }
  }
  const selected = custody.data.implementations.find(row => row.slug === "code-simplifier" && row.number === 26384);
  const actual = custody.commit(selected.commit);
  if (actual.parents[0] !== selected.parent || actual.at > cutoff || selected.mergedAt >= cutoff) throw new Error("Invalid actual-parent transition");
  const file = "pkg/workflow/github_cli.go";
  const beforeUniverse = custody.universe(selected.parent), afterUniverse = custody.universe(selected.commit);
  const universe = [...beforeUniverse, ...afterUniverse];
  if (universe.some(row => !row.path.endsWith(".go") || row.text === null
    || /^\s*\/\/(?:go:(?:linkname|wasmexport)|export )/m.test(row.text))) throw new Error("Unsupported native linker/entry universe");
  const beforePackage = packageFiles(beforeUniverse, file), afterPackage = packageFiles(afterUniverse, file);
  const inputs = new Map();
  for (const [id, rows] of [[selected.parent, beforePackage], [selected.commit, afterPackage]]) for (const row of rows) {
    inputs.set(`${id}:${row.path}`, { id: `${id}:${row.path}`, text: row.text });
  }
  const parsed = new Map(analyze([...inputs.values()]).map(row => [row.id, row]));
  const packageRows = id => [...parsed.values()].filter(row => row.id.startsWith(`${id}:`));
  if ([...parsed.values()].some(row => !row.valid || row.cgo)) throw new Error("Invalid or cgo package source; no valid empty fallback");
  const before = parsed.get(`${selected.parent}:${file}`), after = parsed.get(`${selected.commit}:${file}`);
  const result = consolidation(before, after);
  const references = (id, name) => packageRows(id).reduce((sum, row) => sum + (row.identifiers[name] ?? 0), 0);
  const otherProductionCallers = packageRows(selected.parent).filter(row => row.id !== `${selected.parent}:${file}` && !row.id.endsWith("_test.go"))
    .reduce((sum, row) => sum + (row.identifiers.runGHWithSpinner ?? 0), 0);
  if (result.value > 0 && (otherProductionCallers !== 0 || references(selected.commit, "runGHWithSpinner") !== 0)) {
    throw new Error("Complete package contradicts native consolidation");
  }
  const sameAlgorithm = row => row.functions.filter(fn => fn.body.length > 1
    && sha256(JSON.stringify(fn.body.slice(1))) === result.algorithmSha256).length;
  if (result.value > 0 && (packageRows(selected.parent).reduce((n, row) => n + sameAlgorithm(row), 0) !== 2
    || packageRows(selected.commit).reduce((n, row) => n + sameAlgorithm(row), 0) !== 1)) throw new Error("Complete package clone multiplicity mismatch");
  const rejectedCandidate = custody.data.implementations.find(row => row.number === 19261);
  const rejectedFile = "pkg/parser/frontmatter_hash.go";
  const rejectedParsed = analyze([rejectedCandidate.parent, rejectedCandidate.commit].map(commit => ({
    id: `${commit}:${rejectedFile}`, text: custody.source(commit, rejectedFile),
  })));
  if (!rejectedParsed.every(row => row.valid) || rejectedParsed[0].identifiers.marshalCanonicalJSON <= 1
    || before.identifiers.runGHWithSpinner <= 1) throw new Error("Rejected dead-code facts changed");
  const eligible = custody.data.eligibility, run = api.find(row => row.file === "selected-run-24439426053.json.gz")?.body;
  if (!run || run.repository.id !== 1036865607 || run.id !== eligible.run || run.head_sha !== eligible.head
    || run.path !== ".github/workflows/code-simplifier.lock.yml" || run.created_at !== eligible.runCreatedAt
    || run.created_at >= selected.mergedAt) throw new Error("Independent selected-run identity mismatch");
  const recent = eligible.recent.find(row => row.id === run.head_sha);
  if (!recent || custody.commit(recent.id).at !== recent.at || recent.at < eligible.windowStart || recent.at > run.created_at
    || custody.resolve(recent.id, file) === custody.resolve(recent.parents[0], file)) throw new Error("Recent-change eligibility not established");
  const source = custody.source(run.head_sha, ".github/workflows/code-simplifier.md");
  if (!source.includes("Eliminate redundant code and abstractions") || !source.includes("last 24 hours")) throw new Error("Historical source-goal mismatch");
  const direct = read(new URL("discovery.json.gz", base)).direct;
  const original = api.filter(row => row.file.startsWith("code-simplifier-")).map(row => row.body.data.repository.n26384).find(Boolean);
  const candidate = direct["code-simplifier"].find(row => row.number === selected.number);
  if (!original || original.mergeCommit.oid !== selected.commit || original.mergedAt !== selected.mergedAt) throw new Error("Original implementation identity mismatch");
  const corroborated = candidate.workflowReference?.runId === String(run.id) && candidate.bodySha256 === sha256(Buffer.from(original.body))
    && original.body.includes(String(run.id));
  const seen = new Set();
  const rows = [];
  for (const implementation of custody.data.implementations) {
    const identity = `${implementation.slug}:${implementation.commit}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ id: identity, ...implementation,
      value: implementation.commit === selected.commit && implementation.slug === selected.slug ? result.value : null,
      reason: implementation.slug === "daily-code-debt-aider" ? "Failure-linked plumbing repair is not independently established production Go debt remediation."
        : implementation.commit === selected.commit ? result.qualification : "No independently accepted native outcome for this retained implementation.",
      receiptBackedAttribution: null, corroborated: implementation.commit === selected.commit ? corroborated : false });
  }
  cached = { rows, selected, result, eligibility: eligible, adoptions: custody.data.workflows.map(row => ({ slug: row.slug, ...row.adoption })),
    nativeUniverse: { beforeFiles: beforeUniverse.length, afterFiles: afterUniverse.length, beforePackageFiles: beforePackage.length,
      afterPackageFiles: afterPackage.length, parsedPackageFiles: parsed.size, globalLinkerEntries: 0, opaqueNativeFiles: 0,
      priorRemovedSymbolIdentifiers: references(selected.parent, "runGHWithSpinner"), otherProductionCallers,
      afterRemovedSymbolIdentifiers: references(selected.commit, "runGHWithSpinner") },
    rejected: [{ version: "v1", number: 26384, nativeValue: 0, reason: "Removed runGHWithSpinner has two live wrapper callers, not unreachable." },
      { version: "v1", number: 19261, nativeValue: 0, reason: "marshalCanonicalJSON is called in its prior file, not unreachable; no positive dead-code claim." },
      { version: "v2", number: 26384, nativeValue: 0, reason: "setupGHCommand changed; v2 unchanged-constructor condition fails. v3 names only the retained duplicated result algorithm." }],
    corroborated, fullGoalAcceptance: null, safeguards: null, cost: null, keepDecision: "not rated" };
  return cached;
}

const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value));
export const validWindow = row => row && [row.windowStart, row.windowEnd, row.observedAt].every(iso)
  && row.windowStart < row.windowEnd && row.windowEnd <= row.observedAt
  && Date.parse(row.windowEnd) - Date.parse(row.windowStart) <= 7 * 86400000
  && (row.repository === undefined || row.repository === repository);

export function unreachable(before, after) {
  if (!before?.valid || !after?.valid || before.cgo || after.cgo || before.generated || after.generated
    || [...before.directives, ...after.directives].some(x => /go:|\/\/export /.test(x))) return null;
  return before.functions.filter(fn => !fn.receiver && !fn.entry && /^[a-z]/.test(fn.name) && fn.name !== "init"
    && before.identifiers[fn.name] === 1 && !after.identifiers[fn.name]).length;
}

export function debtModule(slug, lockSha256) {
  verifyLock(lockSha256);
  if (!["daily-code-debt-aider", "code-simplifier"].includes(slug)) throw new Error("Unsupported debt workflow");
  const predecessor = read(new URL("contract-v1.json", base)), v3 = read(new URL("contract-v3.json", base));
  const simplifier = slug === "code-simplifier";
  const data = read(new URL("custody.json.gz", base));
  const workflow = data.workflows.find(row => row.slug === slug);
  const unit = simplifier ? v3.unit : predecessor.unit;
  const fixture = missed => {
    const shared = "cmd := ExecGHContext(ctx,args...); return cmd.Output()";
    const common = `package workflow
import "context"
func ExecGH(args ...string)*Cmd{return setupGHCommand(nil,args...)}
func ExecGHContext(ctx context.Context,args ...string)*Cmd{return setupGHCommand(ctx,args...)}
func setupGHCommand(ctx context.Context,args ...string)*Cmd{return nil}
func enrichGHError(err error)error{return err}
func runGHWithSpinnerContext(ctx context.Context,spinnerMessage string,combined bool,args ...string)([]byte,error){${shared}}
func RunGHContext(ctx context.Context,spinnerMessage string,args ...string)([]byte,error){return runGHWithSpinnerContext(ctx,spinnerMessage,false,args...)}
func RunGHCombinedContext(ctx context.Context,spinnerMessage string,args ...string)([]byte,error){return runGHWithSpinnerContext(ctx,spinnerMessage,true,args...)}
`;
    return { kind: "native-validation", before: `${common}
func runGHWithSpinner(spinnerMessage string,combined bool,args ...string)([]byte,error){cmd := ExecGH(args...);return cmd.Output()}
func RunGH(spinnerMessage string,args ...string)([]byte,error){return runGHWithSpinner(spinnerMessage,false,args...)}
func RunGHCombined(spinnerMessage string,args ...string)([]byte,error){return runGHWithSpinner(spinnerMessage,true,args...)}
`, after: `${common}
func RunGH(spinnerMessage string,args ...string)([]byte,error){return RunGHContext(context.Background(),spinnerMessage,args...)}
func RunGHCombined(spinnerMessage string,args ...string)([]byte,error){return ${missed ? "RunGHContext" : "RunGHCombinedContext"}(context.Background(),spinnerMessage,args...)}
` };
  };
  const examples = simplifier ? { targetAttained: fixture(false), targetMissed: fixture(true) } : {
    targetAttained: { kind: "native-validation", before: "package p\nfunc unused(){}\n", after: "package p\n" },
    targetMissed: { kind: "native-validation", before: "package p\nfunc used(){}\nfunc Run(){used()}\n", after: "package p\nfunc Run(){}\n" },
  };
  const definition = {
    schemaVersion: 3, slug, repository, workflowName: `${slug} - native code-debt assessment`, sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal: simplifier ? "Simplify recently changed production code without changing behavior." : "Resolve actionable Go TODO/FIXME debt and remove genuinely dead code.",
      acceptance: simplifier ? v3.partialAcceptance : predecessor.partialAcceptance, temporalAnchor: "workflow-adoption" },
    adoption: { ...workflow.adoption, baselineCommit: null, baselineAt: null }, evaluation: { mode: "attainment-only" },
    evidence: { key: `${slug}-native-code-debt-${simplifier ? "v3" : "v1"}`, repositories: [repository],
      opportunity: simplifier ? v3.partialAcceptance : predecessor.partialAcceptance,
      filters: ["Selected retained issue/PR implementations; no complete workflow outcome population.",
        "Missing native facts and no-case periods are null, not zero.", "Fixed-reference retrospective assessment, not backdated current policy."],
      collection: "Offline original Git Merkle-path verification and pinned native Go AST analysis; target code remains data.",
      measurementKind: "interval", window: predecessor.period, instrument: lockSha256,
      interpreterBindings: JSON.parse(readFileSync(new URL("instrument-lock.json", base))).files,
      authoring: simplifier ? v3.authoring : predecessor.authoring, sourceRevision: data.revision },
    model: { architecture: "Source-goal-native deterministic structural proof, with strict acceptance and behavioral safeguards separate.",
      recommendation: "Not rated: no agreed keep bar, full comparable periods, costs or exclusive causation.",
      presentation: { label: unit, betterLabel: "More independently established native partial improvements" } },
    summary: { nativeLabel: unit },
    metrics: [{ id: "native-partial", name: unit, role: "primary", unit, direction: "increase",
      formula: simplifier ? v3.formula : predecessor.deduplication,
      presentation: { name: unit, legendLabel: simplifier ? "Consolidated algorithms" : "Unreachable removals", transform: "identity" } }],
    validationExamples: { ...examples, missing: {}, malformed: { kind: "native-validation", before: 7, after: false } },
    limitations: { strictAcceptance: predecessor.strictAcceptance[slug], fullGoalAcceptance: null, behaviorPreservation: null,
      safeguardCompleteness: null, costs: null, receiptBackedAttribution: null, wholeWorkflowValue: null, keepDecision: "not rated",
      supersededContractsPreserved: ["contract-v1.json", "contract-v2.json"], noTargetCodeExecuted: true },
  };
  function selected(request) {
    if (request.windowStart < workflow.adoption.adoptedAt || request.windowEnd > cutoff) return [];
    return evaluateNative().rows.filter(row => row.slug === slug && row.mergedAt >= request.windowStart && row.mergedAt < request.windowEnd);
  }
  function scoreMetric(id, evidence) {
    if (id !== "native-partial" || !evidence) return null;
    if (evidence.kind === "native-validation") {
      if (typeof evidence.before !== "string" || typeof evidence.after !== "string") return null;
      const parsed = analyze([{ id: "before.go", text: evidence.before }, { id: "after.go", text: evidence.after }]);
      return simplifier ? consolidation(...parsed).value : unreachable(...parsed);
    }
    if (evidence.kind !== "native-code-debt-cases" || evidence.instrument !== lockSha256 || !validWindow(evidence)
      || evidence.windowStart < workflow.adoption.adoptedAt || evidence.windowEnd > cutoff) return null;
    const rows = selected(evidence);
    if (JSON.stringify(evidence.caseIds) !== JSON.stringify(rows.map(row => row.id))) return null;
    const known = rows.filter(row => row.value !== null);
    return known.length ? known.reduce((sum, row) => sum + row.value, 0) : null;
  }
  async function collectBatch(requests) {
    if (!Array.isArray(requests) || !requests.every(validWindow)) throw new Error("Invalid code-debt windows or repository");
    const ordered = [...requests].sort((a, b) => a.windowStart.localeCompare(b.windowStart));
    if (ordered.some((row, i) => i && ordered[i - 1].windowEnd > row.windowStart)) throw new Error("Overlapping delivery periods");
    return requests.map(request => {
      const rows = selected(request);
      return { evidence: { ...request, kind: "native-code-debt-cases", instrument: lockSha256, caseIds: rows.map(row => row.id),
        nativeFacts: rows.map(row => ({ id: row.id, value: row.value, reason: row.reason, corroborated: row.corroborated })),
        fullGoalAcceptance: null, behaviorPreservation: null, safeguards: null, costs: null, receiptBackedAttribution: null,
        completeComparablePeriod: false, wholeWorkflowValue: null, keepDecision: "not rated",
        coverageStatus: rows.some(row => row.value !== null) ? "partial-selected-cases" : "unmeasured-native-outcome",
        missingReason: rows.some(row => row.value !== null) ? null : "No independently accepted source-goal-native outcome in this selected period; not zero workflow value.",
      }, provenance: [{ repository, kind: "frozen-native-code-debt-instrument", ref: lockSha256 },
        { repository, kind: "immutable-source-goal", ref: `${data.revision}:${definition.sourcePath}` }] };
    });
  }
  return { definition, collectBatch, scoreMetric };
}
