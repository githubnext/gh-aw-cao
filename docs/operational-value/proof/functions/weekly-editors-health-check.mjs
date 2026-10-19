import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const base = "https://github.github.com/gh-aw/";
const repository = "github/gh-aw";
const cutoff = "2026-10-18T15:00:12Z";
const sourceBlob = "e7d3355795fb9c5b79e6201300fc35d3e09c4e4b";

export function resolveEditorUrl(value) {
  if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error("Invalid editor destination");
  const expanded = value.replaceAll("${import.meta.env.BASE_URL}", "/gh-aw/");
  if (/[{}$]/.test(expanded)) throw new Error("Unresolved editor URL expression");
  const url = new URL(expanded, base);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Unsupported editor URL");
  return url.href;
}

export function discoverEditors(content) {
  if (typeof content !== "string") throw new Error("Missing editor inventory");
  let heading = null, fenced = false, button = false;
  const editors = [], ancillary = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (button) {
      if (/<\/LinkButton>/.test(line)) button = false;
      continue;
    }
    const title = line.match(/^###\s+(.+?)\s*$/);
    if (title) { heading = title[1]; continue; }
    if (/^#{1,2}\s/.test(line)) { heading = null; continue; }
    if (!heading) continue;
    const linkButton = line.match(/^\s*(?:-\s*)?<LinkButton\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})[^>]*>/);
    if (/<LinkButton\b/.test(line) && !linkButton) throw new Error("Unsupported editor LinkButton destination");
    if (linkButton && !/<\/LinkButton>|\/>/.test(line)) button = true;
    const destination = line.match(/^\s*(?:-\s*)?(https:\/\/\S+|\/\S+|\$\{import\.meta\.env\.BASE_URL\}\S+)\s*$/)?.[1]
      ?? linkButton?.slice(1).find(Boolean)
      ?? line.match(/^\s*(?:-\s*)?\[[^\]]+\]\(([^)\s]+)\)\s*$/)?.[1];
    if (destination) {
      const id = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!id || editors.some(row => row.id === id)) throw new Error("Ambiguous editor destination or heading");
      editors.push({ id, name: heading, url: resolveEditorUrl(destination) });
    } else {
      for (const match of line.matchAll(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g)) {
        ancillary.push({ heading, label: match[1], url: resolveEditorUrl(match[2]),
          reason: "Ancillary prose reference, not a standalone editor destination." });
      }
      if (button) throw new Error("Unterminated editor LinkButton");
    }
  }
  return { editors, ancillary };
}

function responseStatus(receipt) {
  if (!receipt || !["original-http-response", "original-curl-status", "original-curl-failure"].includes(receipt.kind) || receipt.independent !== true
    || receipt.method !== "GET" || receipt.followRedirects !== false
    || typeof receipt.ref !== "string" || !receipt.ref
    || typeof receipt.rawResponse !== "string" || receipt.rawResponse.length > 65536) return null;
  const bytes = Buffer.from(receipt.rawResponse, "base64");
  if (bytes.toString("base64") !== receipt.rawResponse || digest(bytes) !== receipt.sha256) return null;
  if (receipt.kind === "original-curl-status") {
    const expected = ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", receipt.url];
    if (receipt.exitCode !== 0 || JSON.stringify(receipt.command) !== JSON.stringify(expected)
      || !/^[1-5]\d\d\n?$/.test(bytes.toString("utf8"))) return null;
    return Number(bytes.toString("utf8").trim());
  }
  if (receipt.kind === "original-curl-failure") {
    const code = Number(bytes.toString("utf8").match(/^curl: \((\d+)\)/)?.[1]);
    if (![6, 7, 28, 35, 52, 56, 60].includes(code) || receipt.exitCode !== code
      || receipt.probeEnvironment?.independentlyVerified !== true
      || typeof receipt.probeEnvironment?.immutableRef !== "string"
      || !receipt.probeEnvironment.immutableRef) return null;
    return 0;
  }
  const statuses = [...bytes.toString("utf8").matchAll(/^HTTP\/(?:1\.[01]|2|3) ([1-5]\d\d)(?:[ \r\n]|$)/gm)]
    .map(match => Number(match[1])).filter(status => status >= 200);
  return statuses.length === 1 ? statuses[0] : null;
}

const fixture = (statuses, extra = {}) => ({
  valid: true, coverageStatus: "complete", eligibleCount: statuses.length,
  inventory: statuses.map((_, index) => ({ id: `editor-${index}`, url: `https://example.test/editor-${index}/` })),
  receipts: statuses.map((status, index) => {
    const bytes = Buffer.from(`HTTP/2 ${status}\r\n\r\n`);
    return { editorId: `editor-${index}`, url: `https://example.test/editor-${index}/`,
      kind: "original-http-response", independent: true, method: "GET", followRedirects: false,
      ref: "synthetic-validation-fixture-not-a-native-outcome", rawResponse: bytes.toString("base64"),
      sha256: digest(bytes) };
  }),
  ...extra,
});

export const definition = {
  schemaVersion: 3,
  slug: "weekly-editors-health-check",
  repository,
  workflowName: "Weekly Editors Health Check: constrained HTTP availability",
  sourcePath: ".github/workflows/weekly-editors-health-check.md",
  intent: {
    goal: "Monitor documented workflow editor health and keep preview screenshots up to date.",
    acceptance: "Constrained facet only: independently attributable original HTTP GET responses return exactly 200 for each actual standalone documented editor destination at a checkpoint.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "b3d55d8233a71fe28cfb26ec0fcc1427b246ab16",
    adoptedAt: "2026-02-21T22:11:11Z",
    baselineCommit: "89c787bd741db726454c4881c8946b934eddb870",
    baselineAt: "2026-02-21T22:00:57Z",
  },
  evaluation: {
    mode: "attainment-only",
    reason: "Reachability pre-existed adoption. No original historical HTTP responses are retained in the permitted offline sources; reconstruction remains open, not proven impossible.",
    antecedent: "pre-existing-but-not-reconstructable-from-permitted-offline-evidence",
    classificationReviewRequired: "Review if independently attributable pre-adoption original responses become available.",
  },
  frozenSource: {
    repositoryId: 1036865607, revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff, sourceBlob,
    sourceSha256: "35d957301e53b3acc71f8647d102d880bc287ee92316ff8ee67ca7156a23e86d",
    scopeDecision: "Three actual standalone editor destinations; ancillary WebAssembly prose link excluded. This is not literal Step-0 coverage or full-goal acceptance.",
    historicalSourceLimitation: "Adoption source requires LinkButton-only discovery; current source also accepts Markdown/bullets. Ancillary-link exclusion is a constrained facet, not retrospective full-goal acceptance. Compiled bodies were pending at initial freeze and are retained in subsequent source closure.",
  },
  evidence: {
    key: "documented-editor-original-http-200",
    repositories: [repository],
    opportunity: "One original HTTP GET per actual documented editor destination in one complete checkpoint.",
    filters: [
      "Sequential heading-bound standalone URL, LinkButton or standalone Markdown destination.",
      "Exclude screenshot image destinations and ancillary prose documentation references; preserve their original responses separately.",
      "Match checkpoint inventory revision, exact resolved URL and editor ID; do not follow redirects.",
      "Accept independently attributable original HTTP responses or original curl connection failures with separate immutable independently verified probe-environment evidence.",
      "Missing instrumentation, unreliable probes and an empty editor population are unavailable, never 100 percent.",
    ],
    collection: "Offline batch replay of digest-checked immutable source profiles and preserved original HTTP checkpoints; no API or current probes during evaluation.",
    measurementKind: "snapshot",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
    checkpointRule: "Checkpoint completedAt equals the explicit snapshot windowEnd; no last-known-value carry or current-state backdating.",
    sourceRetention: "Git preserves inventories, not HTTP availability. Issue/PR identities and screenshots cannot reconstruct response status.",
    matching: "Exactly one independently validated receipt per inventory editor; retain ancillary and duplicate responses outside the measured facet.",
  },
  model: {
    architecture: "Source-derived deterministic reachability facet with explicit missing instrumentation.",
    recommendation: "Report native availability without inferring editor functionality, screenshot freshness or workflow contribution.",
    presentation: { label: "Documented editor availability", betterLabel: "More editors return HTTP 200" },
  },
  summary: { nativeLabel: "Editors returning HTTP 200 (%)" },
  metrics: [{
    id: "available-editor-percent", name: "Available documented editors", role: "primary",
    formula: "100 * independently verified HTTP-200 editor responses / all eligible actual editor destinations at the same complete checkpoint",
    direction: "increase", unit: "percent",
    presentation: { name: "Available documented editors", legendLabel: "HTTP 200 editors (%)", transform: "identity" },
  }],
  metricDisposition: {
    retained: ["HTTP 200 availability as an explicitly constrained independent repository-outcome facet."],
    gates: ["Complete immutable editor population and independently attributable original per-editor responses."],
    rejected: ["Successful workflow runs", "Reports claiming success", "PR volume", "Screenshots as HTTP evidence", "Current fetches as historical evidence"],
    unmeasured: ["Editor functionality", "Preview freshness", "Costs", "Workflow contribution", "Full-goal acceptance"],
  },
  validationExamples: {
    targetAttained: fixture([200, 200, 200]),
    targetMissed: fixture([200, 503, 404]),
    missing: { valid: false, missingReason: "Original HTTP responses unavailable." },
    malformed: fixture([200], { eligibleCount: -1 }),
  },
};

export function scoreMetric(id, evidence) {
  if (id !== "available-editor-percent" || !evidence || evidence.valid !== true
    || evidence.coverageStatus !== "complete" || !Number.isSafeInteger(evidence.eligibleCount)
    || evidence.eligibleCount <= 0 || !Array.isArray(evidence.receipts)
    || evidence.receipts.length !== evidence.eligibleCount || !Array.isArray(evidence.inventory)
    || evidence.inventory.length !== evidence.eligibleCount) return null;
  const inventoryIds = new Set(evidence.inventory.map(row => row?.id));
  if (inventoryIds.size !== evidence.eligibleCount || inventoryIds.has(undefined)) return null;
  const ids = new Set();
  let available = 0;
  for (const row of evidence.receipts) {
    if (!row || typeof row.editorId !== "string" || !row.editorId || ids.has(row.editorId)
      || !evidence.inventory.some(editor => editor.id === row.editorId && editor.url === row.url)) return null;
    const status = responseStatus(row);
    if (status === null) return null;
    if (status === 200) available += 1;
    ids.add(row.editorId);
  }
  return 100 * available / evidence.eligibleCount;
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests) || requests.length > 1000) throw new Error("Invalid bounded editor batch");
  const file = fileURLToPath(new URL("../weekly-editors-health-check/investigation.json", import.meta.url));
  const report = readJsonArchive(file);
  if (report.scope.sourceBlob !== sourceBlob || report.scope.repository !== repository
    || report.scope.cutoff !== cutoff || report.scope.repositoryId !== 1036865607) throw new Error("Editor source scope mismatch");
  const profiles = report.inventoryHistory.map(profile => {
    if (!profile.available) return profile;
    const bytes = Buffer.from(profile.content, "base64");
    if (digest(bytes) !== profile.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== profile.blob) {
      throw new Error("Historical editor inventory integrity mismatch");
    }
    return { ...profile, ...discoverEditors(bytes.toString("utf8")) };
  });
  if (context.checkpoints !== undefined) throw new Error("Unverified context checkpoints are not an acquisition authority");
  return requests.map(request => {
    if (!request || ![request.windowStart, request.windowEnd, request.observedAt].every(value =>
      typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value)))
      || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
      || Date.parse(request.observedAt) < Date.parse(request.windowEnd)
      || (request.repository && request.repository !== repository)) throw new Error("Invalid editor observation request");
    const profile = profiles.filter(row => Date.parse(row.committedAt) <= Date.parse(request.windowEnd))
      .sort((left, right) => Date.parse(right.committedAt) - Date.parse(left.committedAt))[0];
    const beyondScope = Date.parse(request.windowEnd) > Date.parse(cutoff);
    const inventoryKnown = !beyondScope && profile?.available === true;
    const matching = (report.httpCheckpoints ?? []).filter(row => row.completedAt === request.windowEnd);
    if (matching.length > 1) throw new Error("Conflicting original editor checkpoints");
    const checkpoint = matching[0];
    if (checkpoint && (!inventoryKnown || checkpoint.inventoryBlob !== profile.blob
      || !Array.isArray(checkpoint.receipts)
      || !Number.isFinite(Date.parse(checkpoint.startedAt))
      || Date.parse(checkpoint.startedAt) < Date.parse(request.windowStart)
      || Date.parse(checkpoint.startedAt) > Date.parse(checkpoint.completedAt)
      || !checkpoint.receipts.every(row => Number.isFinite(Date.parse(row.capturedAt))
        && Date.parse(row.capturedAt) >= Date.parse(checkpoint.startedAt)
        && Date.parse(row.capturedAt) <= Date.parse(checkpoint.completedAt)))) {
      throw new Error("Original checkpoint inventory or response timestamp mismatch");
    }
    const measured = checkpoint ? {
      valid: true, coverageStatus: "complete", eligibleCount: profile.editors.length,
      inventory: profile.editors, receipts: checkpoint.receipts,
    } : null;
    if (measured && scoreMetric("available-editor-percent", measured) === null) {
      throw new Error("Malformed or incomplete original HTTP checkpoint");
    }
    const missingReason = beyondScope ? "Observation exceeds the frozen offline acquisition cutoff."
      : !inventoryKnown ? "Historical editor inventory content is not retained at this cutoff."
        : "No independently attributable original HTTP responses were retained for this exact checkpoint.";
    return {
      evidence: {
        valid: measured !== null, measurementKind: "snapshot", coverageStatus: measured ? "complete" : "missing",
        maturityStatus: measured ? "mature" : "unavailable",
        windowStart: request.windowStart, windowEnd: request.windowEnd, missingReason: measured ? null : missingReason,
        eligibleCount: inventoryKnown ? profile.editors.length : null,
        inventory: inventoryKnown ? profile.editors : null,
        populationDigest: inventoryKnown ? digest(JSON.stringify(profile.editors)) : null,
        inventoryRevision: inventoryKnown ? profile.revision : null,
        ancillary: inventoryKnown ? profile.ancillary : [],
        receipts: measured?.receipts ?? [], originalHttpReceiptCount: measured?.receipts.length ?? 0,
        knownResponseFailureCount: measured ? measured.receipts.filter(row => responseStatus(row) !== 200).length : null,
        nativeOutcomeCount: measured ? measured.receipts.filter(row => responseStatus(row) === 200).length : null,
        workflowContribution: null, costs: "not measured",
        fullGoalAcceptance: "not measured",
      },
      provenance: [
        { repository, kind: "immutable-workflow-source", ref: `git-blob:${sourceBlob}` },
        { repository, kind: "verified-output-inventory", ref: `sha256:${report.outputHistory.indexSha256}` },
        ...(inventoryKnown ? [{ repository, kind: "immutable-editor-inventory", ref: `git-blob:${profile.blob}` }] : []),
        ...(checkpoint?.receipts ?? []).map(row => ({ repository, kind: "original-http-receipt", ref: row.ref })),
      ],
    };
  });
}
