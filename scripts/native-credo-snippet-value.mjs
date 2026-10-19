import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export const credoHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const credoMarkdownPath = file => typeof file === "string"
  && /^(?:docs|\.github\/workflows)\/.+\.(?:md|mdx|markdown)$/i.test(file);
const parser = unified().use(remarkParse);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function extractCredoSnippets(text) {
  if (typeof text !== "string") throw new Error("Markdown bytes must decode to a string");
  const snippets = [];
  const visit = node => {
    if (node.type === "code" && /^(?:elixir|ex|exs|iex)$/i.test(node.lang ?? "")) {
      snippets.push({ line: node.position.start.line, language: node.lang.toLowerCase(),
        content: node.value, contentSha256: credoHash(node.value) });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(text));
  return snippets;
}

export function executeCredoSnippet(snippet, project) {
  if (!project || !path.isAbsolute(project)) throw new Error("Private native Credo project is required");
  const contentSha256 = credoHash(snippet.content);
  if (!snippet.content.trim() || snippet.language === "iex"
    || /^\s*(?:iex(?:\(\d+\))?>|\.\.\.>|\.\.\.)/m.test(snippet.content)) {
    return { status: "uncheckable-context", contentSha256, diagnostics: null };
  }
  // Credo comment waivers are not a repair. Keep these opportunities visibly unknown.
  if (/#\s*credo\s*:/i.test(snippet.content)) {
    return { status: "suppressed-context", contentSha256, diagnostics: null };
  }
  const directory = mkdtempSync(path.join(project, "cao-snippet-"));
  try {
    const filename = path.join(directory, "snippet.exs");
    writeFileSync(filename, snippet.content);
    const output = execFileSync("mix", ["run", "--no-compile", "--no-deps-check",
      path.resolve("scripts/credo-snippet-probe.exs"), filename, path.join(project, "deps/credo/.credo.exs")], {
      cwd: project, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, MIX_ENV: "dev", CREDO_EXTRA_CONFIG: "", ELIXIR_ERL_OPTIONS: "",
        ERL_AFLAGS: "", ERL_FLAGS: "", ELIXIR_ERL_COMPILER_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");
    const rows = output.split("\n").filter(line => line.startsWith("CAO_CREDO_RESULT="));
    if (rows.length !== 1) throw new Error("Missing native Credo result");
    const result = JSON.parse(rows[0].slice("CAO_CREDO_RESULT=".length));
    if (result.contentSha256 !== contentSha256 || !["checked", "invalid-syntax"].includes(result.status)
      || (result.status === "checked" && (result.credo !== "1.7.12" || result.elixir !== "1.17.3"
        || result.otp !== "27" || result.checkedFiles !== 1 || result.strict !== true
        || !count(result.diagnostics) || result.checks.length !== result.diagnostics))) {
      throw new Error("Native Credo identity or result mismatch");
    }
    return { ...result, stdoutSha256: credoHash(output) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function scanCredoSnippets(evidence) {
  if (evidence?.valid !== true || evidence.complete !== true || !count(evidence.eligible)
    || !count(evidence.markdownFiles) || !Array.isArray(evidence.snippets)
    || evidence.eligible !== evidence.snippets.length) return null;
  let diagnostics = 0, checked = 0;
  for (const snippet of evidence.snippets) {
    if (!snippet || !/^[a-f0-9]{64}$/.test(snippet.contentSha256)
      || !["checked", "invalid-syntax", "uncheckable-context", "suppressed-context", "runtime-unavailable"].includes(snippet.status)) return null;
    if (snippet.status === "checked") {
      if (!count(snippet.diagnostics) || snippet.credo !== "1.7.12" || snippet.elixir !== "1.17.3"
        || snippet.otp !== "27" || snippet.checkedFiles !== 1 || snippet.strict !== true) return null;
      checked++;
      diagnostics += snippet.diagnostics;
    } else if (snippet.diagnostics !== null) return null;
  }
  return { diagnostics: checked === evidence.eligible && checked > 0 ? diagnostics : null,
    checked, eligible: evidence.eligible, markdownFiles: evidence.markdownFiles };
}

export function scoreCredoSnippets(id, evidence) {
  if (id !== "native-credo-diagnostics") throw new Error("Unknown native Credo metric");
  return scanCredoSnippets(evidence)?.diagnostics ?? null;
}

export function nativeCredoSnippetModule(contract) {
  if (contract.interpreterSha256 !== credoHash(readFileSync(import.meta.filename))
    || contract.probeSha256 !== credoHash(readFileSync(new URL("./credo-snippet-probe.exs", import.meta.url)))) {
    throw new Error("Frozen native Credo interpreter changed");
  }
  const example = diagnostics => ({ valid: true, complete: true, eligible: 1, markdownFiles: 1,
    snippets: [{ status: "checked", contentSha256: "a".repeat(64), diagnostics,
      checkedFiles: 1, strict: true, credo: "1.7.12", elixir: "1.17.3", otp: "27" }] });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Daily Elixir Credo Snippet Audit", sourcePath: contract.sourcePath,
    intent: { goal: "Reduce native strict Credo diagnostics in fenced Elixir snippets under docs/ and .github/workflows/ while preserving their intent.",
      acceptance: "Replay every eligible fenced snippet with pinned native Credo under the source-defined strict default checks. Complete goal acceptance additionally needs intent preservation and independently verified source fixes; those are not inferred from lint, counts, reports or run success.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-credo-snippet-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract),
      opportunity: "Every CommonMark fenced code node labelled elixir, ex, exs or iex in tracked .md/.mdx/.markdown files under docs/ and .github/workflows/.",
      filters: ["Enumerate the whole Markdown cohort; no arbitrary subset, report counts or successful-run proxies.",
        "Use native Credo 1.7.12, Elixir 1.17.3 and OTP 27, with the pinned default check configuration and strict priorities.",
        "Parse snippet inputs without evaluating, compiling or executing them. Never load fetched repository scripts, Mix projects, executable configs or plugins.",
        "Native syntax failures, interactive/context fragments, empty snippets, waivers and missing runtime remain unknown.",
        "No eligible snippets is no opportunity, not compliant zero and not measured workflow value.",
        "Credo diagnostics are native lint observations, not established defects, semantic correctness, preserved intent or full acceptance.",
        "Changing source lint policy or waivers breaks comparison; unrelated execution infrastructure changes do not.",
        "No workflow contribution, costs, keep threshold or causal claim is inferred."],
      collection: "Digest-checked immutable full Markdown source cohorts, source policy history, pinned native tool and independent positive/negative probes.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "CommonMark fence extraction followed by native Elixir parsing and Credo static analysis in a private protected tooling project.",
      recommendation: "Inspect native diagnostics only when eligible snippets exist and all are checkable. An empty population cannot establish value or an improving trend.",
      presentation: { label: "Native Credo snippet diagnostics", betterLabel: "Fewer native diagnostics in comparable eligible snippets" } },
    summary: { nativeLabel: "Native strict Credo diagnostics in Elixir snippets" },
    metrics: [{ id: "native-credo-diagnostics", role: "primary", name: "Native strict Credo diagnostics",
      formula: "Sum pinned native strict Credo diagnostics only when the complete eligible snippet cohort is nonempty and checked; otherwise null.",
      direction: "decrease", unit: "diagnostics",
      presentation: { name: "Native strict Credo diagnostics", legendLabel: "Credo diagnostics", transform: "identity" } }],
    validationExamples: { targetAttained: example(0), targetMissed: example(1), missing: { valid: false },
      malformed: example("zero") } },
  scoreMetric: scoreCredoSnippets, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.sourceRevision !== contract.sourceRevision || index.until !== contract.until
      || index.complete !== true) throw new Error("Native Credo evidence changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native Credo repository mismatch");
      const state = facts.states.find(item => item.windowEnd === request.windowEnd);
      const evidence = { valid: Boolean(state), complete: state?.complete === true,
        eligible: state?.eligible, markdownFiles: state?.markdownFiles, snippets: state?.snippets ?? [] };
      const scan = scanCredoSnippets(evidence);
      const policies = facts.policies.filter(item => item.at <= request.windowEnd);
      const prior = policies.filter(item => item.at <= request.windowStart).at(-1);
      const comparable = prior?.supported === true && policies.filter(item => item.at > request.windowStart)
        .every(item => item.supported) && scan?.diagnostics !== null && scan !== null;
      const reason = !state ? "No retained immutable source endpoint."
        : scan?.eligible === 0 ? "No eligible Elixir snippets in the complete Markdown source cohort; no opportunity, not compliant zero."
          : scan?.diagnostics === null ? "At least one snippet is invalid, waived, context-dependent or lacks native runtime evidence."
            : comparable ? null : "Source policy continuity is not established.";
      return { evidence: { ...evidence, eligibleCount: scan?.eligible ?? null,
        checkedCount: scan?.checked ?? null, coverageStatus: comparable ? "complete" : "unknown",
        maturityStatus: "matured", missingReason: reason, noOpportunity: scan?.eligible === 0,
        fullGoalAcceptance: "not-measured", intentPreservation: "not-measured",
        workflowContribution: null, costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "native-credo-source-index", ref: censusDigest(index) },
        { repository: contract.repository, kind: "immutable-source-cohort", ref: state?.inventorySha256 ?? contract.sourceRevision }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
