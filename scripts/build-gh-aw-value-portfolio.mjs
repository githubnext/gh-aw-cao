import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { workflowPortfolio } from "../.github/skills/add-operational-value/scripts/portfolio-model.mjs";
import { escapeXml, sha256File } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { renderPulse } from "../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { timelinePulse } from "../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { fileDietValueEvents } from "./build-file-diet-value-events.mjs";
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

function verifyNativePlot(timeline, plotPath, workflowId) {
  const model = timelinePulse(timeline);
  if (timeline.repository !== "github/gh-aw" || model.workflowSlug !== workflowId
    || model.sourcePath !== `.github/workflows/${workflowId}.md`
    || model.window.endAt !== "2026-10-18T15:00:12Z"
    || readFileSync(plotPath, "utf8") !== renderPulse(model)) {
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
    reportAvailable: true, reportPath, blocked: false,
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

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:auto;padding:24px;color:#1f2328;background:#fff}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #d1d9e0;vertical-align:top}
a{color:#0969da}code{overflow-wrap:anywhere}dt{font-weight:600}dd{margin:0 0 16px}p{max-width:85ch}.scroll{overflow:auto}</style>
</head><body><main>${body}</main></body></html>\n`;

export function writeWorkflowPortfolio(directory, portfolio) {
  mkdirSync(directory, { recursive: true });
  const copyRetainedReport = (sourcePath, filename) => {
    const source = realpathSync(sourcePath);
    if (!source.startsWith(`${realpathSync("docs/operational-value")}${path.sep}`)
      || path.basename(source) !== filename) {
      throw new Error("Retained report must be a workflow-owned operational-value report");
    }
    copyFileSync(source, path.join(directory, filename));
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
  const rows = workflows.map(workflow => `<tr><td><a href="${text(links.get(workflow.id))}">${text(workflow.id)}</a></td>
<td>${text(workflow.measurement.status)}${workflow.measurement.progress?.partial ? " (partial; open history)" : ""}${workflow.measurement.progress
    ? `<br><small>Function ${workflow.measurement.progress.functionReady ? "ready" : "pending"} &middot;
Evidence ${workflow.measurement.progress.evidenceReady ? "acquired" : workflow.measurement.progress.blocked ? "unavailable" : "pending"} &middot;
Evaluation ${workflow.measurement.progress.evaluationReady ? "complete" : workflow.measurement.progress.reportAvailable ? "gap report" : "pending"} &middot;
Plot ${workflow.measurement.progress.plotReady ? "complete" : workflow.measurement.progress.reportAvailable ? "gap plot" : "pending"}</small>` : ""}</td>
<td>${text(workflow.measurement.signal ? `${workflow.measurement.signal.status} (${workflow.measurement.signal.basis}; ${workflow.measurement.signal.unit})` : "Not measured")}</td>
<td>${text(workflow.measurement.attention)}</td>
<td>${workflow.discovery.markerLinkedOutputs}</td></tr>`).join("\n");
  writeFileSync(path.join(directory, "index.html"), page(`${portfolio.repository} workflow value`,
    `<h1>${text(portfolio.repository)} operational-value coverage</h1>
<p><strong>${portfolio.totals.workflows} workflows inventoried; ${portfolio.totals.measured} have native evaluations.</strong>
${portfolio.totals.inProgress} are in progress;
${portfolio.totals.evidenceUnavailable} have functions but no measured native outcomes;
${portfolio.totals.needsInstrumentation} need instrumentation;
${portfolio.totals.needsOutcomeContract} need goal/acceptance contracts;
${portfolio.totals.needsIntentReview} have changed intent sources requiring review.</p>
<p><strong>Target: native evaluations for all ${portfolio.totals.workflows} workflows.
${portfolio.totals.workflows - portfolio.totals.measured} remain without a native evaluation.</strong>
An inventory, implemented checker or refreshed report does not complete this target.</p>
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
<div class="scroll"><table><thead><tr><th>Workflow</th><th>Evaluation coverage</th><th>Signal and basis</th><th>Attention</th><th>Marker-linked outputs</th></tr></thead>
<tbody>${rows}</tbody></table></div>`));
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
    { workflowId: "smoke-pydantic", sourceGitBlob: "39e64a09ad74877e7533d69f858e9a479f9ce318",
      stage: "source-first Pydantic file-tool and transport acceptance under authoring",
      detail: "An isolated session is deriving native README first-line read and transport predicates from exact source/imports before evaluating original execution receipts. Known text, inference output and successful jobs are not file-tool evidence. Assignment establishes no function, native outcome, full acceptance or workflow contribution." },
    { workflowId: "smoke-ci", sourceGitBlob: "435a00b593ced2327e01fd84c7cc93fdb45f8fae",
      stage: "source-first deterministic sample replay effects under authoring",
      detail: "An isolated session is deriving independent expected-effect predicates from deterministic sample replay and safe-output sources. The prompt is not sent to an agent; neither an LLM invocation nor replay-driver success defines acceptance. Original persisted effects remain unmeasured, and assignment is not native evaluation." },
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
