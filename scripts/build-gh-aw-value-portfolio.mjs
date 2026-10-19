import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { workflowPortfolio } from "../.github/skills/add-operational-value/scripts/portfolio-model.mjs";
import { escapeXml, sha256File } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { renderPulse } from "../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { timelinePulse } from "../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { fileDietValueEvents } from "./build-file-diet-value-events.mjs";
import { renderPortfolioTable } from "./workflow-portfolio-table.mjs";
import { readLifetime } from "./measure-file-diet-lifetime.mjs";
import { collectBatch as collectNativeTools, scoreMetric as scoreNativeTools } from "../docs/operational-value/proof/functions/smoke-test-tools.mjs";
import { collectBatch as collectLockfileStatistics, scoreMetric as scoreLockfileStatistics } from "../docs/operational-value/proof/functions/lockfile-stats.mjs";
import { collectBatch as collectPurelock, scoreMetric as scorePurelock } from "../docs/operational-value/proof/functions/purelock.mjs";
import { collectBatch as collectMultiPr, scoreMetric as scoreMultiPr } from "../docs/operational-value/proof/functions/smoke-multi-pr.mjs";
import { collectBatch as collectReusableArtifacts, scoreMetric as scoreReusableArtifacts } from "../docs/operational-value/proof/functions/smoke-workflow-call-with-inputs.mjs";
import { collectBatch as collectBlogAudit, scoreMetric as scoreBlogAudit } from "../docs/operational-value/proof/functions/blog-auditor.mjs";
import { collectBatch as collectEditorHealth, scoreMetric as scoreEditorHealth } from "../docs/operational-value/proof/functions/weekly-editors-health-check.mjs";
import { collectBatch as collectCliPerformance, scoreMetric as scoreCliPerformance } from "../docs/operational-value/proof/functions/daily-cli-performance.mjs";
import { collectBatch as collectSafeOutputConformance, scoreMetric as scoreSafeOutputConformance } from "../docs/operational-value/proof/functions/daily-safe-outputs-conformance.mjs";
import { collectBatch as collectTelemetryCoverage, scoreMetric as scoreTelemetryCoverage } from "../docs/operational-value/proof/functions/daily-observability-report.mjs";
import { collectBatch as collectModelResolution, scoreMetric as scoreModelResolution } from "../docs/operational-value/proof/functions/daily-model-resolution.mjs";
import { collectBatch as collectSyntaxQuality, scoreMetric as scoreSyntaxQuality } from "../docs/operational-value/proof/functions/daily-syntax-error-quality.mjs";
import { collectBatch as collectStepNames, scoreMetric as scoreStepNames } from "../docs/operational-value/proof/functions/step-name-alignment.mjs";
import { collectBatch as collectChangesets, scoreMetric as scoreChangesets } from "../docs/operational-value/proof/functions/changeset.mjs";
import { collectBatch as collectSdkEffects, scoreMetric as scoreSdkEffects } from "../docs/operational-value/proof/functions/smoke-copilot-sdk.mjs";
import { collectBatch as collectRedisCases, scoreMetric as scoreRedisCases } from "../docs/operational-value/proof/functions/smoke-service-ports.mjs";
import { collectBatch as collectSmallModel, scoreMetric as scoreSmallModel } from "../docs/operational-value/proof/functions/smoke-copilot-small.mjs";
import { collectBatch as collectDriveMemory, scoreMetric as scoreDriveMemory } from "../docs/operational-value/proof/functions/smoke-drive.mjs";
import { collectBatch as collectPydanticReads, scoreMetric as scorePydanticReads } from "../docs/operational-value/proof/functions/smoke-pydantic.mjs";
import { collectBatch as collectCiReplay, scoreMetric as scoreCiReplay } from "../docs/operational-value/proof/functions/smoke-ci.mjs";
import { collectBatch as collectDesignerDrift, scoreMetric as scoreDesignerDrift } from "../docs/operational-value/proof/functions/designer-drift-audit.mjs";
import { collectBatch as collectDocHealing, scoreMetric as scoreDocHealing } from "../docs/operational-value/proof/functions/daily-doc-healer.mjs";
import { collectBatch as collectDocUpdates, scoreMetric as scoreDocUpdates } from "../docs/operational-value/proof/functions/daily-doc-updater.mjs";
import { collectBatch as collectUnbloat, scoreMetric as scoreUnbloat } from "../docs/operational-value/proof/functions/unbloat-docs.mjs";
import { collectBatch as collectDocConsolidation, scoreMetric as scoreDocConsolidation } from "../docs/operational-value/proof/functions/developer-docs-consolidator.mjs";
import { collectBatch as collectClaudeOnboarding, scoreMetric as scoreClaudeOnboarding } from "../docs/operational-value/proof/functions/claude-code-user-docs-review.mjs";
import { collectBatch as collectEslintMining, scoreMetric as scoreEslintMining } from "../docs/operational-value/proof/functions/eslint-miner.mjs";
import { collectBatch as collectEslintRefinement, scoreMetric as scoreEslintRefinement } from "../docs/operational-value/proof/functions/eslint-refiner.mjs";
import { collectBatch as collectLinterMining, scoreMetric as scoreLinterMining } from "../docs/operational-value/proof/functions/linter-miner.mjs";
import { collectBatch as collectDependencyBundles, scoreMetric as scoreDependencyBundles } from "../docs/operational-value/proof/functions/dependabot-burner.mjs";
import { collectBatch as collectGoDependencyTargets, scoreMetric as scoreGoDependencyTargets } from "../docs/operational-value/proof/functions/dependabot-go-checker.mjs";
import { collectBatch as collectGoAssertionMigrations, scoreMetric as scoreGoAssertionMigrations } from "../docs/operational-value/proof/functions/go-fan.mjs";
import { collectBatch as collectRawMcpTransport, scoreMetric as scoreRawMcpTransport } from "../docs/operational-value/proof/functions/github-remote-mcp-auth-test.mjs";
import { collectBatch as collectClaudeCapabilities, scoreMetric as scoreClaudeCapabilities } from "../docs/operational-value/proof/functions/smoke-claude.mjs";
import { collectBatch as collectCursorCapabilities, scoreMetric as scoreCursorCapabilities } from "../docs/operational-value/proof/functions/smoke-cursor.mjs";
import { collectBatch as collectOpenCodeCapabilities, scoreMetric as scoreOpenCodeCapabilities } from "../docs/operational-value/proof/functions/smoke-opencode.mjs";
import { collectBatch as collectGeminiCapabilities, scoreMetric as scoreGeminiCapabilities } from "../docs/operational-value/proof/functions/smoke-gemini.mjs";
import { collectBatch as collectKiroCapabilities, scoreMetric as scoreKiroCapabilities } from "../docs/operational-value/proof/functions/smoke-kiro.mjs";
import { collectBatch as collectCrushCapabilities, scoreMetric as scoreCrushCapabilities } from "../docs/operational-value/proof/functions/smoke-crush.mjs";
import { collectBatch as collectCodexMcpAccess, scoreMetric as scoreCodexMcpAccess } from "../docs/operational-value/proof/functions/codex-github-remote-mcp-test.mjs";
import { collectBatch as collectCodeMetricsAccuracy, scoreMetric as scoreCodeMetricsAccuracy } from "../docs/operational-value/proof/functions/daily-code-metrics.mjs";
import { collectBatch as collectChronicleAccuracy, scoreMetric as scoreChronicleAccuracy } from "../docs/operational-value/proof/functions/daily-repo-chronicle.mjs";
import { collectBatch as collectTreeMapAccuracy, scoreMetric as scoreTreeMapAccuracy } from "../docs/operational-value/proof/functions/repo-tree-map.mjs";
import { collectBatch as collectMcpMappingAccuracy, scoreMetric as scoreMcpMappingAccuracy } from "../docs/operational-value/proof/functions/github-mcp-tools-report.mjs";
import { collectBatch as collectWeeklyIssueAccuracy, scoreMetric as scoreWeeklyIssueAccuracy } from "../docs/operational-value/proof/functions/weekly-issue-summary.mjs";
import { collectBatch as collectDailyIssueAccuracy, scoreMetric as scoreDailyIssueAccuracy } from "../docs/operational-value/proof/functions/daily-issues-report.mjs";
import { collectBatch as collectTemporaryIds, scoreMetric as scoreTemporaryIds } from "../smoke-temporary-id/operational-value/smoke-temporary-id.mjs";

const text = value => escapeXml(value == null ? "Not defined" : typeof value === "string" ? value : JSON.stringify(value));

async function replayNativeTimeline(timeline, collectBatch, scoreMetric, label) {
  const replayed = await collectBatch(timeline.snapshots.map(snapshot => ({
    observedAt: snapshot.observedAt,
    windowStart: snapshot.window.startAt, windowEnd: snapshot.window.endAt,
  })));
  if (!Array.isArray(replayed) || replayed.length !== timeline.snapshots.length) {
    throw new Error(`${label} native collector returned an incomplete series`);
  }
  for (const [position, snapshot] of timeline.snapshots.entries()) {
    const actual = replayed[position];
    if (censusDigest(actual.evidence) !== censusDigest(snapshot.evidence)
      || censusDigest(actual.provenance) !== censusDigest(snapshot.provenance)
      || Object.entries(snapshot.metrics).some(([metric, value]) => scoreMetric(metric, actual.evidence) !== value)) {
      throw new Error(`${label} native timeline differs from its production receipt replay`);
    }
  }
}

export function nativeReportReady(index, timeline, functionSha256, provenanceKind) {
  return Boolean(index?.complete && timeline?.valueFunction?.sha256 === functionSha256
    && Array.isArray(timeline.snapshots) && timeline.snapshots.length > 0
    && timeline.snapshots.every(snapshot => snapshot.provenance?.some(row =>
      row.kind === provenanceKind && row.ref === censusDigest(index))));
}

export function nativeEvaluationReady(index, timeline, functionSha256, metricId, provenanceKind) {
  return nativeReportReady(index, timeline, functionSha256, provenanceKind)
    && timeline.snapshots.some(snapshot => Number.isFinite(snapshot.metrics?.[metricId]));
}

export function nativeGapReportReady(timeline, functionSha256, metricId, provenanceKind, provenanceRef) {
  return Boolean(timeline?.valueFunction?.sha256 === functionSha256
    && Array.isArray(timeline.snapshots) && timeline.snapshots.length > 0
    && timeline.snapshots.every(snapshot => snapshot.metrics?.[metricId] === null
      && snapshot.provenance?.some(row => row.repository === "github/gh-aw"
        && row.kind === provenanceKind && row.ref === provenanceRef)));
}

const retainedHtml = filename => filename.endsWith(".gz")
  ? gunzipSync(readFileSync(filename)).toString("utf8") : readFileSync(filename, "utf8");

function verifyNativePlot(timeline, plotPath, workflowId) {
  const model = timelinePulse(timeline);
  if (timeline.repository !== "github/gh-aw" || model.workflowSlug !== workflowId
    || model.sourcePath !== `.github/workflows/${workflowId}.md`
    || model.window.endAt !== "2026-10-18T15:00:12Z"
    || retainedHtml(plotPath) !== renderPulse(model)) {
    throw new Error(`${workflowId} report identity or rendered evidence changed`);
  }
}

async function retainNativePendingReport(progress, entry) {
  const timeline = readCensusJson(entry.timelinePath ?? `${entry.reports}/${entry.workflowId}-timeline.json`);
  const plotPath = entry.plotPath ?? `${entry.reports}/${entry.workflowId}-pulse.html`;
  const reportPath = entry.reportPath ?? plotPath;
  if (sha256File(`docs/operational-value/proof/functions/${entry.workflowId}.mjs`) !== entry.functionSha256
    || timeline.valueFunction.sha256 !== entry.functionSha256
    || censusDigest(timeline) !== entry.timelineDigest
    || (entry.diagnosticReportPath && sha256File(entry.diagnosticReportPath) !== entry.diagnosticSha256)
    || (reportPath !== plotPath && sha256File(reportPath) !== entry.reportSha256)) {
    throw new Error(`${entry.workflowId} pending report changed; review its evidence before registration`);
  }
  await replayNativeTimeline(timeline, entry.collector, entry.scorer, entry.workflowId);
  verifyNativePlot(timeline, plotPath, entry.workflowId);
  const partialMeasured = Boolean(entry.partialMetricId);
  if (partialMeasured && !timeline.snapshots.some(snapshot => Number.isFinite(snapshot.metrics[entry.partialMetricId]))) {
    throw new Error(`${entry.workflowId} has no native partial observation to register`);
  }
  progress.push({ workflowId: entry.workflowId, sourceGitBlob: entry.sourceGitBlob,
    functionReady: entry.functionReady ?? true, evidenceReady: partialMeasured,
    evaluationReady: partialMeasured, plotReady: partialMeasured,
    ...(partialMeasured ? { partial: true } : {}),
    reportAvailable: true, reportPath, blocked: entry.blocked ?? false,
    ...(entry.diagnosticReportPath ? { diagnosticReportPath: entry.diagnosticReportPath } : {}),
    stage: entry.stage, detail: entry.detail });
  return timeline;
}

async function retainNativeGapReport(progress, entry) {
  const directory = `docs/operational-value/proof/${entry.directory}`;
  const indexPath = `${directory}/index.json`;
  if (!existsSync(indexPath)) return;
  const index = readCensusJson(indexPath);
  const timelinePath = `${entry.reports}/${entry.workflowId}-timeline.json`;
  const timeline = readCensusJson(timelinePath);
  const plotPath = `${entry.reports}/${entry.workflowId}-pulse.html`;
  const provenance = readCensusJson(entry.provenancePath ?? indexPath);
  const functionPath = `docs/operational-value/proof/functions/${entry.workflowId}.mjs`;
  if (sha256File(functionPath) !== entry.functionSha256
    || !nativeGapReportReady(timeline, entry.functionSha256, entry.metricId,
      entry.provenanceKind, censusDigest(provenance))) {
    throw new Error(`${entry.workflowId} gap report function or provenance changed; review before registration`);
  }
  if (entry.collector) await replayNativeTimeline(timeline, entry.collector, entry.scorer, entry.workflowId);
  if (index.repository !== "github/gh-aw") throw new Error(`${entry.workflowId} gap report repository changed`);
  verifyNativePlot(timeline, plotPath, entry.workflowId);
  progress.push({ workflowId: entry.workflowId, sourceGitBlob: entry.sourceGitBlob,
    functionReady: true, evidenceReady: false, evaluationReady: false, plotReady: false,
    reportAvailable: true, reportPath: plotPath, blocked: true,
    stage: entry.stage, detail: entry.detail });
}

export function hostMeasurementReady(index, timeline, functionSha256) {
  return Boolean(index?.proven > 0 && nativeEvaluationReady(index, timeline, functionSha256,
    "observed-proofs", "native-host-assertion-index"));
}

const page = (title, body, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:auto;padding:24px;color:#1f2328;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #d1d9e0;vertical-align:top}
a{color:#0969da}code{overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 16px}p{max-width:85ch}.scroll{overflow:auto}</style>
${head}</head><body><main>${body}</main></body></html>\n`;

export function writeWorkflowPortfolio(directory, portfolio) {
  mkdirSync(directory, { recursive: true });
  const copyRetainedReport = (sourcePath, filename) => {
    const source = realpathSync(sourcePath);
    if (!source.startsWith(`${realpathSync("docs/operational-value")}${path.sep}`)
      || ![filename, `${filename}.gz`].includes(path.basename(source))) {
      throw new Error("Retained report must be a workflow-owned operational-value report");
    }
    if (source.endsWith(".gz")) writeFileSync(path.join(directory, filename), retainedHtml(source));
    else copyFileSync(source, path.join(directory, filename));
  };
  const { workflows, ...metadata } = portfolio;
  const progressUpdatedAt = new Date().toISOString();
  const partitions = [], links = new Map();
  let cards = [], group = [], bytes = 0;
  const flush = () => {
    if (!group.length) return;
    const prefix = `workflows-${String(partitions.length + 1).padStart(3, "0")}`;
    writeCensusJson(path.join(directory, `${prefix}.json.gz`), group);
    writeFileSync(path.join(directory, `${prefix}.html`), page("Workflow evidence and outcome goals",
      `<p><a href="index.html">All workflows</a></p>${cards.join("\n")}`));
    partitions.push({ file: `${prefix}.json.gz`, sha256: censusDigest(group), count: group.length });
    for (const workflow of group) links.set(workflow.id, `${prefix}.html#${workflow.id}`);
    cards = []; group = []; bytes = 0;
  };
  for (const workflow of workflows) {
    const measurement = workflow.measurement;
    const body = `<section id="${text(workflow.id)}"><h2>${text(workflow.id)}</h2>
<p><a href="${text(workflow.sourceUrl)}">Frozen workflow source</a></p>
<h3>${text(measurement.status)}${measurement.progress?.partial ? " (partial; historical evidence remains open)" : ""}</h3><p>${text(measurement.limitation)}</p>
${measurement.progress ? `<p><strong>Current stage:</strong> ${text(measurement.progress.stage)}.
Function: ${measurement.progress.functionReady ? "ready" : "pending"};
native evidence: ${measurement.progress.evidenceReady ? "acquired" : measurement.progress.blocked ? "unavailable" : "pending"};
evaluation: ${measurement.progress.evaluationReady ? "complete" : measurement.progress.reportAvailable ? "gap report" : "pending"};
plot: ${measurement.progress.plotReady ? "complete" : measurement.progress.reportAvailable ? "gap plot" : "pending"}.</p>
<p>${text(measurement.progress.detail)}</p>` : ""}
${measurement.model || measurement.progress?.reportAvailable ? `<p><a href="${text(workflow.id)}-pulse.html">${measurement.model
    ? "Open native plot and evidence" : "Open evidence-gap plot and retained evidence"}</a></p>` : ""}
${measurement.progress?.diagnosticReportPath ? `<p><a href="${text(workflow.id)}-native-diagnostic.html">Open original diagnostic (not accepted outcome value)</a></p>` : ""}
<h3>Goal proposal</h3><p>${text(workflow.intent.status)}</p>
<dl><dt>Goal</dt><dd>${text(workflow.intent.goal)}</dd>
<dt>Acceptance</dt><dd>${text(workflow.intent.acceptance)}</dd>
<dt>Native measure</dt><dd>${text(workflow.intent.metricName)} (${text(workflow.intent.unit)})</dd>
<dt>Proposed function</dt><dd>${text(workflow.intent.formula)}</dd>
<dt>Design limitation</dt><dd>${text(workflow.intent.limitation)}</dd></dl>
<h3>Evidence discovery, not accepted value</h3>
<p>${workflow.discovery.markerLinkedOutputs} marker-linked outputs;
${workflow.discovery.relatedPullRequestCandidates} related PR candidates;
${workflow.discovery.mergedCandidates} candidates observed merged before the cutoff.</p>
<p>${text(workflow.discovery.limitation)}</p>
<p>Adoption has not been reconstructed by this inventory. No missing value is replaced with zero.</p></section>`;
    if (group.length && (bytes + Buffer.byteLength(body) > 180000 || group.length >= 60)) flush();
    group.push(workflow); cards.push(body); bytes += Buffer.byteLength(body);
    if (measurement.model) writeFileSync(path.join(directory, `${workflow.id}-pulse.html`), renderPulse(measurement.model));
    else if (measurement.progress?.reportAvailable) {
      copyRetainedReport(measurement.progress.reportPath
        ?? `docs/operational-value/proof/reports/github-gh-aw/${workflow.id}-pulse.html`, `${workflow.id}-pulse.html`);
    }
    if (measurement.progress?.diagnosticReportPath) {
      copyRetainedReport(measurement.progress.diagnosticReportPath, `${workflow.id}-native-diagnostic.html`);
    }
  }
  flush();
  writeCensusJson(path.join(directory, "portfolio.json.gz"), { ...metadata, progressUpdatedAt, partitions });
  copyFileSync(new URL("./workflow-portfolio-table.css", import.meta.url), path.join(directory, "portfolio.css"));
  const percentage = portfolio.totals.workflows
    ? (100 * portfolio.totals.measured / portfolio.totals.workflows).toFixed(1) : "0.0";
  writeFileSync(path.join(directory, "index.html"), page(`${portfolio.repository} workflow value`,
    `<h1>${text(portfolio.repository)} operational-value coverage</h1>
<p><strong>${percentage}% native evaluation coverage: ${portfolio.totals.measured} / ${portfolio.totals.workflows} workflows.</strong>
${portfolio.totals.workflows - portfolio.totals.measured} still lack a native evaluation.</p>
${renderPortfolioTable(workflows, links)}
<details class="report-context"><summary>Scope, evidence and limitations</summary>
<p>${portfolio.totals.workflows} workflows inventoried; ${portfolio.totals.measured} have native evaluations.
${portfolio.totals.inProgress} are in progress;
${portfolio.totals.evidenceUnavailable} have functions but no measured native outcomes;
${portfolio.totals.needsInstrumentation} need instrumentation;
${portfolio.totals.needsOutcomeContract} need goal/acceptance contracts;
${portfolio.totals.needsIntentReview} have changed intent sources requiring review.</p>
<p><strong>Target: native evaluations for all ${portfolio.totals.workflows} workflows.
${portfolio.totals.workflows - portfolio.totals.measured} remain without a native evaluation.</strong>
Native evaluation can establish a partial outcome; it does not imply full workflow attainment.</p>
<p>${text(portfolio.limitation)}</p>
<p>Coverage updated: <time datetime="${text(progressUpdatedAt)}">${text(progressUpdatedAt)}</time>.
Retained gap reports do not count as measured evaluations. Temporary API pauses are unfinished acquisition, not proof of absent outcomes.</p>
<p>${workflows.filter(workflow => workflow.measurement.model && workflow.measurement.progress?.partial).length}
native evaluations retain open historical evidence. Verified partial outcomes are not full workflow attainment.</p>
<p>Frozen source: <code>${text(portfolio.sourceRevision)}</code>. Cutoff: ${text(portfolio.until)}.
Each measured report retains its own evidence cutoff.</p>
<p>${portfolio.acquisition.entities} surviving issues/PRs traversed;
${portfolio.acquisition.knownRunReferences} recognized run markers.
${portfolio.acquisition.unresolvedRunMarkers} markers need workflow-path resolution;
${portfolio.acquisition.unknownWorkflowMarkers} identify workflows outside the frozen inventory;
${portfolio.acquisition.markerErrors} have marker parse/scope conflicts.</p>
<p>Marker counts are discovery diagnostics, not good-work scores. Missing measurements are not failures or zero delivery.
Native units and shared credits are not added across workflows.</p>
</details>`, '<link rel="stylesheet" href="portfolio.css">'));
}

export async function currentPortfolioInputs() {
  const lifetime = readLifetime("docs/operational-value/proof/file-diet-lifetime");
  const measurements = [
    { workflowId: "daily-file-diet", input: fileDietValueEvents(lifetime.proof, lifetime.inventories) },
    { workflowId: "daily-rendering-scripts-verifier", input: readCensusJson("docs/operational-value/proof/reports/daily-rendering-scripts-verifier-timeline.json") },
  ];
  const parallelizerEvents = "docs/operational-value/proof/reports/go-parallelization-value-events.json";
  const finished = existsSync(parallelizerEvents);
  if (finished) measurements.push({ workflowId: "daily-go-test-parallelizer",
    input: readCensusJson(parallelizerEvents) });
  const nativeIndex = "docs/operational-value/proof/go-parallelization/native-v2/native-history.json.gz";
  const native = existsSync(nativeIndex) ? readCensusJson(nativeIndex) : null;
  const progress = [{
    workflowId: "daily-go-test-parallelizer", sourceGitBlob: "c752d7390378b9414aabcfe8fbddc3b295d25e45",
    stage: finished ? "complete" : native ? "PR linkage and evaluation" : "native evidence acquisition",
    functionReady: true, evidenceReady: native?.complete === true, evaluationReady: finished, plotReady: finished,
    detail: native ? `${native.commits} immutable mainline Go-change commits and ${native.uniqueBlobs} digest-checked native blob features retained. Full race/behavior acceptance is separate.`
      : "Frozen native function authored; immutable source evidence is being acquired.",
  }];
  const engineContracts = "docs/operational-value/proof/engine-conformance/contracts.json";
  for (const contract of existsSync(engineContracts) ? readCensusJson(engineContracts) : []) {
    const archivePath = `docs/operational-value/proof/engine-conformance/${contract.workflowId}-v2.json.gz`;
    const archive = existsSync(archivePath) ? readCensusJson(archivePath) : null;
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const eventsPath = `docs/operational-value/proof/reports/${contract.workflowId}-value-events.json`;
    const events = existsSync(eventsPath) ? readCensusJson(eventsPath) : null;
    const measured = events || timeline && timelinePulse(timeline).metrics.some(metric =>
      metric.series.some(point => typeof point.value === "number"));
    if (measured) measurements.push({ workflowId: contract.workflowId, input: events ?? timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: archive?.observations.some(row => row.status === "available") ?? false,
      evaluationReady: Boolean(measured), plotReady: Boolean(measured),
      blocked: Boolean(!measured && archive?.complete && timeline),
      stage: measured ? "complete" : archive?.complete && timeline ? "native evidence unavailable"
        : archive ? "host evidence assessed; evaluation pending" : "host evidence acquisition",
      detail: archive ? `${archive.runInventory.length} surviving executions inventoried; ${archive.observations.filter(row => row.status === "available").length} independent host assessments retained. Unknown evidence is not zero native work.`
        : "Frozen function checks five host-verified behaviors, not agent/run success. Protected evidence acquisition is in progress." });
  }
  const sourceContracts = "docs/operational-value/proof/go-source-lifetime/contracts.json";
  for (const contract of existsSync(sourceContracts) ? readCensusJson(sourceContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const evidence = readCensusJson("docs/operational-value/proof/go-source-lifetime/native-history.json.gz");
    if (timeline) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: evidence.complete === true, evaluationReady: Boolean(timeline), plotReady: Boolean(timeline),
      stage: timeline ? "complete" : "native evaluation pending",
      detail: `${evidence.commits} shared immutable Go-change commits and ${evidence.uniqueBlobs} native blob features acquired from September 2025. This is a declared partial source facet, not full workflow acceptance.` });
  }
  for (const directory of ["eslint-monster", "yamllint-fixer"]) {
    const file = `docs/operational-value/proof/${directory}/coverage.json`;
    if (!existsSync(file)) continue;
    const coverage = readCensusJson(file);
    const timeline = readCensusJson(coverage.reportPaths.timeline);
    measurements.push({ workflowId: coverage.workflow, input: timeline });
    progress.push({ workflowId: coverage.workflow, sourceGitBlob: coverage.sourceGitBlob,
      functionReady: true, evidenceReady: true, evaluationReady: true, plotReady: true, stage: "complete",
      detail: `${coverage.knownAssessments} known native assessments; ${coverage.unknownAssessments} unknown. Population: ${coverage.coverage.repositoryPopulation}. Full lint, safeguards and exclusive causation remain unmeasured.` });
  }
  const issueContracts = "docs/operational-value/proof/issue-condition-history/contracts.json";
  for (const contract of existsSync(issueContracts) ? readCensusJson(issueContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const evidence = readCensusJson("docs/operational-value/proof/issue-condition-history/history.json.gz");
    if (timeline) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: evidence.complete, evaluationReady: Boolean(timeline), plotReady: Boolean(timeline),
      stage: timeline ? "complete" : evidence.complete ? "native evaluation pending" : "native condition acquisition",
      detail: `${evidence.issues} surviving issue identities; ${evidence.partitions.length} condition-history partitions acquired. Native any-label coverage is partial discoverability evidence, not correct classification or workflow attribution.` });
  }
  const specContracts = "docs/operational-value/proof/spec-condition/contracts.json";
  for (const contract of existsSync(specContracts) ? readCensusJson(specContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const evidence = readCensusJson("docs/operational-value/proof/spec-condition/index.json.gz");
    if (timeline) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: evidence.complete, evaluationReady: Boolean(timeline), plotReady: Boolean(timeline),
      stage: timeline ? "complete" : "native evaluation pending",
      detail: `${evidence.states.length} complete immutable observation trees and ${evidence.uniqueBlobs} specification blob facts acquired. This is repository reference condition, not report counts or attributed workflow delivery.` });
  }
  const smokeCoverage = "docs/operational-value/proof/smoke-native/coverage.json";
  for (const contract of existsSync(smokeCoverage) ? readCensusJson(smokeCoverage).workflows : []) {
    const timeline = readCensusJson(contract.reports["timeline.json"]);
    const measured = contract.status === "native-partial-measured";
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: measured, evaluationReady: measured, plotReady: measured,
      blocked: !measured, stage: measured ? "complete" : "native evidence unavailable",
      detail: `${contract.native.measuredAssessments} independently usable host assessments; ${contract.native.observedProvenBehaviors ?? "unknown"} observed native behavior proofs. Repeated monitoring proofs are not new code fixes; full acceptance and gaps remain separate.` });
  }
  for (const facet of ["schema-usage", "safe-output-fixtures"]) {
    const directory = `docs/operational-value/proof/${facet}`, contracts = `${directory}/contracts.json`;
    for (const contract of existsSync(contracts) ? readCensusJson(contracts) : []) {
      const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
      const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
      const indexPath = `${directory}/index.json.gz`;
      const evidence = existsSync(indexPath) ? readCensusJson(indexPath) : null;
      if (timeline) measurements.push({ workflowId: contract.workflowId, input: timeline });
      progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
        functionReady: true, evidenceReady: evidence?.complete === true, evaluationReady: Boolean(timeline), plotReady: Boolean(timeline),
        stage: timeline ? "complete" : "independent schema validation",
        detail: evidence ? `${evidence.states.length} immutable states and ${evidence.facts} independent structural validations retained for ${facet}. Compiler semantics, runtime exercise and workflow attribution remain separate.`
          : "Frozen function authored; immutable source examples are being checked with the pinned independent Draft-7 validator." });
    }
  }
  const hostContracts = "docs/operational-value/proof/host-assertions/contracts.json";
  for (const contract of existsSync(hostContracts) ? readCensusJson(hostContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const indexPath = `docs/operational-value/proof/host-assertions/${contract.workflowId}-index.json`;
    const index = existsSync(indexPath) ? readCensusJson(indexPath) : null;
    const measured = hostMeasurementReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`));
    const blocked = index?.complete === true && index.proven === 0;
    if (timeline && measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.proven > 0, evaluationReady: measured,
      plotReady: measured, blocked,
      stage: blocked ? "native host evidence unavailable" : measured ? "complete" : index ? "native host evaluation" : "native host evidence acquisition",
      detail: index ? `${index.inventoryRuns} initial-run opportunities; ${index.proven} source-bound native predicate proofs. Historical source/runtime gaps remain unknown; successful jobs or issue claims do not substitute for proof.`
        : "Source-specific predicate function and immutable checker/source references frozen; bounded read-only host evidence acquisition pending." });
  }
  const formalDirectory = "docs/operational-value/proof/formal-search";
  for (const contract of existsSync(`${formalDirectory}/contracts.json`) ? readCensusJson(`${formalDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${formalDirectory}/index.json`) ? readCensusJson(`${formalDirectory}/index.json`) : null;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`),
      "explored-states", "native-formal-search-index");
    const blocked = index?.complete === true && index.knownModels < contract.models.length;
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.knownModels === contract.models.length,
      evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native formal-search evidence unavailable" : measured ? "complete"
        : index ? "native formal-search evaluation" : "native formal-search evidence acquisition",
      detail: index ? `${index.inventoryRuns} initial-run opportunities; ${index.available} independently parsed native searches across ${index.knownModels}/${contract.models.length} fixed configurations. Repeated exploration is not fresh delivery; unfinished searches are not finite-state proofs.`
        : "Fixed model/configuration cohort and native TLC settings frozen; bounded read-only protected artifact acquisition pending." });
  }
  const ledgerDirectory = "docs/operational-value/proof/ledger-projections";
  const ledgerContracts = `${ledgerDirectory}/contracts.json`;
  for (const contract of existsSync(ledgerContracts) ? readCensusJson(ledgerContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const indexPath = `${ledgerDirectory}/${contract.workflowId}-index.json`;
    const index = existsSync(indexPath) ? readCensusJson(indexPath) : null;
    let available = 0;
    if (index) {
      if (!/^[a-z0-9-]+-states\.json\.gz$/.test(index.statesFile)) throw new Error("Unsafe ledger state archive");
      const states = readCensusJson(`${ledgerDirectory}/${index.statesFile}`);
      if (censusDigest(states) !== index.statesSha256) throw new Error("Ledger state archive changed");
      available = states.filter(state => state.result.status === "available").length;
    }
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`),
      "verified-rows", "native-ledger-projection-index");
    const blocked = index?.complete === true && available === 0;
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: available > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native ledger evidence unavailable" : measured ? "complete" : "native ledger evaluation",
      detail: `${available} independently replayed durable states; ${contract.limitation} Overlapping snapshots are not repeated delivery.` });
  }
  const currencyDirectory = "docs/operational-value/proof/version-currency";
  const currencyContracts = `${currencyDirectory}/contracts.json`;
  for (const contract of existsSync(currencyContracts) ? readCensusJson(currencyContracts) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const indexPath = `${currencyDirectory}/index.json`;
    const index = existsSync(indexPath) ? readCensusJson(indexPath) : null;
    const comparable = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["stale-pins"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`),
      "stale-pins", "native-version-currency-index");
    const blocked = Boolean(index?.complete && timeline && comparable === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: comparable > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "complete-cohort release evidence unavailable" : measured ? "complete" : "native release-history evaluation",
      detail: `${index?.states ?? 0} immutable endpoints and ${index?.sourceBlobs ?? 0} source blobs; ${comparable} complete eight-tool comparisons. Historical partial cohorts, Docker digests, compatibility and workflow causation remain separate.` });
  }
  const packageDirectory = "docs/operational-value/proof/package-currency";
  for (const contract of existsSync(`${packageDirectory}/contracts.json`) ? readCensusJson(`${packageDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${packageDirectory}/index.json`) ? readCensusJson(`${packageDirectory}/index.json`) : null;
    const comparable = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["stale-pins"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "stale-pins", "native-package-currency-index");
    const blocked = Boolean(index?.complete && timeline && comparable === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: comparable > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "comparable package evidence unavailable" : measured ? "complete"
        : index ? "native package-currency evaluation" : "native package evidence acquisition",
      detail: `${index?.states ?? 0} immutable manifest/lock endpoints; ${comparable} complete ${contract.tools.length}-package comparisons. Greatest dated numeric releases are references, not actionable latest-channel upgrades; old package lineages can rank higher. Unsupported/misaligned lock evidence remains unknown; migrations, builds, transitives and exclusive causation are not inferred.` });
  }
  const slideDirectory = "docs/operational-value/proof/slide-geometry";
  for (const contract of existsSync(`${slideDirectory}/contracts.json`) ? readCensusJson(`${slideDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${slideDirectory}/index.json`) ? readCensusJson(`${slideDirectory}/index.json`) : null;
    const comparable = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["overflowing-slides"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "overflowing-slides", "native-slide-geometry-index");
    const blocked = Boolean(index?.complete && timeline && comparable === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: comparable > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native static-render evidence unavailable" : measured ? "complete" : "native static geometry acquisition",
      detail: `${index?.states ?? 0} immutable endpoints; ${comparable} native static geometry measurements. Pinned Marp/Chromium replay measures actual bounds, not historical agent inspection. Script execution is disabled; missing local assets and font fallbacks remain explicit. Content accuracy, interactive diagrams and workflow causation are not inferred.` });
  }
  const functionDirectory = "docs/operational-value/proof/function-length";
  for (const contract of existsSync(`${functionDirectory}/contracts.json`) ? readCensusJson(`${functionDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : null;
    const index = existsSync(`${functionDirectory}/index.json`) ? readCensusJson(`${functionDirectory}/index.json`) : null;
    const comparable = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["overlong-bodies"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "overlong-bodies", "native-function-length-index");
    const blocked = Boolean(index?.complete && timeline && comparable === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: comparable > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native function-body evidence unavailable" : measured ? "complete" : "native function-body evaluation",
      detail: `${index?.states ?? 0} immutable endpoints and ${index?.sourceBlobs ?? 0} native Go blobs; ${comparable} complete source-facet measurements. Raw declarations/literals above the native 60-line boundary remain counted when suppressed. All-platform source replay is not historical build selection, complete lint acceptance, behavior preservation or workflow causation.` });
  }
  const spellingDirectory = "docs/operational-value/proof/native-spelling";
  for (const contract of existsSync(`${spellingDirectory}/contracts.json`) ? readCensusJson(`${spellingDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : null;
    const index = existsSync(`${spellingDirectory}/index.json`) ? readCensusJson(`${spellingDirectory}/index.json`) : null;
    const known = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["native-findings"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "native-findings", "native-spelling-index");
    const blocked = Boolean(index?.complete && timeline && known === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: known > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native spelling evidence unavailable" : measured ? "complete" : "native spellcheck acquisition",
      detail: `${index?.states ?? 0} retained endpoints; ${known} native spelling measurements under one pinned CSpell/reference dictionary policy. Ordinary unknown and forbidden words remain distinct; native jq verifies the source filter includes both. Changed in-document waivers are non-comparable, not proven repairs. Historical host results, linguistic correctness and workflow causation are not inferred.` });
  }
  const permissionDirectory = "docs/operational-value/proof/native-permissions";
  for (const contract of existsSync(`${permissionDirectory}/contracts.json`) ? readCensusJson(`${permissionDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${permissionDirectory}/index.json`) ? readCensusJson(`${permissionDirectory}/index.json`) : null;
    const known = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics["read-scope-mismatches"])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "read-scope-mismatches", "native-permission-index");
    const blocked = Boolean(index?.complete && timeline && known === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: known > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native permission evidence unavailable" : measured ? "complete" : "compiled permission acquisition",
      detail: `${index?.states ?? 0} retained endpoints; ${known} native compiled permission measurements. Exact contents/issues/pull-requests read grants are the source facet. Original intentional warning-demo values are not comparable acceptance; other jobs' safe-output writes are not agent grants. Compiler warnings, live scoped access, MCP read-only enforcement and workflow causation remain unmeasured.` });
  }
  const referenceDirectory = "docs/operational-value/proof/schema-references";
  for (const contract of existsSync(`${referenceDirectory}/contracts.json`) ? readCensusJson(`${referenceDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${referenceDirectory}/index.json`) ? readCensusJson(`${referenceDirectory}/index.json`) : null;
    const known = timeline?.snapshots.filter(snapshot => Number.isFinite(snapshot.metrics[contract.primaryMetric])).length ?? 0;
    const measured = nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), contract.primaryMetric, "native-schema-reference-index");
    const blocked = Boolean(index?.complete && timeline && known === 0);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: known > 0, evaluationReady: measured, plotReady: measured, blocked,
      stage: blocked ? "native schema reference evidence unavailable" : measured ? "complete" : "native schema reference acquisition",
      detail: `${index?.states ?? 0} shared immutable endpoints; ${known} native schema-reference measurements for this goal. Native Draft-7/JSON Pointer resolution separates missing local targets from unreachable root definitions; annotation strings and isolated definition cycles do not establish usage. Optional fields, implementation/docs correctness, attribution and costs remain separate.` });
  }
  const choiceDirectory = "docs/operational-value/proof/weekday-choice";
  for (const contract of existsSync(`${choiceDirectory}/contracts.json`) ? readCensusJson(`${choiceDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : null;
    const index = existsSync(`${choiceDirectory}/index.json`) ? readCensusJson(`${choiceDirectory}/index.json`) : null;
    const measured = index?.proven > 0 && nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "correct-configurations", "native-choice-index");
    const blocked = Boolean(index?.complete && timeline && !index.proven);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.proven > 0, evaluationReady: Boolean(measured), plotReady: Boolean(measured), blocked,
      stage: blocked ? "native choice receipts unavailable" : measured ? "complete" : "native choice receipt acquisition",
      detail: `${index?.observations ?? 0} execution identities inventoried; ${index?.proven ?? 0} correct configurations established by source-bound artifacts and protected custom-job readback. Expired/rerun/unreviewed receipts remain unassessed. This is configuration delivery, not actual deployment or invalid-choice rejection.` });
  }
  const instructionDirectory = "docs/operational-value/proof/instruction-size";
  for (const contract of existsSync(`${instructionDirectory}/contracts.json`) ? readCensusJson(`${instructionDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : null;
    const index = existsSync(`${instructionDirectory}/index.json`) ? readCensusJson(`${instructionDirectory}/index.json`) : null;
    const measured = index?.comparableStates > 0 && nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "excess-instruction-lines", "native-instruction-size-index");
    const blocked = Boolean(index?.complete && timeline && !index.comparableStates);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.comparableStates > 0, evaluationReady: Boolean(measured), plotReady: Boolean(measured), blocked,
      stage: blocked ? "native instruction size evidence unavailable" : measured ? "complete" : "native instruction size acquisition",
      detail: `${index?.states ?? 0} immutable endpoints; ${index?.features ?? 0} distinct native wc inputs. Direct instruction-file lines over the explicit 400-line audit ceiling are separate from stricter layout targets. Historical 500-line or unsupported policies are not comparable failures; content preservation, accuracy, duplication, attribution and costs remain separate.` });
  }
  const modelFormatDirectory = "docs/operational-value/proof/model-format";
  for (const contract of existsSync(`${modelFormatDirectory}/contracts.json`) ? readCensusJson(`${modelFormatDirectory}/contracts.json`) : []) {
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath,
      { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 }) : null;
    const index = existsSync(`${modelFormatDirectory}/index.json`) ? readCensusJson(`${modelFormatDirectory}/index.json`) : null;
    const measured = index?.comparableStates > 0 && nativeEvaluationReady(index, timeline,
      sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`), "unformatted-model-catalogs", "native-model-format-index");
    const blocked = Boolean(index?.complete && timeline && !index.comparableStates);
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.comparableStates > 0, evaluationReady: Boolean(measured), plotReady: Boolean(measured), blocked,
      stage: blocked ? "native model-format evidence unavailable" : measured ? "complete" : "native model-format acquisition",
      detail: `${index?.states ?? 0} immutable endpoints. Pinned native Prettier checks exactly the two model catalogs in the source fmt-json recipe, with JSON-only configuration and native ignore checks. Other formatting, lint, tests, model correctness, CI recovery, attribution and costs remain separate.` });
  }
  const queueDirectory = "docs/operational-value/proof/work-queue";
  if (existsSync(`${queueDirectory}/contract.json`)) {
    const contract = readCensusJson(`${queueDirectory}/contract.json`);
    const timelinePath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`;
    const timeline = existsSync(timelinePath) ? readCensusJson(timelinePath) : null;
    const index = existsSync(`${queueDirectory}/index.json`) ? readCensusJson(`${queueDirectory}/index.json`) : null;
    const functionSha256 = sha256File(`docs/operational-value/proof/functions/${contract.workflowId}.mjs`);
    const measured = index?.nativeKnownPredicates > 0 && nativeEvaluationReady(index, timeline,
      functionSha256, "observed-predicates", "queue-observer-evidence-index");
    const plotPath = `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-pulse.html`;
    const reportAvailable = nativeReportReady(index, timeline, functionSha256, "queue-observer-evidence-index")
      && existsSync(plotPath);
    if (reportAvailable) {
      const model = timelinePulse(timeline);
      if (model.workflowSlug !== contract.workflowId || model.sourcePath !== contract.sourcePath
        || model.window.endAt !== contract.until || timeline.repository !== contract.repository
        || readFileSync(plotPath, "utf8") !== renderPulse(model)) {
        throw new Error("Work queue report identity or rendered evidence changed");
      }
    }
    if (measured) measurements.push({ workflowId: contract.workflowId, input: timeline });
    progress.push({ workflowId: contract.workflowId, sourceGitBlob: contract.sourceGitBlob,
      functionReady: true, evidenceReady: index?.nativeKnownPredicates > 0,
      evaluationReady: Boolean(measured), plotReady: Boolean(measured), reportAvailable,
      blocked: Boolean(index?.complete && timeline && !measured),
      stage: measured ? "complete" : "native observer receipts unavailable",
      detail: `${index?.observations ?? 0} initial executions; ${index?.incompatibleIntentAttempts ?? 0} incompatible finish-staging intent runs; ${index?.observerInitialAttempts ?? 0} observer-era opportunities. ${index?.downloadedAgentArtifacts ?? 0} provider-digest-matching agent archives and ${index?.protectedLogsAvailable ?? 0} protected log projections survive, but no independent native observer receipts. The upload omits finish intent; smoke success cannot establish native conformance. All-unknown plots remain evidence gaps, not measured coverage.` });
  }
  const toolsDirectory = "docs/operational-value/proof/smoke-test-tools";
  if (existsSync(`${toolsDirectory}/index.json`)) {
    const workflowId = "smoke-test-tools";
    const index = readCensusJson(`${toolsDirectory}/index.json`);
    const timeline = readCensusJson(`docs/operational-value/proof/reports/github-gh-aw/${workflowId}-timeline.json`);
    const functionSha256 = sha256File(`docs/operational-value/proof/functions/${workflowId}.mjs`);
    if (functionSha256 !== "1f63f5a68868704b7edd4c23ef43747b2062d8ed9687b2c42ba0e5ec2afd4453") {
      throw new Error("Container-tool function changed; review its native registration");
    }
    await replayNativeTimeline(timeline, collectNativeTools, scoreNativeTools, "Container-tool");
    const measured = index.provenRunTools > 0 && nativeEvaluationReady(index, timeline,
      functionSha256, "observed-tool-proofs", "native-container-tool-evidence-index");
    if (measured) measurements.push({ workflowId, input: timeline });
    progress.push({ workflowId, sourceGitBlob: "a15b40b270aac767d61c9a27c57ddd3e99496933",
      functionReady: true, evidenceReady: measured, evaluationReady: measured, plotReady: measured,
      partial: true, stage: "partial native measurement; historical receipt coverage remains open",
      detail: `${index.provenRunTools} distinct run/tool opportunities independently proven across eleven runs; repeated checks are not extra delivery. Latest native week: 34 tool proofs, complete count unknown. ${index.acquisitionComplete === true
        ? "Bounded receipt acquisition is complete; expired, empty and unbound historical logs remain unknown outcomes, not failed checks."
        : "Bounded receipt acquisition remains incomplete."} Historical eligibility and native outcome coverage remain partial. The immutable predecessor package is retained under versions/pre-acquisition-completion-v2.json. No improving trend, full acceptance, costs or keep claim.` });
  }
  const temporaryDirectory = "docs/operational-value/proof/temporary-id";
  if (existsSync(`${temporaryDirectory}/index.json`)) {
    const workflowId = "smoke-temporary-id";
    const index = readCensusJson(`${temporaryDirectory}/index.json`);
    const timeline = readCensusJson(`docs/operational-value/proof/reports/github-gh-aw/${workflowId}-timeline.json`);
    const functionSha256 = sha256File("smoke-temporary-id/operational-value/smoke-temporary-id.mjs");
    if (functionSha256 !== "b4ed1c6b75c0db9947b28887f7c0fb94072eab7481d11298894d171b7b8b7f53") {
      throw new Error("Temporary-ID function changed; review its native registration");
    }
    await replayNativeTimeline(timeline, collectTemporaryIds, scoreTemporaryIds, "Temporary-ID");
    const measured = index.inventoryComplete === true && index.nativeResolvedReferences > 0
      && timeline.valueFunction?.sha256 === functionSha256
      && timeline.snapshots.length > 0
      && timeline.snapshots.every(snapshot => snapshot.provenance?.some(row =>
        row.repository === "github/gh-aw" && row.kind === "protected-receipt-body-graph-join"
        && row.ref === censusDigest(index)))
      && timeline.snapshots.some(snapshot => Number.isFinite(snapshot.metrics?.["resolved-references"]));
    if (measured) measurements.push({ workflowId, input: timeline });
    progress.push({ workflowId, sourceGitBlob: "24368e226f6cc0c5ddbf45d8c35a6a500ba3a94d",
      functionReady: true, evidenceReady: measured, evaluationReady: measured, plotReady: measured,
      partial: true, stage: "partial native reference/graph measurement; historical evidence remains open",
      detail: `${index.nativeResolvedReferences} resolved body references, ${index.nativeParentChildLinks} parent-child links and ${index.nativeAcceptedTriplets} fully accepted triplets independently retained across six mapped executions. Latest native week: six references and two links; full acceptance unknown. All mapped issue identities are joined, but ${index.unknownEligibility} initial executions have unknown eligibility and historical protected receipts remain open. Comparison, costs and causal attribution are not established.` });
  }
  const statisticsDirectory = "docs/operational-value/proof/lockfile-stats";
  if (existsSync(`${statisticsDirectory}/index.json`)) {
    const workflowId = "lockfile-stats";
    const index = readCensusJson(`${statisticsDirectory}/index.json`);
    const timeline = readCensusJson(`docs/operational-value/proof/reports/github-gh-aw/${workflowId}-timeline.json`);
    const functionSha256 = sha256File(`docs/operational-value/proof/functions/${workflowId}.mjs`);
    for (const [file, expected] of [
      [`docs/operational-value/proof/functions/${workflowId}.mjs`, "d2620a211063d934f45097cf5cb14d601dc851ea20efe0f3b40902fb6340d28c"],
      ["scripts/reconcile-lockfile-stats.mjs", "2e37297a69bbff811d3efed5c1180fdec79b6afa035b57fc346de9d31ae52065"],
      ["scripts/lockfile-stats-inputs.mjs", "30e6eb11aa390ce5a6e2938eee545d04ea362fe0c7e6ed4603cef6cc2faf6905"],
      ["scripts/native-lockfile-stats.py", "c1d3eafc9a53b601c7fd4fa35660c12534d86c80ad5c3170b0089d99fdadce66"],
    ]) {
      if (sha256File(file) !== expected) throw new Error(`Lockfile statistical implementation changed: ${file}`);
    }
    await replayNativeTimeline(timeline, collectLockfileStatistics, scoreLockfileStatistics, "Lockfile statistics");
    const measured = index.assessed > 0 && nativeEvaluationReady(index, timeline,
      functionSha256, "verified-statistical-facts", "native-lockfile-reconciliation-index");
    if (measured) measurements.push({ workflowId, input: timeline });
    progress.push({ workflowId, sourceGitBlob: "342d6d8771dca0836d291f69810de61353566149",
      functionReady: true, evidenceReady: measured, evaluationReady: measured, plotReady: measured,
      partial: true, stage: "partial full-population statistical reconciliation; historical evidence remains open",
      detail: `${index.verifiedFacts} distinct verified assertions and ${index.incorrectFacts} incorrect assertions across ${index.assessed} source-bound, full-population censuses. Latest native week: 726 verified statistical facts and 156 incorrect; previous partial week: 857 and 129. The latest individual census is separately 121 verified and 26 incorrect across 344 lockfiles. All 17 queued acquisitions are complete; expired summaries, incompatible prompts and nine caches without original same-day summaries remain unknown. Historical run-plus-github-script counters have different grain and remain unknown, not wrong. Full workflow acceptance, recommendation quality, budgets, publication and costs are not established; no trend or keep claim.` });
  }
  for (const entry of [
    { workflowId: "purelock", directory: "purelock", sourceGitBlob: "cd4498980967d37ec386d300b11bba18793ebfde",
      functionSha256: "ae91154bbb111913ee011ee7a010396ed082d5ef48ae19b9cec101bcc178e50d",
      metric: "observed-fully-covered", provenance: "purelock-native-index",
      collector: collectPurelock, scorer: scorePurelock,
      detail: "Three independent native states are retained, not four independent measurements. The complete 27-shard CI join proves a 576-function fully-covered lower bound; 283 uninstrumented pure functions remain null. Latest local-unit state: 1,696 fully-covered and 2,397 executed functions among 2,461 eligible. Changed populations and CI/local-unit suites prevent a comparable trend. All bounded acquisition is complete, but 71 historical bundles remain unknown. No workflow attribution, assertion/race/vet quality, costs or full-goal acceptance is inferred." },
    { workflowId: "smoke-multi-pr", directory: "smoke-multi-pr-native", sourceGitBlob: "edc4cd49f2c9fb6ce86eaebcb9c74108b4da325a",
      functionSha256: "e4241801eed432e088516e68ee7575abe06ba87934a45690a60e3a083211916f",
      metric: "verified-payload-deliveries", provenance: "native-multi-pr-target-tree-index",
      collector: collectMultiPr, scorer: scoreMultiPr,
      detail: "44 independently verified original branch payloads, including 21 CRLF payloads, across 46 assessed cases. Current disjoint delivery periods reconcile exactly to that 44/21 union; archived overlapping observations are not added. Latest week: four payloads and two CRLF, with 94 unassessed candidates. Two rejected annotations preserved original bytes and CRLF; they are not transport-corruption findings. All 188 additional protected logs are unavailable and acquisition is complete, not outcome-complete. All 27 source-approved dispatcher enumerations lack add_comment requests/created-comment receipts; 46 warnings explicitly skip the undetermined trigger. The eligible denominator, full two-branch/summary acceptance, costs and trend remain unknown." },
  ]) {
    const indexFile = `docs/operational-value/proof/${entry.directory}/index.json`;
    if (!existsSync(indexFile)) continue;
    const index = readCensusJson(indexFile);
    const timeline = readCensusJson(`docs/operational-value/proof/reports/github-gh-aw/${entry.workflowId}-timeline.json`);
    if (sha256File(`docs/operational-value/proof/functions/${entry.workflowId}.mjs`) !== entry.functionSha256) {
      throw new Error(`${entry.workflowId} function changed; review its native registration`);
    }
    await replayNativeTimeline(timeline, entry.collector, entry.scorer, entry.workflowId);
    const measured = nativeEvaluationReady(index, timeline, entry.functionSha256, entry.metric, entry.provenance);
    if (measured) measurements.push({ workflowId: entry.workflowId, input: timeline });
    progress.push({ workflowId: entry.workflowId, sourceGitBlob: entry.sourceGitBlob,
      functionReady: true, evidenceReady: measured, evaluationReady: measured, plotReady: measured,
      partial: true, stage: "native outcome facet measured; historical and full-goal evidence remain open",
      detail: entry.detail });
  }
  for (const entry of [
    { workflowId: "smoke-workflow-call-with-inputs", directory: "reusable-artifact",
      sourceGitBlob: "08d153af00652b150838280e72700fcd9a3a36af",
      functionSha256: "6fe4e138b5ac4aead27543d4c21d5e5c4898aef47814a7f04174bb431abf0eff",
      reports: "docs/operational-value/proof/reusable-artifact/final-reports/github-gh-aw",
      metricId: "verified-scenarios", provenanceKind: "reusable-artifact-isolation-index",
      collector: collectReusableArtifacts, scorer: scoreReusableArtifacts,
      stage: "acquisition complete; original artifact payload and protected consumer receipts unavailable",
      detail: "All 2,459 discovered runs are retained: 2,392 parents and 67 standalone runs. All 1,524 unresolved original candidate logs are unavailable, with no retained artifacts. Original referenced_workflows receipts bind 2,005 runs, not inferred PR heads. All 33 assessments remain unknown; exhaustive transport acquisition does not establish artifact collision-safety, payload correctness, consumer acceptance, costs or trend." },
    { workflowId: "smoke-create-cross-repo-pr", directory: "cross-repo-creation",
      sourceGitBlob: "4d112feef189a2c36c76927a25bf96fee2efdb41",
      functionSha256: "d29dfbc240135a5e75b2d670e7c48222aaf555f30f7680c60fa8be098da9ac6d",
      reports: "docs/operational-value/reports/github-gh-aw", metricId: "verified-deliveries",
      provenanceKind: "cross-repository-blocker-index-sha256", stage: "target authority and native delivery receipts unavailable",
      detail: "2,265 retained runs and 25 coherent source profiles reviewed. Configured target returns 404; prose target is private and was not read. Exact Git-tree/content delivery proofs remain unavailable. All 34 periods are unknown, not zero deliveries." },
    { workflowId: "smoke-update-cross-repo-pr", directory: "cross-repo-update",
      sourceGitBlob: "219be9c4d425130eeed0e2891de7c821b85ce7cf",
      functionSha256: "1feb895ef2704eba5706369c391d9dc9579df2e41488c7504c67b905be2bdd2d",
      reports: "docs/operational-value/proof/cross-repo-update/reports/github-gh-aw", metricId: "sequential-appends",
      provenanceKind: "public-source-and-run-inventory",
      provenancePath: "docs/operational-value/proof/cross-repo-update/acquisition.json",
      stage: "authorized target ledger and execution-bound receipts unavailable",
      detail: "2,266 retained runs and 27 source/compiled profiles reviewed. The strengthened receipt contract binds independent run, attempt, source, host, artifact, expected branch, payload and chronology. The sealed predecessor is retained; all 34 native periods remain unknown. Private target content was excluded." },
    { workflowId: "smoke-checkout-pr-dispatch", directory: "checkout-pr-dispatch",
      sourceGitBlob: "d03a4f83ff8fa6cb0a582b8cf4151e0268924ec4",
      functionSha256: "339d24b03024224491c8414ffc2ada482094d545aecc9d8c13ad1782e735d14b",
      reports: "docs/operational-value/reports/github-gh-aw", metricId: "verified-checkouts",
      provenanceKind: "protected-pr-checkout-inventory", stage: "no independently verified executed PR checkout",
      detail: "529 runs, 2,784 initial-attempt jobs, 162 artifacts and 1,065 successful endpoint receipts retained; no quota acquisition gap. All 26 recorded checkout branches skipped. Schedule controls are not PR-checkout proofs; original event/source/expected-head and protected checkout-state evidence remain unknown in all 13 periods." },
    { workflowId: "smoke-copilot-dynamic-workflow", directory: "copilot-dynamic-workflow",
      sourceGitBlob: "c9663c6985318c8e2d0dfa833f62ca06873541c7",
      functionSha256: "0c42bd28e9f742ef957f2b6a2b4a0f7e2e5864bbf7898adb23230b0c80fa4161",
      reports: "docs/operational-value/proof/reports/github-gh-aw", metricId: "verified-invocations",
      provenanceKind: "copilot-dynamic-runtime-evidence-index", stage: "protected invocation and durable result receipts unavailable",
      detail: "742 immutable blobs and complete caller-source closure reviewed. Zero direct runs; 50 caller candidates comprise 43 protected skips and seven unknown selections. Empty ZIPs are not native receipts. All three assessments remain unknown; package invocation and exact result acceptance are separate." },
    { workflowId: "daily-elixir-credo-snippet-audit", directory: "credo-snippets",
      sourceGitBlob: "32d6520ef2d5667ec2e76950879438e7c532d117",
      functionSha256: "f4dc5f86ac03f1f52fc4ccca7f79bd0ebeefc2a265d2da8ef829532b3c76e6f4",
      reports: "docs/operational-value/proof/reports/github-gh-aw", metricId: "native-credo-diagnostics",
      provenanceKind: "native-credo-source-index", stage: "no eligible source opportunities in complete reviewed history",
      detail: "1,932 first-parent states, 5,863 Markdown transitions and 6,602 immutable Markdown blobs replayed with no eligible Elixir fences. Native tooling works and fixture probes are retained, but an empty eligible population is not measured lint compliance. All 16 primary periods remain unknown; runtime absence is not the blocker." },
  ]) await retainNativeGapReport(progress, entry);
  for (const entry of [
    { workflowId: "codex-github-remote-mcp-test", sourceGitBlob: "64676ca797c1676d7c11c4d13d4fd99fc6872f41",
      functionSha256: "d95c564d204c8d004ccb746a9558a543dd12927484ac947ab69321f6a127c879",
      timelineDigest: "b79d51fde91f130ec2434136f65790b4d525f51ddc1ec135b17222236d8d08e3",
      reports: "docs/operational-value/proof/codex-remote-mcp/reports/github-gh-aw",
      collector: collectCodexMcpAccess, scorer: scoreCodexMcpAccess, partialMetricId: "native-access",
      stage: "one protected native Codex remote-MCP access verified; three resources filtered, not read back",
      detail: "One original attempt independently joins protected Codex stdout, raw and normalized native call IDs, exact repository/state/limit arguments and one unique sequential official-backend gateway exchange. Three upstream open issues match three concrete integrity-filter resource witnesses; Codex receives an empty list plus the filter, not those upstream titles. Gateway request records omit IDs, so no fabricated shared-ID join is claimed. October 3's source did not yet declare filtering an expected result: modern policy text is not backdated into historical full success. Eight other run identities lack original agent jobs and 39 other weekly periods remain unknown. Full goal, agent issue readback, contribution, costs and keep bar remain unknown." },
    { workflowId: "daily-code-metrics", sourceGitBlob: "60834b8243c279b70589ef02a3ce4b4aa70586a1",
      functionSha256: "8c200e7e75d4471db707339ec3cbf0804fde8332c30feeeb0f65c82f8f37797a",
      timelineDigest: "ad2917c8b7373d9235dbf75bf547fa469f39c5c8eb7f8b84c3e4f107eb551ca9",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectCodeMetricsAccuracy, scorer: scoreCodeMetricsAccuracy, partialMetricId: "verified-native-facts",
      stage: "two surviving-report workflow-inventory cells independently verified; broader metrics unknown",
      detail: "Two source-required direct Markdown/lock inventory facts match immutable source trees, including actual 297/297 basename sets with no mismatch. This is scoped factual accuracy, not report production, overall usefulness or full-goal acceptance. One surviving body is retrospectively assessed after cutoff and allocated by its original creation cohort; publication-time body bytes/accuracy are not established. Forty-eight other periods, semantic value, causal contribution and costs remain unknown." },
    { workflowId: "daily-repo-chronicle", sourceGitBlob: "8aae89c4e54d5319b4de2f2bebf00d404f063852",
      functionSha256: "4b293de61b5b1eb0cddfc83c652ea787f9b136b43ee860aacf77dce38811a8da",
      timelineDigest: "388f76301f76d9ce2a0e8ae4d49ee75dec478bfbf3f5a940de8b2c3e5a260de2",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectChronicleAccuracy, scorer: scoreChronicleAccuracy, partialMetricId: "verified-native-facts",
      stage: "thirty literal mainline commit citations verified; stated window exceeds the required day",
      detail: "Thirty cited commit hashes independently match the bound head's contiguous mainline prefix; 100% is accuracy/coverage within that bounded prefix, not full historical graph coverage or semantic summary quality. The report states 24h05m rather than the required 24h, so this is not complete acceptance. The surviving body was observed after cutoff; original publication-time accuracy is unknown. Fifty-one other periods, editorial utility, contribution and costs remain unknown." },
    { workflowId: "repo-tree-map", sourceGitBlob: "511f7340e278efb978b6634a2aa6432960d485d8",
      functionSha256: "c983f84e10c9d06c4e9b5063a92fd6f50dcb96092d50f081bd04629a3ba9e512",
      timelineDigest: "a47aa8b5a5ac5e12c7dd4b4a829330ef98a026bbd3aee6e875a7c7e00095e237",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectTreeMapAccuracy, scorer: scoreTreeMapAccuracy, partialMetricId: "verified-native-facts",
      stage: "ten published extension populations match immutable tracked files; broader map quality unknown",
      detail: "Ten source-specific extension populations match the immutable tracked-file reference. The predicate does not reconstruct dirty/untracked checkout contents, filesystem sizes or human comprehension. One surviving report body is retrospectively assessed against native facts after cutoff; original body accuracy at publication is not established. Fifty-three other periods, full goal, attribution and costs remain unknown." },
    { workflowId: "github-mcp-tools-report", sourceGitBlob: "bf73b689b99edcbee5ff6c0f863df907e8a780a3",
      functionSha256: "0aabf077f43c3098fa2b8a1c6c99c077c9474d306b75b09543d7ebd852c8d114",
      timelineDigest: "014a97370c3764505d3b5403b5fa3f21d4ea00b29fbcf42496ce1a4fe3249e7d",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectMcpMappingAccuracy, scorer: scoreMcpMappingAccuracy, partialMetricId: "verified-native-facts",
      stage: "three source mapping facts verified; claimed live-tool inventory is not established",
      detail: "The surviving report correctly states three independently recomputed JSON mapping facts: 106 unique tool names, 107 registrations and 24 toolsets. These are not proof of its claimed 59 live tools, server behavior or a complete tools audit. The outcome-informed retrospective instrument preserves the original census proposal. After-cutoff surviving body assessment is not publication-time body verification. Fifty-three other periods, full goal, contribution and costs remain unknown." },
    { workflowId: "weekly-issue-summary", sourceGitBlob: "0d6dae0ef94e1ecbef4d0a0f99df3cb3478c678d",
      functionSha256: "868a03a5c8bd89a91ae906389c25c0236db88edff61990826a1fd5f0c315ad33",
      timelineDigest: "d0979e4e8aa60e06982ed30b0a57a9e16b48cf09f42848c8f5d4b02fa39d44ff",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectWeeklyIssueAccuracy, scorer: scoreWeeklyIssueAccuracy, partialMetricId: "verified-native-facts",
      stage: "fifty-five listed new-issue identities verified; opening count underreports by at least thirty",
      detail: "All 55 assessed listed new issues independently belong to the declared seven-day window, with zero retained transfer events. Accuracy here applies only to those listed citations. A separate native diagnostic establishes an opening undercount floor of 30: the report claims 1512 while 1542 surviving transfer-free creations are established. Neither facet proves complete historical graph state, closed/reopened counts or full summary acceptance. The surviving body was observed after cutoff, not preserved at original publication. Fifty-one other periods, contribution and costs remain unknown." },
    { workflowId: "daily-issues-report", sourceGitBlob: "fa3cc1823518a5da495f30404134c8c9415924c1",
      functionSha256: "4e516970cf365b334bd84106bac65ac2f17f7915830c7927430772c048da2876",
      timelineDigest: "b2b49829c0191454f18dff7810314ea278d2e973b623926cf8eff07507c6b237",
      reports: "docs/operational-value/proof/native-monitoring-accuracy/reports/github-gh-aw",
      collector: collectDailyIssueAccuracy, scorer: scoreDailyIssueAccuracy, partialMetricId: "verified-native-facts",
      stage: "two captured-cohort creation-window counts verified; whole-repository statistics unknown",
      detail: "Two creation-window metrics match the actual retained 1000-issue cache. Every creation identity/timestamp is independently corroborated, and counts remain invariant from independently recorded prefetch completion through Discussion creation. The SDK's sample-named driver sends the real prompt; no sample-replay shortcut is assumed. This remains a captured-cohort facet, not a whole-repository denominator or full report acceptance. After-cutoff surviving body assessment does not establish original publication-time accuracy. Forty-six other periods, contribution and costs remain unknown." },
    { workflowId: "github-remote-mcp-auth-test", sourceGitBlob: "52e724d9ee1508917f2a3173975f30a379d3b0d5",
      functionSha256: "c01b6913eceb53b5f123fb440d66f9e39c0942a7f18829c5769c3277836ade1c",
      timelineDigest: "e6ff14f6d6e95a37be71d94baf2f48f04981bcdbbeabe48786538d99d49da067",
      reports: "docs/operational-value/proof/mcp-auth-native/reports/github-gh-aw",
      collector: collectRawMcpTransport, scorer: scoreRawMcpTransport, partialMetricId: "native-transport",
      stage: "three protected raw MCP transport checks verified; agent and issue-readback acceptance unknown",
      detail: "Three fixed original attempts bind exact-head editable and compiled raw-canary scripts to independently captured ordered protocol, initialized-notification, ping, nonempty catalog and non-error list_issues witnesses. Each catalog independently lists 23 tools. These are repeated sampled compatibility checks, not three repairs or a complete run census. The canary does not verify returned issue schema/bytes, agent usability or credential class; configured secret-token fallbacks prevent claiming Actions-token-specific acceptance. Forty other weekly periods remain unknown. Original source-defined acceptance is preserved, with retrospective presentation and no keep bar, workflow contribution or cost." },
    { workflowId: "smoke-claude", sourceGitBlob: "ad264cf01299864715d2387eb1d557158579c09d",
      functionSha256: "b91dfa3d223c0137dbb2565d5b506239f17687b558c68e99d8ab28b7bdfd77d3",
      timelineDigest: "36eebf250cc4193a95516a96f3b9a633f5b2a9bf2646160cb646f05eb4f070b9",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectClaudeCapabilities, scorer: scoreClaudeCapabilities, partialMetricId: "capabilities",
      stage: "two expanded-date native write/readback attempts verified; build acceptance unknown",
      detail: "Two original native sessions bind exact invocation identities, dated writes and independently returned file bytes to the protected attempt and immutable source. This establishes two sampled write/readback capabilities, not two repository improvements, full workflow acceptance or a complete execution population. Fifty-three other periods, native build completion, costs and keep policy remain unknown." },
    { workflowId: "smoke-cursor", sourceGitBlob: "8917a3a1e428316a3601f9de7f9116899c454945",
      functionSha256: "22bb12d6d3709c7de1a257cb5b10819747caa4183eb0f0614ef833f10dd747fc",
      timelineDigest: "8de9f309fef2f9a22d09b46074b5d16a1527b7d0d8ea09a3ee1cf0e732787251",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectCursorCapabilities, scorer: scoreCursorCapabilities, partialMetricId: "capabilities",
      stage: "dated native write/readback and independently joined asynchronous build verified",
      detail: "One expanded-date native write/readback facet and one native build completion are independently captured. Async acceptance joins original start, task, session and exact command, rather than treating timeout-shaped exit zero as successful completion. The two distinct capability facets are not complete goal acceptance or repository improvements. Ten other periods, full acceptance, costs and any keep threshold remain unknown." },
    { workflowId: "smoke-opencode", sourceGitBlob: "f0808f3849640630a8bc4794a8872191fe633668",
      functionSha256: "1514d04d769c66b764bf76d240801a1e321ee5539501e68db6c7fa7b2a974fdd",
      timelineDigest: "b345d1a25c3a9daa1fc049b4b6e88c67a981781b4e05de604ee533c815cf86b8",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectOpenCodeCapabilities, scorer: scoreOpenCodeCapabilities, partialMetricId: "capabilities",
      stage: "literal-template native readback verified; expanded date and native build fail acceptance",
      detail: "One independently captured literal-template file readback qualifies only the explicitly outcome-informed v2 partial; the stricter frozen expanded-date predicate remains rejected. Overlapping write/read event intervals do not prove write-before-read. An independently captured build failure is retained as zero native build acceptance, not erased by the narrower partial. Fifty-three other periods remain unknown; no full success, workflow improvement, keep bar or measured cost is claimed." },
    { workflowId: "smoke-gemini", sourceGitBlob: "dee7e74b5b711a0ad6be9271234a349cd2c543d4",
      functionSha256: "9a77e7dc97eaf6e8f622f91416a62a43b8443751abd14eaf31827275bb9f9af5",
      timelineDigest: "b2723991eed1e1e554fe8fe2eee2fa7c0b2173db3a6a4cd64b2e6a0dbc0b35d7",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectGeminiCapabilities, scorer: scoreGeminiCapabilities, blocked: true,
      stage: "seven chronological retained attempts fail before native operations; outcomes unknown",
      detail: "Original recent sessions retain setup/auth failures but no qualifying native file or build effects. All 35 periods remain unknown. A functioning instrument and explicit gap report do not constitute completed native evaluation, accepted capability, zero delivery or measured value." },
    { workflowId: "smoke-kiro", sourceGitBlob: "a0bfea05cd407f8c9ef8d95749dfadf75c6ac836",
      functionSha256: "29c0dad070281e87f858e2ebed3748ffa3527fe8e4600ba0f6bc26d0243ef649",
      timelineDigest: "971bd3954d07c31c3e5e2bf3bcb99c2439b87c466449274e70824f941e0f65b2",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectKiroCapabilities, scorer: scoreKiroCapabilities, blocked: true,
      stage: "native command capture omits returned bytes and call correlation; outcome gap retained",
      detail: "Seven chronological retained attempts include commands/completion status without the native returned bytes and shared call identity needed by the frozen write/readback predicate. Assistant claims and Discussion prose cannot substitute. All eleven periods remain unknown and add no completed native coverage." },
    { workflowId: "smoke-crush", sourceGitBlob: "1ef27a9db57f5ea8c1b50234d63431b5de2e8cff",
      functionSha256: "747127a2e186dd29f70aba272ca02fd8f166c59cd2ddf9dd02d1280528c79951",
      timelineDigest: "4985508c1dfb49fb02de02992f8f1c4950b8e516f8c8db9a8b0249caf031b45c",
      reports: "docs/operational-value/proof/native-smoke-capabilities/reports/github-gh-aw",
      collector: collectCrushCapabilities, scorer: scoreCrushCapabilities, blocked: true,
      stage: "retained native capture omits tool effects; all outcome periods unknown",
      detail: "Seven chronological retained attempts lack the independent native tool effects required to verify filesystem/build outcomes; one skipped attempt has no protected agent log. All 27 periods remain unknown. Preserved originals and replayable rejection reports are not completed native evaluation or zero value." },
    { workflowId: "dependabot-burner", sourceGitBlob: "2791a0150095979908154abe3e6d5df5cd2a226b",
      functionSha256: "e3e23530b8d322b4d69fb27be27d3fb7a3749b2cbc8c2b7792ee8c3c3df022ba",
      timelineDigest: "e5570367c5fd7aaf9a2aec84af5472a39aef8283316a4fba609e3fe6284c7db5",
      reports: "docs/operational-value/proof/go-dependency/reports/github-gh-aw",
      collector: collectDependencyBundles, scorer: scoreDependencyBundles, partialMetricId: "native-partial",
      stage: "seven native bundled dependency targets implemented; full update safety unknown",
      detail: "Two original runtime/root-go.mod bundles match seven selected implemented targets against actual merge and first-parent manifests, split four and three across disjoint February periods. The original 333-byte source asks for bundled issue recommendations, not today's generated-source edits: retrospective Burner era v3 preserves that distinction alongside unchanged v1/v2. Five unselected transitives cannot inflate the subtotal. An explicitly selected indirect target is allowed by that historical bundle goal, not silently admitted to a direct-only checker. Corroborated editable issue-to-implementation links are shared contribution evidence, not protected creation receipts. Thirty-six other periods, four unassessed implementations, HTTP410 issue originals, full compatibility, safety and costs remain unknown; not rated." },
    { workflowId: "dependabot-go-checker", sourceGitBlob: "a7ebbd07b7aed746ad7c69d61efe4cf211d1bf8c",
      functionSha256: "a720fcfde83e6535cf9d314f5a02b755328247adbf4b273bdf3160aec1a455c7",
      timelineDigest: "aebfb5539c54f46ed36fdc98b87c6c839709e711cdd0aaa5aa073a910b12ebe4",
      reports: "docs/operational-value/proof/go-dependency/reports/github-gh-aw",
      collector: collectGoDependencyTargets, scorer: scoreGoDependencyTargets, partialMetricId: "native-partial",
      stage: "four recommended native direct dependency targets implemented; safety classification unknown",
      detail: "Four exact recommended old/new targets match immutable root go.mod transitions and are direct before and after. Native quantities fall in three disjoint periods as one, two and one. Version advancement, including a pseudo-version, is not accepted as safe single-step patch classification or complete release correctness. Forty-seven other periods remain unknown. Editable original issue links corroborate shared delivery, not sole causation or authoritative receipts. Official changelogs, full recommendation population, grouping/cleanup, compatibility and matched costs remain unknown; not rated." },
    { workflowId: "go-fan", sourceGitBlob: "17931a8fce9a077dcaed2b9fcbea54a7f91b60f5",
      functionSha256: "8361924e66c84e40b3274c4a2f52ed7433dc3c7b3a90bfb7a5400ee5e2053666",
      timelineDigest: "2109db31415968515d02bca28be576df0553ef5e56494bf0dc922789b483bab2",
      reports: "docs/operational-value/proof/go-dependency/reports/github-gh-aw",
      collector: collectGoAssertionMigrations, scorer: scoreGoAssertionMigrations, partialMetricId: "native-partial",
      stage: "ten native assertion API sites migrated; not the claimed 602 or full behavioral acceptance",
      detail: "Independent Go AST comparison matches exact imports, enclosing functions and normalized arguments in three original files: one console confirmation site, one console list site and eight fileutil sites. The subtotal is ten, not the candidate's claimed602. Root go.mod proves direct testify identity; comments, strings and shadowed aliases cannot earn credit. One selected interval and forty-six unknown intervals remain distinct. Editable issue links corroborate shared delivery, not protected creation receipts. Module currency, full repository migration, assertion failure behavior, safety and costs remain unknown; not rated." },
    { workflowId: "eslint-miner", sourceGitBlob: "aff6103ce5105365ed2d9dd338164d06f871ba68",
      functionSha256: "7eb49b35a2f448d9c36fa051dc78c01f51baeeba9bd85717435e5395169ff762",
      timelineDigest: "d5639d4df3acc319be56d1a92238943e9989f3d4726b41f76b9baf981fa43d13",
      reports: "docs/operational-value/proof/lint-rule/reports/github-gh-aw",
      collector: collectEslintMining, scorer: scoreEslintMining, partialMetricId: "observed-partial",
      stage: "one native mkdirSync call newly locally guarded; full error-handling unknown",
      detail: "Exact two-file before/after originals establish one retained fs.mkdirSync expression newly enclosed in local try/catch. This is a narrow repository improvement, not successful execution, correct recovery or proof of useful diagnostic precision. The same call population and arguments are matched, so removals and unrelated aggregate changes cannot earn credit. One assessed interval and sixteen unknown intervals remain distinct. Source-first contract and outcome-informed retrospective facet versions are preserved. Full goal, workflow attribution, safety and costs remain unknown; not rated." },
    { workflowId: "linter-miner", sourceGitBlob: "d75aa4cc4fd28219f0db9b616f5abc5680f3bccc",
      functionSha256: "3e503465e09a323d815bfcd277a7655dadfba36fe02fad3160c29227309ac8ff",
      timelineDigest: "fb9e34b29eeb2c4737da7f3d89faccfad46650fe2c34c6d5cd7720941b69552f",
      reports: "docs/operational-value/proof/lint-rule/reports/github-gh-aw",
      collector: collectLinterMining, scorer: scoreLinterMining, partialMetricId: "observed-partial",
      stage: "two native library exits replaced by matched error returns; full propagation unknown",
      detail: "Native Go AST comparison establishes two library os.Exit sites replaced by ExitCodeError returns in the same functions with the same exit codes; original caller propagation is retained. These are actual selected repository-site transitions, not rules declared or tests authored. context.TODO substitutions and lint waivers are not accepted context propagation or repairs. One assessed interval and twenty-two unknown intervals remain distinct. Full semantic acceptance, complete diagnostic precision, workflow contribution, safety and costs remain unknown; not rated." },
    { workflowId: "eslint-refiner", sourceGitBlob: "104f17519e69a7c3a079ac4fa7e2428044627d6c",
      functionSha256: "59c3c1ebedffd8c0db4f4d26574ce1cdc5a583d14e1a71f355450c185f6cb43a",
      timelineDigest: "45d9895db3fcc519fceb66a33989d9dcae0d06d67626fe170997c5e0bcfcaf23",
      reports: "docs/operational-value/proof/lint-rule/reports/github-gh-aw",
      collector: collectEslintRefinement, scorer: scoreEslintRefinement, blocked: true,
      stage: "source compatibility correction retained; real-target diagnostic outcome unavailable",
      detail: "One standard Node EventEmitter alias compatibility correction is independently source-checked. Both selected original issues explicitly describe latent conditions with no live affected target. The source-only facet is available for inspection but is not real-target diagnostic coverage, delivered repository benefit or a completed native outcome evaluation. Seventeen periods retain one source-compatibility assessment and sixteen unknown intervals. Full acceptance, precision, workflow attribution, safety and costs remain unknown; not rated." },
    { workflowId: "designer-drift-audit", sourceGitBlob: "91261191d20f97e8c511ed9690db4dd283ea35b9",
      functionSha256: "70387e476fb7d57de8c767fbf859156a972af2fbe384cb3453abfee38828b198",
      timelineDigest: "08db4d14dece151e64efbfe80f4c6737b2aa33102b27d2f596795e367822f93b",
      reports: "docs/operational-value/proof/doc-accuracy/reports/github-gh-aw",
      collector: collectDesignerDrift, scorer: scoreDesignerDrift, partialMetricId: "factualRepairs",
      stage: "twelve native network-guidance repairs measured; full synchronization unknown",
      detail: "Exact original before/after guidance and stable contemporaneous reference contracts establish twelve invalid-network-shorthand corrections. A later assessed mapping change has zero accepted repairs because its configuration name does not match the independent schema; this is not zero semantic work. Twenty disjoint periods retain the two bounded observations and eighteen unknown periods. The original local-reference contract remains unchanged. Version2 was authored after reading candidate PR prose and is explicitly outcome-informed retrospective assessment, not blind/ex-ante acceptance. Full designer synchronization, generated-workflow correctness, workflow contribution, complete history and costs remain unknown; decision not rated." },
    { workflowId: "daily-doc-healer", sourceGitBlob: "424b398cdf60be1db7f87708e3d67012eafc81ac",
      functionSha256: "191601f27906be0b21b4ef5dd8b69e72671f7b1a54fdfcfdf312cbd2b18bf8f8",
      timelineDigest: "757588d0cb3c05b555011fa386bfb2bd5827c9276971dd25abfec3e5847923ae",
      reports: "docs/operational-value/proof/doc-accuracy/reports/github-gh-aw",
      collector: collectDocHealing, scorer: scoreDocHealing, partialMetricId: "factualRepairs",
      stage: "two native authentication-warning repairs measured; broader accuracy unknown",
      detail: "Two original documentation warnings are corrected to the named-token authentication error behavior independently verified in the contemporaneous unconditional implementation branch. The proposed toolset-removal facet remains rejected because search/experiments still occur in the authoritative schema enum. Thirty-four disjoint periods retain one bounded measured interval and thirty-three unknown intervals. Frozen v1 local-reference acceptance and rejected v2 predicates are preserved; v2 is explicitly outcome-informed retrospective authoring after candidate prose, not ex-ante acceptance. Full semantic gap resolution, maintainership prerequisites, workflow contribution, complete period populations, costs and keep decision remain unknown/not rated." },
    { workflowId: "daily-doc-updater", sourceGitBlob: "02aebaffb8fbe3201e5a5c8a0ee6acf2e9be24cb",
      functionSha256: "d20a2d1cdd9246c8b1a5633d55b3361ca4525d0f377024f1d645c59105fc4227",
      timelineDigest: "3fd5e8f37fff7260e9f74955ab66fad0cc0ab5b6471d3d73ee5af47cff053669",
      reports: "docs/operational-value/proof/doc-accuracy/reports/github-gh-aw",
      collector: collectDocUpdates, scorer: scoreDocUpdates, partialMetricId: "factualRepairs",
      stage: "one native safe-output option contract documented; full feature coverage unknown",
      detail: "Original parent/child documentation plus stable native schema and handler establish one explicit link-sub-issue target=\"*\" parent-selection contract. A CLI flag appears in an options list/prose rather than the frozen exact-row predicate and remains rejected, not retuned into acceptance. Fifty-three disjoint periods retain one assessed zero, one accepted partial repair and fifty-one unknown periods. Original v1 and rejected predicates survive; v2 is outcome-informed retrospective assessment after candidate prose. Full feature accuracy, runtime execution, workflow contribution, complete history, costs and keep decision remain unknown/not rated." },
    { workflowId: "claude-code-user-docs-review", sourceGitBlob: "040ec6b88ae91baa0af077daf9b23401f90be806",
      functionSha256: "d6e3ca6568d14d89e93408512ec3074be515cfc68aa5cba4723e82cd6c2787e2",
      timelineDigest: "388f57656fdad6143cf3bc483c7e1b14dc3b6324cc082d81111128d52033a58e",
      reports: "docs/operational-value/proof/doc-consolidation/evaluations/github-gh-aw",
      collector: collectClaudeOnboarding, scorer: scoreClaudeOnboarding, partialMetricId: "native-improvements",
      stage: "one native Claude API-key onboarding barrier repaired; latest interval unknown",
      detail: "An immutable core-document change repairs one missing add-wizard Claude API-key setup instruction, independently checked against six contemporaneous original Go implementation files without executing target code. The October4-11 interval has one accepted barrier repair; the latest interval is unknown, never an older-success fallback. Thirty-nine disjoint periods retain this one partial and thirty-eight unknown intervals. Actual introduction/real-parent absence are proven; the assessment is explicitly retrospective fixed-reference, not backdated acceptance. The other selected architecture/quick-start change is not accepted. Human usability, WIF correctness, full goal, Discussion discovery, workflow attribution and costs remain unknown/not rated." },
    { workflowId: "developer-docs-consolidator", sourceGitBlob: "56150ba5b670e7b088c45e7106ebafbe3946d75a",
      functionSha256: "6dfad272ca15acbfc7842962c45d26b595d2c062733ee4bb0dfe9af4a2983d4f",
      timelineDigest: "396b6295eddcbabc31c029342567d1b6b0b613c8573912a879ea1bfa05701ca5",
      reports: "docs/operational-value/proof/doc-consolidation/evaluations/github-gh-aw",
      collector: collectDocConsolidation, scorer: scoreDocConsolidation, partialMetricId: "native-improvements",
      stage: "bounded native nonacceptance measured; no lossless source consolidation proven",
      detail: "The selected original merged change touches only scratchpad/dev.md and establishes zero accepted redundant source-occurrence removals under the unchanged narrow predicate. This is one assessed native nonacceptance, not zero semantic work or zero whole-period value; forty-nine other intervals remain unknown. The earlier candidate targets .github/agents/developer.instructions.md, outside the frozen current target, and is not backdated into eligibility. Actual introduction and real-parent absence proofs remain distinct from later source eras. Full content preservation, searchable usability, semantic quality, workflow contribution, complete history, matched costs and keep decision remain unknown/not rated." },
    { workflowId: "unbloat-docs", sourceGitBlob: "fd6994d6473be8d40b22805f406b20e0848da8ea",
      functionSha256: "6570d5cc017ebc3f722718fdf7e3b687c82aeaebb83c96b6dc0e2c22768b6e29",
      timelineDigest: "8d06db0df9dba13c09e673b497105aa63d58e49e2e12c1403d47de22bfcc561c",
      reports: "docs/operational-value/proof/doc-consolidation/evaluations/github-gh-aw",
      collector: collectUnbloat, scorer: scoreUnbloat, blocked: true,
      stage: "native scope mismatch and unmerged candidate retained; no accepted unbloating proof",
      detail: "The earliest selected merged change edits an excluded blog document, while the latest selected PR is unmerged. Neither establishes eligible content-preserving duplicate removal. All fifty-four disjoint periods remain unknown; a source-era scope mismatch is not zero historical delivery. Exact original source introduction, real-parent absence, selected PR metadata/full file paths and immutable native custody are preserved. The deterministic function and all-null gap report are available, but add no native coverage. Reduced words, merges, line counts and agent bloat scores are not semantic preservation; full acceptance, workflow contribution and costs remain unknown/not rated." },
    { workflowId: "smoke-pydantic", sourceGitBlob: "39e64a09ad74877e7533d69f858e9a479f9ce318",
      functionSha256: "20bdc5ccbf59985d9ebab4ff7e05d454cbf153d45cfb9a8dd232f69a4f354faf",
      timelineDigest: "918eb5021dc3a7a088d47e993b8bc9cf328e92efd3a36c77a3d9ebd68620f55e",
      reports: "docs/operational-value/proof/smoke-pydantic/reports/github-gh-aw",
      collector: collectPydanticReads, scorer: scorePydanticReads, partialMetricId: "linked-python-read-cases",
      stage: "one native Python README read measured; strict read_file absent, full goal unknown",
      detail: "The October17 original authenticated recorder contains three successful native run_code pathlib reads of the immutable run-head README first line, deduplicated to one producer-bound Python filesystem-read case. This is not read_file conformance: that tool is absent from the complete selected canonical trace, establishing scoped strict zero, while the October9 console-only mention/429 remains unknown. Eleven disjoint periods retain one partial positive period and ten unknown periods. Calculator outputs are not standalone model answers; host tools/list responses without request IDs do not prove agent-usable MCP or transport. Original protected consumers report incomplete signals and empty applied items, not prescribed persistence. Actual workflow introduction is proven, but its initial write/bash/git goal differs and the later goal is not backdated. Full acceptance, complete-population totals, comparable movement, full-period costs and keep decision remain unknown/not rated; the strict predecessor remains unchanged." },
    { workflowId: "smoke-ci", sourceGitBlob: "435a00b593ced2327e01fd84c7cc93fdb45f8fae",
      functionSha256: "ec52879d626e67a8f964ab21693e9c286bc2b431f2c86c175bf72f95804153d7",
      timelineDigest: "67461160fa91f0267c29c0491cfaec1bd3d3d4933535dc65ad91d2130f40e4c6",
      timelinePath: "docs/operational-value/proof/smoke-ci/report/smoke-ci-timeline.json.gz",
      plotPath: "docs/operational-value/proof/smoke-ci/report/smoke-ci-pulse.html.gz",
      collector: collectCiReplay, scorer: scoreCiReplay, blocked: true,
      stage: "native qualification rejected; candidate originals do not establish workflow effects",
      detail: "Two original PR-event attempts from disjoint days retain candidate PR comment populations of nine and six. None contains the unchanged source-defined message line, but empty original pull_requests arrays leave both targets unbound and actual executed workflow revisions remain unknown. The first protected logs expired with HTTP410 and its artifact inventory is empty; neither is native zero. All184 disjoint periods, strict samples acceptance, historical CLI facet, independent postcondition and contribution remain unknown. Exact source/compiled/processor originals, all prior predicates and lossless failure receipts are retained. The forensic function and gap report replay deterministically; this is not a new native evaluation, proof of absent samples-era runs, complete history, measured cost or a keep/retire decision." },
    { workflowId: "smoke-drive", sourceGitBlob: "b807269a21552c0e6ac518da7c44056024047e95",
      functionSha256: "d125c8322ca0fa41e242fc5b6e1404ae18e90e3b1580a570389e23d2c50098ed",
      timelineDigest: "1f991e818f65712ffe1b409fcad16799b4d7911570ebf32594056fb4bf145e5e",
      reports: "docs/operational-value/proof/smoke-drive/reports/github-gh-aw",
      collector: collectDriveMemory, scorer: scoreDriveMemory, partialMetricId: "same-run",
      stage: "two native drive-memory attempts blocked before agent start; scoped zero, persistence unknown",
      detail: "Provider-digest-verified original artifacts, exact-attempt protected logs and complete source/import/compiled custody establish drive-service permission denial before either agent starts. The latest partial cohort has two assessed attempts, zero same-run acceptance and zero full-goal acceptance; restored persistence and actual git-log access remain unknown. The other eight periods are unknown, not zero. All25 direct/37 closure candidates and two earlier metadata-only runs remain discovery. Actual introduction and real-parent absence are proven by raw Git commit/tree path proofs. Standard collector and frozen evaluation replay; earlier unresolved rejection and predecessor reports are preserved. This retrospective case study is not a complete execution census, measured positive delivery, comparable trend, keep decision or deployed memory collector; costs remain unmeasured." },
    { workflowId: "smoke-copilot-small", sourceGitBlob: "fd2c6bfd12686d9d41a06728fa1e810b9662c6fb",
      functionSha256: "86af9761e6d9a0057ddd46b3627bd4db0e193c69500089ade1b7f34cee4497b9",
      timelineDigest: "67adc9a036309c7f12d4a4a4f14141aea7b6012ebc88043717fc6874aa263fa1",
      reports: "docs/operational-value/proof/smoke-copilot-small/report/github-gh-aw",
      collector: collectSmallModel, scorer: scoreSmallModel, partialMetricId: "arithmetic",
      stage: "native small-model arithmetic measured; strict file readback and full acceptance unknown",
      detail: "Own-workflow protected execution and provider-digest-verified artifact establish one actual Bash calculation returning42. The frozen report retains15 periods: latest partial1 and14 unknown. Native creation records three newlines and cat|wc separately reads three newlines, but that is not full-content readback or a byte-and-order write/readback join; both strict metrics remain unknown. Imported Playwright Chromium launch fails GLIBC_2.43 despite shell pipeline exit0, which is not success. Original-haiku and full imported acceptance remain unknown. All84 direct candidates/80 run IDs and152 related identities remain discovery, not accepted work. Real introduction and exact run-head source/import/compiled custody are retained; costs and keep decision remain unmeasured/not rated." },
    { workflowId: "smoke-copilot-sdk", sourceGitBlob: "baf972d19ce8044f2c3b4eecf127aa0ab7db74ec",
      functionSha256: "c516ce25cb2d8d397b5a5aa2f8a231820c4da0e0c6369a4d774e32df25533f98",
      timelineDigest: "274d9cb78462f05ef9b71e0ec42e2cf16f745afdb0e1050d101e23a8b6db4a05",
      reports: "docs/operational-value/proof/smoke-copilot-sdk/prospective-frozen/github-gh-aw",
      collector: collectSdkEffects, scorer: scoreSdkEffects, partialMetricId: "native-facets",
      stage: "protected native SDK readback and arithmetic measured; full file effect unknown",
      detail: "The actual frozen standard evaluation preserves 36 disjoint periods, 35 unknown and one partial period with two independently corroborated effects: one exact cat-phrase readback and one actual Bash arithmetic stdout42. Original provider artifact and protected attempt1/job/step30 frames agree on the same compound call, SDK1.0.16, CLI1.0.98 and source/runtime identities. File absence-before, new regular-file transition and current-date correctness remain unknown; compound execution is not relabeled standalone argv. The actual February introduction is separately verified, not permission to apply the later goal to earlier eras. SDK linkage is two receipt-verified contributions, not sole causation. Full goal, complete history, costs and keep decision remain unknown/not rated; original rejection and predecessor are preserved." },
    { workflowId: "smoke-service-ports", sourceGitBlob: "ca493fccc2f54978d810cf6d93bbdf42dfa89313",
      functionSha256: "ddb0db3bc0dc9b571394f5c5bc59646948e085160e82f04cbfb7e361c6c8d62a",
      timelineDigest: "10467a4897f28708743ab3803a194f82596affe2c8217c6db554545714f135eb",
      timelinePath: "docs/operational-value/proof/smoke-service-ports/retrospective-cutoff/timeline.json",
      plotPath: "docs/operational-value/proof/smoke-service-ports/retrospective-cutoff/production-pulse.html",
      reportPath: "docs/operational-value/proof/smoke-service-ports/retrospective-cutoff/retrospective-pulse.html",
      reportSha256: "2315cd04677d188ac06a038d6bda2393b5c5b0ee23bc54faf25ea3aa387009bf",
      collector: collectRedisCases, scorer: scoreRedisCases, partialMetricId: "verified-redis-cases",
      stage: "source-matched retrospective Redis cases measured; standard cutoff rejection preserved",
      detail: "Explicit retrospective reconstruction at the frozen cutoff establishes three native cases, one host-bound integration session and three receipt-linked case contributions: PONG, exact SET/GET service-ports-ok and source-defined first-five-line INFO server projection. Original typed responses, protected attempt1/job/step31, actual-head compiled boundary and host allowance are replayed. This is not ex-ante historical acceptance, an adoption comparison, or standard evaluator success: unchanged October19 activation still causes the preserved actual standard cutoff rejection. Prior cohort is unknown, not zero; no complete population, trend, restart durability, costs or keep decision is invented. Exact function, contract, prior null snapshot and rejection remain unchanged." },
    { workflowId: "changeset", sourceGitBlob: "66950e20545bc3608d6daac3343e6d0e978d4726",
      functionSha256: "c41267c0e94b906d7d86902624cb4295742203897d600d3ae01f1435e6dbaae8",
      timelineDigest: "04da96d0b02cce9ed67755eff2162b9eb9f702e0ed66eef89b0722577f1c86e0",
      reports: "docs/operational-value/proof/changeset/evaluation/github-gh-aw",
      collector: collectChangesets, scorer: scoreChangesets, partialMetricId: "release-readable",
      stage: "native release-readable transitions measured; semantic accuracy and history gaps open",
      detail: "The October 4-11 period establishes 21 newly release-readable files, 21 newly nonempty descriptions and 12 explicit-format transitions from 22 assessed transitions with 22 missing. October 11-18 has zero assessed and 62 missing, so current value remains unknown, not zero or a complete trend. The cutoff's 731 readable files are a retained snapshot, not recurring delivery. Exact consumer-parser quirks and source/parent/diff bytes are preserved. Semantic accuracy, completeness, bump appropriateness, regression safeguards and workflow contribution remain unknown; costs are unmeasured and no keep bar is invented." },
    { workflowId: "step-name-alignment", sourceGitBlob: "17e5d2e7270b0e3e185e670ce552bf8075c764b8",
      functionSha256: "7b071f2220499afe3e323619ab02945c840a28399081973139cc65017e8bcf35",
      timelineDigest: "f8987d26899d8ba0811f539a6489421e41ec23e425431fd0c324763945214184",
      reports: "docs/operational-value/proof/step-name-alignment/report/github-gh-aw",
      collector: collectStepNames, scorer: scoreStepNames, functionReady: false,
      stage: "native lexical subtotals retained; complete semantics and contribution missing",
      detail: "Forty disjoint periods retain native compiled-step/glossary comparisons. Three partial periods ending October 4, 11 and 18 establish observed lexical-repair subtotals of zero from 11, 74 and 72 readable pairs, not zero total workflow value. Full semantic quality and period delivery remain unknown. All 134 marker candidates and 2,733 lineage entities are discovery; 850 Git objects are retained, but only 51 of 344 current locks and neither adoption blob are readable. Independent semantic adjudication, secondary dictionary contents and protected contribution receipts remain missing. Full function readiness is false." },
    { workflowId: "daily-syntax-error-quality", sourceGitBlob: "8dae2d78259ddc6dcd2e81ef156a246accfba506",
      functionSha256: "462fa7418078739f91377cf8378966ebef3fbd7c6294e1047503da56a39b9eb3",
      timelineDigest: "9d20adc84b0815716a93dd0883193eaf8543c377d966eb38d4d96bdf1acdbfe5",
      reports: "docs/operational-value/proof/daily-syntax-error-quality/evaluation/github-gh-aw",
      collector: collectSyntaxQuality, scorer: scoreSyntaxQuality, functionReady: false,
      stage: "closed native diagnostic facets retained; production originals unavailable",
      detail: "The numeric-engine oracle decodes actual native diagnostic JSON, text, build-info and exact before/after inputs. Correct locations and exact restoration repairs are separate partial facets, not agent-quality scores or full developer usability. All production values remain unknown. Thirty-two current source files and 69 discovery candidates are retained; compiled workflow, toolchain source, original inputs/results/build receipts, independent usability and workflow-linked delivery remain open. Fixtures do not enter native history, and full function readiness is not claimed." },
    { workflowId: "daily-model-resolution", sourceGitBlob: "3471ba651640eddacc0d18bab008bba570a347d6",
      functionSha256: "cfd556cc3367577d09b9318ec2c0f56fa98e3e0523c7cd9bb98f049f04ccd306",
      timelineDigest: "bfbde16399b4a2b24d1c4ea953bfbbb57e500519f376d81c67109cb551c0f6aa",
      reports: "docs/operational-value/proof/daily-model-resolution/reports/github-gh-aw",
      collector: collectModelResolution, scorer: scoreModelResolution, functionReady: false,
      stage: "native schemas reviewed; independent child-to-proxy binding unavailable",
      detail: "Current/adoption sources and compiled originals are retained. The diagnostic decoder reads both original fixture schemas: five child starts carry agent/tool-call IDs, but none of the 29 proxy rows supplies a shared independent child/request identity. Aggregate metrics, model/token matching and timestamps cannot establish that bridge; unreviewed child-ID extensions are rejected. All 59 disjoint windows and the original function/timeline remain unchanged. Ninety-two lineage candidates and parser fixtures are not outcomes. Full function readiness, native producer authentication, source-era compatibility, inherited acceptance and contribution remain open." },
    { workflowId: "daily-observability-report", sourceGitBlob: "96a8de8af62e2e84d0a1f54c6e0cfdafc132daf1",
      functionSha256: "4bef54d77456292b2c30ad666bb5227b6599920cd2c0008cd6aae8ccfbc58de1",
      timelineDigest: "9c347b97c729ce4ac064b83c8eead1fae85865bfe84ddb36ce84086939bf194b",
      reports: "docs/operational-value/proof/daily-observability-report/reports/github-gh-aw",
      collector: collectTelemetryCoverage, scorer: scoreTelemetryCoverage,
      stage: "current-profile native telemetry function replayed; raw cohorts and artifacts pending",
      detail: "Current source, imports, native schemas and compiled workflow are retained. The adoption source has a different gateway-only population; the current capped cohort and RPC fallback are not backdated into unverified eras. All 40 disjoint periods remain unknown. Seventy lineage candidates are discovery, not telemetry coverage. Original eligibility inventories, raw artifacts, baseline reconstruction and contribution remain open; current sample coverage is not fleet-wide debugging or firewall acceptance." },
    { workflowId: "daily-safe-outputs-conformance", sourceGitBlob: "c6e53bc51866009d78d03b17b7ba371bf9b38ad3",
      functionSha256: "017563b7dedba92d7de8f870d5266cd6509634a3fc14ff05fbc74b45b093f11e",
      timelineDigest: "6630800aff6362f056e1a947fb5bb3e6a5bff99fb4be75fedcd170c437d3546c",
      reports: "docs/operational-value/proof/daily-safe-outputs-conformance/reports/github-gh-aw",
      collector: collectSafeOutputConformance, scorer: scoreSafeOutputConformance,
      stage: "source-reviewed partial checker replayed; native remediation unproven",
      detail: "Entire current/adoption specifications and all 55 source-cited rule families are reconciled: 20 remain partial lexical checks and 35 unimplemented. Three unsuppressed findings and 13 suppressed raw findings do not prove full behavioral conformance, remediation or workflow contribution. Source-derived v2 excludes required-file creation from surviving-file clearance and retains the sealed v1 instrument/function. Native baseline, missing source objects and original producer/remediation evidence remain open; attainment-only output is provisional." },
    { workflowId: "blog-auditor", sourceGitBlob: "b641655a917ed1502a3cea3f7cddc511588e84c0",
      functionSha256: "2f4c3947d71b8b0d077b93c0633520069afb19e7d99c588a8bba7c7e783bcca0",
      timelineDigest: "14a57fe602c84a24e301471174e632133c8e78496b4054eaa31ade64b602c128",
      reports: "docs/operational-value/proof/blog-auditor/reports/github-gh-aw",
      collector: collectBlogAudit, scorer: scoreBlogAudit,
      stage: "native page-check function replayed; original audit observations pending",
      detail: "Complete current/adoption source closures and 52 disjoint cohorts are retained. No independent page-check observations exist. Six provisional no-opportunity zeros in the leading partial cohort are not delivery; 306 assessments remain unknown. Discovery and original browser/compiler/producer evidence remain open." },
    { workflowId: "weekly-editors-health-check", sourceGitBlob: "e7d3355795fb9c5b79e6201300fc35d3e09c4e4b",
      functionSha256: "1accbcef17c6392a0b0163807914515c25b4172ad41c30457db4fa3ad5c4ce21",
      timelineDigest: "74d0718d9950386dab36247d49d9af6761686fa94116fd3a0c556a02416cf26e",
      reports: "docs/operational-value/proof/weekly-editors-health-check/reports/github-gh-aw",
      collector: collectEditorHealth, scorer: scoreEditorHealth,
      stage: "native HTTP-status function replayed; original responses pending",
      detail: "Both source/compiled eras and all 12 historical editor inventories are retained. The provider listing returned 79 matching runs, including 61 without retained output seeds. Original protected latest-run logs contain no editor HTTP invocation; denied source inspection and safeoutputs RPC status 200 are not editor failures or availability. All 36 native assessments remain unknown. Original response acquisition for the other runs remains open; full predecessor proofs are preserved." },
    { workflowId: "daily-cli-performance", sourceGitBlob: "3c67fd8d57eeefa431030bc9c2c8e21618536f6e",
      functionSha256: "600cc3e8e43f807759e24a7008f5f4e40c368d37809bb6f0290d5bc6490ab8dd",
      timelineDigest: "d5aae2c2c7bba23f5b9eb173570b164047dec53803443ad7e9b798c7036b2abb",
      reports: "docs/operational-value/reports/github-gh-aw",
      collector: collectCliPerformance, scorer: scoreCliPerformance,
      diagnosticReportPath: "docs/operational-value/reports/github-gh-aw/daily-cli-performance-native-diagnostic.html",
      diagnosticSha256: "745fa70963825a7de4ffbdd90b3bd85a7128829c4cc194a86e19c4a9e4a03c5a",
      stage: "native benchmark diagnostic replayed; accepted compile latency unproven",
      detail: "Original artifact and protected log agree on 7,187,936 reported ns per attempted operation, three iterations, 3,765,650 B/op and 26,807 allocations/op. The benchmark discards fixture compilation errors and one protected unit shard fails. All 291 accepted latency values remain unknown; the separate one-point diagnostic is not an improvement trend or workflow contribution. Historical discovery/pagination and original receipts remain open." },
  ]) {
    const timeline = await retainNativePendingReport(progress, entry);
    if (entry.partialMetricId) measurements.push({ workflowId: entry.workflowId, input: timeline });
  }
  for (const assignment of [
    { workflowId: "artifacts-summary", sourceGitBlob: "f692218fe9dfec7d6de9cea16e0d0098f5d69603",
      stage: "native inventory reconciler retained; original reports and page sequences missing",
      detail: "The owned native decoder, ten-source closure and 22-test reconciliation instrument are retained. All 11 issue candidates remain discovery; Discussions are outside the issue/PR inventory. Six artifact records totaling 111,598,804 bytes are not proof of report accuracy. Original report bodies and contemporaneous complete workflow/run/artifact pages are missing. The frozen evaluator rejection and separate all-null prospective report remain preserved, not admitted as native outcomes. Full native measurement and contribution remain unknown." },
    { workflowId: "workflow-normalizer", sourceGitBlob: "abfac1d367ff164b08c7184ef9b24174373fb91e",
      stage: "closed partial style checker retained; protected production bindings missing",
      detail: "Six complete sources and 267 discovery candidates are retained. Closed-syntax content-preserving heading, bold-summary and identical-run-link repairs are fixture-proven partial facets, not full readability or measured production work. Numeric scoring admits only sealed synthetic fixtures until real producer bindings exist. Activation follows the frozen cutoff; the later all-null prospective report is separate and not admitted here. Original report revisions, authoritative active cohort, edit times, protected producer custody and contribution remain missing; full function readiness is false." },
    { workflowId: "cli-consistency-checker", sourceGitBlob: "1c1b852850fd69016d2b550a9adb38219eb11f30",
      stage: "native documentation snapshot retained; runtime and full command acceptance missing",
      detail: "The exact-cutoff raw-source snapshot satisfies 22 of 22 implemented literal documentation obligations, only one partial facet; one registry-dependent obligation remains unresolved. This is not defect-free commands, historical improvement or workflow contribution. Original help/example/behavior and protected producer receipts are missing. Activation equals the cutoff, so no earlier standard period is invented; the prospective all-null report after the frozen cutoff remains separate. All 2,931 related lineage entities remain discovery. Full function/native outcome readiness is not claimed." },
    { workflowId: "daily-model-inventory", sourceGitBlob: "809b23ebbfc03d891701382286cf0c3417c6b153",
      stage: "native alias oracle retained; independent provider inventories missing",
      detail: "The corrected ownership package preserves all 20 original members and proves the relocated function differs only by one codec import. Complete current source defines 62 aliases; all live-support states remain unknown without complete independent dated provider inventories. SDK, routing, pricing and capability acceptance remain separate and unmeasured. Snapshot support is not recurring delivered repair. Historical transitive closure, baseline and native producer capture remain open; no full function/native measurement readiness or further acquisition is claimed." },
    { workflowId: "daily-credit-limit-test", sourceGitBlob: "950ad1930ee32372cb8f254b36eee121cbc94254",
      stage: "source correction retained; predecessor trigger contract not admitted",
      detail: "The offline checker, all 14 original members and additive 13-source review are retained. The actual checker bypasses every workflow_dispatch, contradicting the predecessor's routed-dispatch eligibility; applicable current scope is schedule only, not automatic proof of eligibility. Adoption used cap 10/copilot rather than current cap 1/pi. Native ledger, authenticated inference audit, executed checkout and publication receipts remain missing. The unchanged prospective report ends after the frozen cutoff and is not admitted here. No full function readiness, accepted outcome, historical backdating or further acquisition is claimed." },
    { workflowId: "daily-aw-cross-repo-compile-check", sourceGitBlob: "a4726c28d67f33d3d45e0ff288aaffdfd0498233",
      stage: "offline compatibility checker retained; protected producer and cohort missing",
      detail: "Complete 11-file current source closure, original compiled bytes, strict native decoder and portable collector are retained. Agent-writable compile/cache state and successful jobs are not protected compilation proof. Selected cohort, assessed compiler/toolchain and independent original results are absent; adoption and baseline remain unknown, not exhausted. The prospective all-null report ends after the frozen cutoff and is not admitted here. No full function or native measurement readiness, contribution or further acquisition is claimed." },
    { workflowId: "avenger", sourceGitBlob: "c2dc70ea2ff6d1e684b4cfd17c3a1e61bb85f56d",
      stage: "partial native repair decoders retained; original failure and landing proofs missing",
      detail: "Five native receipt decoders, portable collector and all-null current-source report are retained; this is not a complete all-checker instrument or protected producer. Distinct condition identity, fail-before/pass-after, unchanged requirements, Git ancestry and main landing define repairs independently of actor. All 344 lineage records are discovery only. Missing native checkers, current source inputs, historical compiled content, original checks and producer authenticity remain open. No baseline, accepted repair, full function readiness, contribution or further acquisition is claimed." },
    { workflowId: "daily-model-resolution", sourceGitBlob: "3471ba651640eddacc0d18bab008bba570a347d6",
      stage: "offline source-first native contract authoring",
      detail: "An isolated workflow session is reviewing complete source/import/checker semantics before freezing dispatch-to-proxy model-resolution acceptance. No function or native outcome is admitted yet; parent inference records cannot substitute for child evidence. Network acquisition is not released." },
    { workflowId: "daily-observability-report", sourceGitBlob: "96a8de8af62e2e84d0a1f54c6e0cfdafc132daf1",
      stage: "offline source-first native contract authoring",
      detail: "An isolated workflow session is deriving usable raw MCP telemetry predicates and source-defined cohort eligibility. No function or native outcome is admitted yet; report claims and successful jobs are not telemetry coverage. Network acquisition is not released." },
    { workflowId: "daily-safe-outputs-conformance", sourceGitBlob: "c6e53bc51866009d78d03b17b7ba371bf9b38ad3",
      detail: "An isolated workflow session is reconciling source-defined checker/specification rules and independent findings; successful runs and remediation reports are not full behavioral conformance." },
    { workflowId: "daily-cli-performance", sourceGitBlob: "3c67fd8d57eeefa431030bc9c2c8e21618536f6e",
      detail: "An isolated workflow session is binding original native Go benchmark quantities to source, producer, compile correctness and compatible profiles; incompatible fixtures and hardware are not an improvement trend." },
    { workflowId: "blog-auditor", sourceGitBlob: "b641655a917ed1502a3cea3f7cddc511588e84c0",
      detail: "An isolated workflow session is verifying original browser/page/snippet evidence against source-defined audit goals; agent narratives and present-day requests cannot prove historical technical coverage." },
    { workflowId: "weekly-editors-health-check", sourceGitBlob: "e7d3355795fb9c5b79e6201300fc35d3e09c4e4b",
      detail: "An isolated workflow session is binding source-era editor inventories to original HTTP responses. Source changes and available screenshots do not establish historical editor availability." },
    { workflowId: "purelock", sourceGitBlob: "cd4498980967d37ec386d300b11bba18793ebfde",
      stage: "native coverage join; CI artifact acquisition paused",
      detail: "Two full-population native observations are retained in the isolated session; a third requires the complete independently source-bound CI coverage artifact set. Actions acquisition is temporarily quota-blocked, not absent history. Parent integration remains pending." },
    { workflowId: "daily-elixir-credo-snippet-audit", sourceGitBlob: "32d6520ef2d5667ec2e76950879438e7c532d117",
      detail: "An isolated workflow session is implementing source-defined snippet eligibility and pinned native Credo diagnostics. Missing tooling or context is not clean lint." },
    { workflowId: "smoke-work-queue", sourceGitBlob: "342c95aaaa713668340a9ea9f3c97764f234f6fe",
      detail: "An isolated workflow session is implementing independent queue-behavior evidence. Successful runs and editable tracking markers are not conformance proofs." },
    { workflowId: "smoke-create-cross-repo-pr", sourceGitBlob: "4d112feef189a2c36c76927a25bf96fee2efdb41",
      detail: "An isolated workflow session is verifying source-defined cross-repository patch contents, branch and provenance; PR existence is not delivery proof." },
    { workflowId: "smoke-update-cross-repo-pr", sourceGitBlob: "219be9c4d425130eeed0e2891de7c821b85ce7cf",
      detail: "An isolated workflow session is verifying exact sequential target-branch updates without duplicate source lines." },
    { workflowId: "smoke-multi-pr", sourceGitBlob: "edc4cd49f2c9fb6ce86eaebcb9c74108b4da325a",
      stage: "native delivery proof; remaining receipt acquisition paused",
      detail: "Two exact delivered payloads, including preserved CRLF, are established in the isolated session. Historical log, artifact and PR readbacks remain explicitly open. The parent has not yet integrated and independently replayed the handoff." },
    { workflowId: "smoke-temporary-id", sourceGitBlob: "24368e226f6cc0c5ddbf45d8c35a6a500ba3a94d",
      stage: "partial native joins; handoff integration review",
      detail: "The manifested child handoff reports 36 independently resolved body references and 12 graph links across six mapped executions, with three full acceptances. Original public graph/comment readbacks were acquired centrally. Parent replay/registration is pending; historical eligibility and receipts remain incomplete." },
    { workflowId: "smoke-workflow-call-with-inputs", sourceGitBlob: "08d153af00652b150838280e72700fcd9a3a36af",
      stage: "native source binding; historical log acquisition paused",
      detail: "2,459 runs and candidate job/artifact inventories are retained; no native accepted outcome is established. The source join now uses original referenced_workflows merge SHAs. Exactly 950 remaining log requests are temporarily quota-blocked, not provider-unavailable evidence; an interim handoff is pending parent integration." },
    { workflowId: "smoke-copilot-dynamic-workflow", sourceGitBlob: "c9663c6985318c8e2d0dfa833f62ca06873541c7",
      detail: "An isolated workflow session is verifying packaged dynamic-workflow invocation and exact source-defined result fields." },
    { workflowId: "smoke-checkout-pr-dispatch", sourceGitBlob: "d03a4f83ff8fa6cb0a582b8cf4151e0268924ec4",
      detail: "An isolated workflow session is verifying actual Git checkout state against original PR and dispatch event identities." },
    { workflowId: "smoke-test-tools", sourceGitBlob: "a15b40b270aac767d61c9a27c57ddd3e99496933",
      stage: "partial native tool receipts; versioned handoff review",
      detail: "An isolated session has real protected native container-tool receipts, not agent-report proxies. The source-bound decoder is being extended with a sealed predecessor; historical log requests remain temporarily quota-blocked. These positive partial results await parent replay and are not yet counted as integrated native coverage." },
    { workflowId: "lockfile-stats", sourceGitBlob: "342d6d8771dca0836d291f69810de61353566149",
      stage: "partial native statistic reconciliation; handoff packaging",
      detail: "The isolated session reports 30 source-bound full-population V4 censuses, 3,899 independently reconciled facts and 14 verified inaccuracies. Dynamic configuration leaves explicit unknown assertions; 17 acquisitions remain paused. Lossless deduplicated source inputs and native reports await parent integration; no trend is claimed." },
  ]) {
    if (!progress.some(entry => entry.workflowId === assignment.workflowId)) {
      progress.push({ ...assignment, stage: assignment.stage ?? "parallel workflow authoring",
        functionReady: false, evidenceReady: false, evaluationReady: false, plotReady: false });
    }
  }
  return { measurements, progress };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [historyDirectory, outputDirectory, ...extra] = process.argv.slice(2);
  if (!historyDirectory || !outputDirectory || extra.length) throw new Error(
    "usage: node scripts/build-gh-aw-value-portfolio.mjs OUTPUT_HISTORY NEW_REPORT_DIRECTORY");
  const history = readOutputHistory(historyDirectory);
  if (history.index.repository !== "github/gh-aw") throw new Error("This proof adapter is scoped to github/gh-aw");
  const proposals = readCensusJson("docs/operational-value/gh-aw-census/contracts.json.gz").contracts;
  const { measurements, progress } = await currentPortfolioInputs();
  const portfolio = workflowPortfolio(history, proposals, measurements, progress);
  portfolio.historyIndexSha256 = censusDigest(history.index);
  const retained = path.join(outputDirectory, "evidence");
  if (!existsSync(path.join(retained, "history.json.gz"))) {
    mkdirSync(retained, { recursive: true });
    for (const part of history.index.partitions) {
      copyFileSync(path.join(historyDirectory, part.file), path.join(retained, part.file));
    }
    copyFileSync(path.join(historyDirectory, "history.json.gz"), path.join(retained, "history.json.gz"));
  }
  else if (censusDigest(readOutputHistory(retained).index) !== portfolio.historyIndexSha256) {
    throw new Error("Retained acquisition differs; use a new report directory");
  }
  writeWorkflowPortfolio(outputDirectory, portfolio);
  console.log(JSON.stringify(portfolio.totals));
}
