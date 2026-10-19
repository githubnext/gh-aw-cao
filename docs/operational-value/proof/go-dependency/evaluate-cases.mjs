import { cutoff, repository } from "./custody.mjs";
import { implementation, publicScope, recommendation, response, supplementalSource } from "./evidence.mjs";
import { analyzeAssertions, assertionTransitions, dependencyTarget, readGoRequirements } from "./native.mjs";

function unassessed(originals, workflow) {
  return workflow.unassessed.map(profile => {
    const original = response(originals, `repos/${repository}/pulls/${profile.pull}`);
    if (!original.available || !original.body.merged_at) throw new Error("Missing selected implementation identity");
    return { id: `unassessed:${profile.pull}`, at: original.body.merged_at, value: null, corroborated: false,
      reason: profile.reason, native: null, attribution: null };
  });
}

function manifestCases(context, options) {
  const { custody, originals, workflow } = context;
  publicScope(originals);
  return workflow.cases.flatMap(profile => {
    if (profile.manifest !== "go.mod") throw new Error("Unsupported frozen manifest profile");
    const accepted = implementation(originals, custody, profile);
    if (!accepted.available) throw new Error("Missing original implementation");
    const advice = response(originals, `repos/${repository}/issues/${profile.issue}`);
    const attribution = recommendation(originals, profile, workflow.slug, accepted.pull, cutoff);
    const before = supplementalSource(custody, originals, profile.parent, profile.manifest);
    const after = supplementalSource(custody, originals, profile.commit, profile.manifest);
    return profile.targets.map(target => {
      if (typeof target.quote !== "string" || target.quote.length < 20 || !advice.available
        || !advice.body.body.includes(target.quote)) throw new Error("Frozen target not supported by original recommendation");
      const native = before.available && after.available
        ? dependencyTarget(before.text, after.text, target, options)
        : { value: null, reason: "Native before/after manifest bytes unavailable." };
      return { id: `${profile.commit}:${profile.manifest}:${target.module}:${target.from}:${target.to}`,
        at: accepted.at, value: native.value, native: { ...native, manifest: profile.manifest,
          commit: profile.commit, parent: profile.parent, beforeBlob: before.blob ?? null, afterBlob: after.blob ?? null },
        corroborated: attribution.corroborated, attribution, reason: native.reason ?? null };
    });
  }).concat(unassessed(originals, workflow));
}

export function evaluateBurner(context) {
  const era = supplementalSource(context.custody, context.originals,
    "89170286f206675f5608efd9f7d8d1dae9b9f41e", ".github/workflows/dependabot-burner.md");
  if (!era.available || !era.text.includes("exactly **one runtime + one manifest file**")) {
    throw new Error("Original historical Burner bundle goal unavailable");
  }
  return manifestCases(context, { directOnly: false, skipMajor: false });
}

export function evaluateChecker(context) {
  return manifestCases(context, { directOnly: true, skipMajor: true });
}

export function evaluateGoFan({ custody, originals, workflow }) {
  publicScope(originals);
  const rows = [];
  for (const profile of workflow.cases) {
    if (profile.module !== "github.com/stretchr/testify") throw new Error("Unsupported frozen module-usage profile");
    const accepted = implementation(originals, custody, profile);
    if (!accepted.available) throw new Error("Missing original implementation");
    const attribution = recommendation(originals, profile, workflow.slug, accepted.pull, cutoff);
    const moduleStates = [profile.parent, profile.commit].map(commit => supplementalSource(custody, originals, commit, "go.mod"));
    const pins = moduleStates.map(source => source.available ? readGoRequirements(source.text)?.get(profile.module) : null);
    const eligible = pins.every(pin => pin?.direct === true && !pin.replaced && !pin.excluded);
    const inputs = profile.files.flatMap(file => [profile.parent, profile.commit].map(commit => ({
      id: `${commit}:${file}`, text: custody.source(commit, file),
    })));
    const parsed = analyzeAssertions(inputs);
    for (let index = 0; index < profile.files.length; index++) {
      const effect = eligible ? assertionTransitions(parsed[2 * index], parsed[2 * index + 1])
        : { value: null, reason: "Direct, unreplaced module eligibility unavailable on one side.", sites: [] };
      rows.push({
        id: `${profile.commit}:${profile.files[index]}`, at: accepted.at, value: effect.value,
        native: { path: profile.files[index], commit: profile.commit, parent: profile.parent,
          module: profile.module, modulePins: pins, beforeBlob: custody.resolve(profile.parent, profile.files[index]),
          afterBlob: custody.resolve(profile.commit, profile.files[index]), ...effect },
        corroborated: attribution.corroborated, attribution, reason: effect.reason ?? null,
      });
    }
  }
  return rows.concat(unassessed(originals, workflow));
}
