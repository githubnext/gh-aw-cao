import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export function scanNativeSlideGeometry(evidence) {
  if (evidence?.valid !== true || !Array.isArray(evidence.slides) || !evidence.slides.length || evidence.slides.length > 150) return null;
  let overflowingSlides = 0, overflowingElements = 0;
  for (const slide of evidence.slides) {
    const rectangle = value => Array.isArray(value) && value.length === 4
      && value.every(number => Number.isFinite(number) && Math.abs(number) <= 1e7)
      && value[2] > value[0] && value[3] > value[1];
    if (!rectangle(slide.bounds) || !Array.isArray(slide.elements) || slide.elements.length > 2000) return null;
    let failures = 0;
    for (const element of slide.elements) {
      if (!rectangle(element)) return null;
      if (element[0] < slide.bounds[0] || element[1] < slide.bounds[1]
        || element[2] > slide.bounds[2] || element[3] > slide.bounds[3]) failures++;
    }
    overflowingElements += failures;
    if (failures) overflowingSlides++;
  }
  return { "overflowing-slides": overflowingSlides, "overflowing-elements": overflowingElements };
}

export function scoreNativeSlideGeometry(id, evidence) {
  if (!["overflowing-slides", "overflowing-elements"].includes(id)) throw new Error("Unknown native slide geometry metric");
  return scanNativeSlideGeometry(evidence)?.[id] ?? null;
}

export function nativeSlideGeometryModule(contract) {
  if (createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") !== contract.interpreterSha256) {
    throw new Error("Frozen native slide geometry interpreter changed");
  }
  const example = overflow => ({ valid: true, slides: [{ bounds: [0, 0, 1280, 720],
    elements: [[50, 50, 500, overflow ? 750 : 600]] }] });
  const metric = (id, role, name, unit, label) => ({ id, role, name, unit, direction: "decrease",
    formula: id === "overflowing-slides" ? "Count rendered static slides containing a positive-area element outside their section bounds."
      : "Count positive-area descendant rectangles outside their slide section bounds, without multiplying slide counts.",
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Slide Deck Maintainer", sourcePath: contract.sourcePath,
    intent: { goal: "Keep rendered slide content within slide bounds.",
      acceptance: "Independent pinned Marp/Chromium static replay of immutable deck/theme inputs checks actual element and section rectangles. Interactive rendering and content accuracy remain separate.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "native-static-slide-geometry-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract), renderer: contract.renderer,
      opportunity: "Every section in the immutable documentation deck at the weekly endpoint.",
      filters: ["Measure native browser rectangles, not an agent's self-reported layout assessment.",
        "Freeze renderer/browser/platform identity; this is static replay, not proof of the historical agent's browser session.",
        "Disable scripts and all external requests. Missing local assets and font fallbacks remain explicit.",
        "A changing slide population is reported, not attributed to the workflow. Content accuracy and interactive diagrams are not measured."],
      collection: "Hash-verified immutable Git/LFS deck, theme and requested local assets; retained native rectangle observations.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Immutable slide sources rendered by pinned Marp and an isolated script-disabled Chromium context.",
      recommendation: "Inspect static overflow alongside content correctness and interactive rendering.",
      presentation: { label: "Static slide bounds", betterLabel: "Fewer slides with out-of-bounds content" } },
    summary: { nativeLabel: "Overflowing static slides" },
    metrics: [metric("overflowing-slides", "primary", "Static slides with out-of-bounds content", "slides", "Overflowing slides"),
      metric("overflowing-elements", "diagnostic", "Out-of-bounds static elements", "elements", "Overflowing elements")],
    validationExamples: { targetAttained: example(false), targetMissed: example(true),
      missing: { valid: false }, malformed: { valid: true, slides: [{ bounds: [0, 0, -1, 720], elements: [] }] } } },
  scoreMetric: scoreNativeSlideGeometry, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`), facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)) {
      throw new Error("Native slide geometry evidence changed");
    }
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Slide observation repository mismatch");
      const state = facts.states.find(state => state.windowEnd === request.windowEnd);
      const evidence = state?.geometry ?? { valid: false, missingReason: "No exact immutable static-deck endpoint." };
      const measured = scanNativeSlideGeometry(evidence) !== null;
      return { evidence: { ...evidence, coverageStatus: measured ? "complete" : "unknown",
        maturityStatus: "matured", eligibleCount: measured ? evidence.slides.length : null,
        missingAssets: state?.missingAssets ?? [], blockedExternalAssets: state?.blockedExternalAssets ?? [],
        fullGoalAcceptance: "not-measured", contentAccuracy: "not-measured", interactiveRendering: "not-measured",
        workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-slide-geometry-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
