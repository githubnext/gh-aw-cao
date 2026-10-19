import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const sourceBlob = "b641655a917ed1502a3cea3f7cddc511588e84c0";
const target = "https://githubnext.com/projects/agentic-workflows/";
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = text => createHash("sha256").update(text).digest("hex");
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ref = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const day = 86400000;
const week = 7 * day;
const anchor = Date.parse("2026-10-14T11:26:00Z");
const slot = at => Math.floor((Date.parse(at) - anchor) / week);
const slotStart = at => anchor + slot(at) * week;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const archivePath = fileURLToPath(new URL("../blog-auditor/observations.json", import.meta.url));
class InvalidEvidence extends Error {}

export function workflowSnippet(block) {
  if (!block || !["yaml", "yml", "markdown", "md"].includes(block.language)
    || typeof block.text !== "string") return false;
  const frontmatter = block.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return !!frontmatter && /^(?:on|engine|tools|permissions|safe-outputs)\s*:/m.test(frontmatter[1]);
}

export function capturePayload(row) {
  return Object.fromEntries(["capturedAt", "targetUrl", "intentSourceBlob", "status", "finalUrl", "snapshot", "codeBlocks"]
    .map(key => [key, row[key]]));
}

export function assessCapture(row) {
  if (!row || !iso(row.capturedAt) || row.targetUrl !== target || row.intentSourceBlob !== sourceBlob
    || row.captureReceipt?.kind !== "protected-browser-capture"
    || !ref(row.captureReceipt.ref)
    || row.captureReceipt.payloadSha256 !== sha256(capturePayload(row))) {
    throw new InvalidEvidence("Invalid independent browser capture or payload identity");
  }
  if (row.status !== null && (!Number.isInteger(row.status) || row.status < 100 || row.status > 599)
    || row.finalUrl !== null && typeof row.finalUrl !== "string"
    || row.snapshot !== null && typeof row.snapshot !== "string"
    || row.codeBlocks !== null && (!Array.isArray(row.codeBlocks)
      || row.codeBlocks.some(block => !block || typeof block.language !== "string" || typeof block.text !== "string"))) {
    throw new InvalidEvidence("Malformed native browser facts");
  }
  let domain = null;
  if (row.finalUrl !== null) {
    let url;
    try { url = new URL(row.finalUrl); } catch { throw new InvalidEvidence("Invalid captured final URL"); }
    domain = url.protocol === "https:" && !url.username && !url.password
      && ["githubnext.com", "www.githubnext.com"].includes(url.hostname);
  }
  const keywords = row.snapshot === null ? null
    : (row.snapshot.includes("agentic-workflows") || row.snapshot.includes("agentic workflows"))
      && ["GitHub", "workflow", "compile"].every(word => row.snapshot.includes(word));
  const checks = [
    row.status === null ? null : row.status === 200,
    domain,
    row.snapshot === null ? null : row.snapshot.length > 5000,
    keywords,
  ];
  const snippets = row.codeBlocks === null ? null : row.codeBlocks
    .map((block, index) => ({ ...block, index })).filter(workflowSnippet);
  const results = row.snippetChecks;
  if (!Array.isArray(results)) throw new InvalidEvidence("Missing compiler observation inventory");
  const seen = new Set();
  const validated = results.map(result => {
    if (!result || !snippets || !isCount(result.snippetIndex) || seen.has(result.snippetIndex)
      || !snippets.some(block => block.index === result.snippetIndex && hash(block.text) === result.snippetSha256)
      || !/^[a-f0-9]{40}$/.test(result.compilerCommit)
      || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
      || result.invocation !== "gh aw compile --no-emit --validate --dir"
      || result.receipt?.kind !== "protected-schema-compiler" || !ref(result.receipt.ref)
      || result.receipt.payloadSha256 !== sha256(Object.fromEntries(
        ["snippetIndex", "snippetSha256", "compilerCommit", "exitCode", "invocation"]
          .map(key => [key, result[key]])))) {
      throw new InvalidEvidence("Invalid independent snippet compiler observation");
    }
    seen.add(result.snippetIndex);
    return result;
  });
  const pageKnown = checks.filter(value => value !== null).length;
  const snippetKnown = snippets !== null && (snippets.length === 0 || validated.length > 0);
  const allKnown = pageKnown === 4 && snippets !== null && validated.length === snippets.length;
  const allPassed = allKnown && checks.every(Boolean) && validated.every(result => result.exitCode === 0);
  const linked = row.contribution !== null && row.contribution !== undefined;
  if (linked && (!["receipt-verified", "corroborated"].includes(row.contribution.kind)
    || row.contribution.workflowId !== "blog-auditor" || !/^[1-9]\d*$/.test(row.contribution.runId)
    || !ref(row.contribution.ref))) throw new InvalidEvidence("Malformed contribution linkage");
  return {
    capturedAt: row.capturedAt, pageKnown,
    pagePassed: checks.filter(value => value === true).length,
    snippetsKnown: snippetKnown, eligibleSnippets: snippets?.length ?? null,
    validatedSnippets: validated.length, passingSnippets: validated.filter(result => result.exitCode === 0).length,
    allKnown, allPassed, latestSchemaVerified: row.latestSchemaReceipt?.kind === "independent-release-reference"
      && ref(row.latestSchemaReceipt.ref)
      && sha(row.latestSchemaReceipt.compilerSetDigest)
      && row.latestSchemaReceipt.compilerSetDigest === sha256(validated.map(result => result.compilerCommit)),
    linked, captureDigest: sha256(capturePayload(row)),
  };
}

function values(evidence) {
  if (!evidence || evidence.contract !== "blog-independent-coverage-v1"
    || !Array.isArray(evidence.captures) || !isCount(evidence.eligibleCount)
    || !iso(evidence.windowStart) || !iso(evidence.windowEnd)
    || Date.parse(evidence.windowStart) >= Date.parse(evidence.windowEnd)
    || !["complete", "partial", "missing"].includes(evidence.coverageStatus)) return null;
  const eligibleCount = Math.ceil((Date.parse(evidence.windowEnd) - anchor) / week)
    - Math.ceil((Date.parse(evidence.windowStart) - anchor) / week);
  if (evidence.eligibleCount !== eligibleCount) return null;
  const seen = new Set();
  const rows = evidence.captures.map(capture => {
    const result = assessCapture(capture);
    const key = slot(result.capturedAt);
    if (slotStart(result.capturedAt) < Date.parse(evidence.windowStart)
      || slotStart(result.capturedAt) >= Date.parse(evidence.windowEnd)
      || Date.parse(result.capturedAt) >= Date.parse(evidence.windowEnd)
      || seen.has(key)) throw new InvalidEvidence("Capture outside cohort or repeated weekly opportunity");
    seen.add(key);
    return result;
  });
  if (rows.length > evidence.eligibleCount) throw new InvalidEvidence("Capture count exceeds weekly population");
  if (evidence.coverageStatus === "complete" && (evidence.eligibleCount === 0 || rows.length === 0)) {
    return { "page-checks": 0, "passing-page-checks": 0, "validated-snippets": 0,
      "passing-snippets": 0, "complete-checkpoints": 0, "linked-page-checks": 0 };
  }
  const pageKnown = rows.some(row => row.pageKnown > 0);
  const snippetKnown = rows.some(row => row.snippetsKnown);
  const completed = rows.some(row => row.allKnown && (!row.allPassed || row.latestSchemaVerified));
  const linkedKnown = rows.some(row => row.linked && row.pageKnown > 0);
  return {
    "page-checks": pageKnown ? rows.reduce((sum, row) => sum + row.pageKnown, 0) : null,
    "passing-page-checks": pageKnown ? rows.reduce((sum, row) => sum + row.pagePassed, 0) : null,
    "validated-snippets": snippetKnown ? rows.reduce((sum, row) => sum + row.validatedSnippets, 0) : null,
    "passing-snippets": snippetKnown ? rows.reduce((sum, row) => sum + row.passingSnippets, 0) : null,
    "complete-checkpoints": completed ? rows.filter(row => row.allPassed && row.latestSchemaVerified).length : null,
    "linked-page-checks": linkedKnown ? rows.filter(row => row.linked).reduce((sum, row) => sum + row.pageKnown, 0) : null,
  };
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) throw new Error(`Unknown metric: ${id}`);
  try { return values(evidence)?.[id] ?? null; } catch (error) {
    if (error instanceof InvalidEvidence) return null;
    throw error;
  }
}

const metric = (id, name, role, unit, formula, legendLabel) => ({
  id, name, role, unit, formula, direction: "increase",
  presentation: { name, legendLabel, transform: "identity" },
});

export const definition = {
  schemaVersion: 3, slug: "blog-auditor", repository, workflowName: "Blog Auditor",
  sourcePath: ".github/workflows/blog-auditor.md",
  source: { revision, sourceBlob, sha256: "3d3829366ec4534e7f72b10265e376fec0fba30021b523b06e7b4f80699e203b",
    closureSha256: "41c7d5844c7d241fc5e6777be89a952f7240cbc4fec62086f1a562527ae07bec",
    profile: "frozen-detailed-page-predicates; compiler-latest separately evidenced" },
  intent: {
    goal: "For weekly blog observation opportunities, independently verify the declared page checks and workflow snippets, preserving failures as useful monitoring evidence.",
    acceptance: "Protected contemporaneous browser facts reproduce each native assertion; independent pinned compiler receipts establish snippet validation. Agent claims and run conclusions are never evidence.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: { commit: "31dbf0d7997d44bd86983726e83b7ba3813eafac", adoptedAt: "2025-10-22T20:45:14Z",
    baselineCommit: "7a9f18a670557265211c70d5f92b100fa00344e4", baselineAt: "2025-10-22T20:16:26Z" },
  evaluation: { mode: "attainment-only",
    antecedent: "pre-existing-but-not-reconstructable-from-authorized-offline-evidence",
    reason: "Blog reachability and snippet usability predate this workflow; no historical independent browser/compiler captures exist in the supplied inventory. Acquisition remains pending, not exhausted." },
  evidence: {
    key: "blog-independent-coverage-v1", repositories: [repository],
    opportunity: "One target-page observation per compiled weekly Wednesday 11:26 UTC slot, assigned exclusively by that slot's start to a half-open interval cohort. Manual and independent observations can fill the same slot, never add another copy.",
    filters: [
      "Exact target URL; weekly slot starts within requested inclusive-start/exclusive-end interval and capture completes before its endpoint.",
      "First independently protected capture by actual capture time in each weekly slot, independent of pass/fail and producer.",
      "Detailed page predicates: HTTP 200; HTTPS exact allowed hostname without credentials; accessibility snapshot UTF-16 length >5000; case-sensitive GitHub/workflow/compile and agentic-workflows or agentic workflows.",
      "Workflow snippets: yaml/yml/markdown/md language hints, root --- frontmatter and a top-level on/engine/tools/permissions/safe-outputs key.",
      "Schema compilation is not behavioral correctness; latest schema requires a separate independent release-reference receipt.",
    ],
    collection: "Offline digest-checked immutable capture archive; shared cursor inventory is discovery only. No APIs, fetched code execution or present-day historical reconstruction.",
    measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    missingness: "Missing assertions remain null; independently established partial native subtotals survive. Empty snippet inventory is zero only with protected complete extraction.",
  },
  model: {
    architecture: "Deterministic native page-assertion and snippet-validation counters over independently protected observations.",
    recommendation: "Not rated: no source-derived keep bar, no native observations or measured costs.",
    presentation: { label: "Independent blog monitoring", betterLabel: "More independently verified checks" },
  },
  summary: { nativeLabel: "Independently verified page checks per week" },
  metrics: [
    metric("page-checks", "Independently assessed page checks", "primary", "checks", "Count known HTTP/domain/length/keyword assertions, at most four per weekly opportunity, including independently verified failures.", "Verified page checks"),
    metric("passing-page-checks", "Passing page checks", "diagnostic", "checks", "Count true independently assessed page assertions; no assertion about factual freshness.", "Passing page checks"),
    metric("validated-snippets", "Independently compiled workflow snippets", "diagnostic", "snippets", "Count eligible DOM code blocks with protected native compile receipts, regardless of exit status.", "Validated snippets"),
    metric("passing-snippets", "Schema-valid workflow snippets", "diagnostic", "snippets", "Count independently compiled eligible blocks with zero compiler exit code.", "Schema-valid snippets"),
    metric("complete-checkpoints", "Fully passing explicit-check checkpoints", "diagnostic", "checkpoints", "Count captured checkpoints satisfying all page predicates, complete snippet compilation and independently verified latest compiler reference.", "Fully passing checks"),
    metric("linked-page-checks", "Workflow-linked independent page checks", "diagnostic", "checks", "Count independently established page assertions with receipt-verified or explicitly corroborated workflow linkage; shared credit, not sole causation.", "Workflow-linked checks"),
  ],
  signal: { metricId: "linked-page-checks", basis: "workflow-contribution" },
  limitations: [
    "No independent historical native captures are currently retained; missingness is not zero delivery.",
    "Discussion safe output expires after one day and closes older discussions; the shared issues/PR inventory does not cover Discussions.",
    "Source experiment AIC, duration, discussion_created, validation_pass_rate and grader recurrence are costs/mechanism diagnostics, not accepted native value.",
    "Page coverage is useful monitoring, not a generic quality score, factual correctness, uptime duration or proof of remediation.",
    "Adoption source, reporting import and compiled workflow are retained. They used a different URL, compiler keyword, noon schedule and no snippet gate. Current-source compatibility is not backdated into those periods.",
    "Partial subtotals cannot establish complete period movement; costs and keep/retire decision remain not measured/not rated.",
  ],
  validationExamples: {},
};

function example(at, passed) {
  const snippet = "---\non: workflow_dispatch\n---\n# Example";
  const row = { capturedAt: at, targetUrl: target, intentSourceBlob: sourceBlob, status: passed ? 200 : 503,
    finalUrl: target, snapshot: `${passed ? "agentic-workflows GitHub workflow compile" : ""}${"x".repeat(5001)}`,
    codeBlocks: [{ language: "markdown", text: snippet }], snippetChecks: [],
    contribution: { kind: "corroborated", workflowId: "blog-auditor", runId: "1", ref: `sha256:${"a".repeat(64)}` } };
  row.captureReceipt = { kind: "protected-browser-capture", ref: `sha256:${"b".repeat(64)}`,
    payloadSha256: sha256(capturePayload(row)) };
  const result = { snippetIndex: 0, snippetSha256: hash(snippet), compilerCommit: revision,
    exitCode: passed ? 0 : 1, invocation: "gh aw compile --no-emit --validate --dir" };
  result.receipt = { kind: "protected-schema-compiler", ref: `sha256:${"c".repeat(64)}`, payloadSha256: sha256(result) };
  row.snippetChecks = [result];
  row.latestSchemaReceipt = { kind: "independent-release-reference", ref: `sha256:${"d".repeat(64)}`,
    compilerSetDigest: sha256([revision]) };
  return row;
}

const fixture = captures => ({ contract: definition.evidence.key, eligibleCount: 2,
  windowStart: "2026-09-30T11:26:00Z", windowEnd: "2026-10-14T11:26:00Z",
  coverageStatus: "partial", captures });
definition.validationExamples = {
  targetAttained: fixture([example("2026-10-01T12:00:00Z", true), example("2026-10-08T12:00:00Z", true)]),
  targetMissed: fixture([example("2026-10-01T12:00:00Z", false)]),
  missing: { ...fixture([]), coverageStatus: "missing" },
  malformed: { ...fixture([]), eligibleCount: -1 },
};

export async function collectBatch(requests, context = {}) {
  const archive = readJsonArchive(context.archive ?? archivePath);
  if (archive.schemaVersion !== 1 || archive.repository !== repository || archive.revision !== revision
    || !Array.isArray(archive.captures) || !["complete", "partial", "missing"].includes(archive.coverageStatus)) {
    throw new Error("Invalid protected blog observation archive");
  }
  const coverage = archive.coverage ?? [];
  if (!Array.isArray(coverage) || coverage.some(item => !iso(item.windowStart) || !iso(item.windowEnd)
    || Date.parse(item.windowStart) >= Date.parse(item.windowEnd) || item.status !== "complete"
    || !ref(item.authorityRef))) throw new Error("Invalid independent coverage ledger");
  const ordered = archive.captures.map(capture => ({ capture, assessed: assessCapture(capture) }))
    .sort((a, b) => a.assessed.capturedAt.localeCompare(b.assessed.capturedAt)
      || a.assessed.captureDigest.localeCompare(b.assessed.captureDigest));
  const firstBySlot = new Map();
  for (const row of ordered) {
    const previous = firstBySlot.get(slot(row.assessed.capturedAt));
    if (previous?.assessed.capturedAt === row.assessed.capturedAt
      && previous.assessed.captureDigest !== row.assessed.captureDigest) {
      throw new Error("Conflicting captures at identical native checkpoint");
    }
    if (!previous) firstBySlot.set(slot(row.assessed.capturedAt), row);
  }
  return requests.map(request => {
    const { windowStart, windowEnd, observedAt } = request;
    if (request.repository !== undefined && request.repository !== repository
      || !iso(windowStart) || !iso(windowEnd) || !iso(observedAt)
      || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(windowEnd) > Date.parse(observedAt)) {
      throw new Error("Invalid blog observation request");
    }
    const captures = [...firstBySlot.values()].filter(({ assessed }) =>
      slotStart(assessed.capturedAt) >= Date.parse(windowStart)
      && slotStart(assessed.capturedAt) < Date.parse(windowEnd)
      && Date.parse(assessed.capturedAt) < Date.parse(windowEnd)).map(row => row.capture);
    const eligibleCount = Math.ceil((Date.parse(windowEnd) - anchor) / week)
      - Math.ceil((Date.parse(windowStart) - anchor) / week);
    let coveredUntil = Date.parse(windowStart);
    for (const item of [...coverage].sort((a, b) => a.windowStart.localeCompare(b.windowStart))) {
      if (Date.parse(item.windowStart) <= coveredUntil) coveredUntil = Math.max(coveredUntil, Date.parse(item.windowEnd));
    }
    const complete = eligibleCount === 0 || coveredUntil >= Date.parse(windowEnd)
      && captures.every(capture => assessCapture(capture).allKnown);
    const evidence = {
      ...definition.evidence, contract: definition.evidence.key, windowStart, windowEnd, observedAt,
      eligibleCount, populationDigest: sha256({ target, windowStart, windowEnd, anchor, eligibleCount }),
      captures, coverageStatus: complete ? "complete" : captures.length ? "partial" : "missing",
      maturityStatus: Date.parse(windowEnd) - Date.parse(windowStart) < week ? "interim" : "mature",
      dubious: Date.parse(windowEnd) - Date.parse(windowStart) < week,
      ...(complete ? {} : {
        missingReason: "Full scheduled population and protected browser/compiler evidence are not acquired; any numeric values are observed native subtotals only.",
      }),
    };
    values(evidence);
    return { evidence, commit: revision,
      provenance: [{ repository, kind: "immutable-intent", ref: `${revision}:${definition.sourcePath}#${sourceBlob}` },
        { repository, kind: "protected-observation-archive", ref: `sha256:${sha256(archive)}` }] };
  });
}
