const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
export const eligibleGoPath = file => typeof file === "string" && file.endsWith(".go")
  && !/(^|\/)(?:vendor|node_modules|testdata|\.git)(?:\/|$)/.test(file);

export function validGoFact(fact) {
  return fact && typeof fact.syntaxValid === "boolean" && typeof fact.generated === "boolean"
    && Array.isArray(fact.tests) && new Set(fact.tests.map(test => test?.name)).size === fact.tests.length
    && fact.tests.every(test => test && typeof test.name === "string" && test.name.startsWith("Test")
      && typeof test.leadingParallel === "boolean" && count(test.processStateCalls)
      && count(test.globalReferences) && hash(test.bodySha256))
    && (!fact.syntaxValid || (typeof fact.needsGofmt === "boolean"
      && hash(fact.contentSha256) && hash(fact.formattedSha256) && hash(fact.buildSha256)
      && typeof fact.package === "string" && fact.package.length > 0));
}

export function goParallelEffect(before, after) {
  if (!before || !after) return { status: "not-existing-on-both-sides", enabled: [], disabled: [], value: 0 };
  if (!validGoFact(before) || !validGoFact(after)) throw new Error("Malformed native Go oracle evidence");
  if (before.generated || after.generated) return { status: "generated-excluded", enabled: [], disabled: [], value: 0 };
  if (!before.syntaxValid || !after.syntaxValid) return { status: "syntax-unavailable", enabled: [], disabled: [], value: null };
  if (before.package !== after.package || before.buildSha256 !== after.buildSha256) {
    return { status: "eligibility-changed", enabled: [], disabled: [], value: 0 };
  }
  const prior = new Map(before.tests.map(test => [test.name, test]));
  const enabled = [], disabled = [];
  for (const test of after.tests) {
    const old = prior.get(test.name);
    if (!old || old.bodySha256 !== test.bodySha256) continue;
    const was = old.leadingParallel && old.processStateCalls === 0;
    const now = test.leadingParallel && test.processStateCalls === 0;
    if (now && !was) enabled.push({ name: test.name, globalReferences: test.globalReferences });
    if (was && !now) disabled.push({ name: test.name, globalReferences: test.globalReferences });
  }
  return { status: "measured-source-facet", enabled, disabled, value: enabled.length - disabled.length };
}

export function goFormattingEffect(before, after) {
  if (!before || !after) return { status: "not-existing-on-both-sides", value: 0 };
  if (!validGoFact(before) || !validGoFact(after)) throw new Error("Malformed native Go oracle evidence");
  if (before.generated || after.generated) return { status: "generated-excluded", value: 0 };
  if (!before.syntaxValid || !after.syntaxValid) return { status: "syntax-unavailable", value: null };
  const repaired = before.needsGofmt && !after.needsGofmt && before.formattedSha256 === after.contentSha256;
  const reversed = !before.needsGofmt && after.needsGofmt && after.formattedSha256 === before.contentSha256;
  return { status: "measured-exact-gofmt", value: repaired ? 1 : reversed ? -1 : 0 };
}

export function evaluateGoHistory(history, facts) {
  const byBlob = new Map(facts.map(fact => [fact.id, fact]));
  if (byBlob.size !== facts.length || facts.some(fact => !validGoFact(fact))) throw new Error("Invalid native Go feature table");
  return history.map(commit => {
    const files = commit.changes.filter(change => eligibleGoPath(change.path)).map(change => {
      const regular = [change.beforeMode, change.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode));
      if (!regular) return { ...change, parallel: null, formatting: null };
      for (const blob of [change.beforeBlob, change.afterBlob].filter(Boolean)) {
        if (!byBlob.has(blob)) throw new Error("Missing immutable native Go blob evidence");
      }
      const before = change.beforeBlob ? byBlob.get(change.beforeBlob) : null;
      const after = change.afterBlob ? byBlob.get(change.afterBlob) : null;
      return { ...change,
        parallel: regular && change.path.endsWith("_test.go") ? goParallelEffect(before, after) : null,
        formatting: regular ? goFormattingEffect(before, after) : null };
    });
    const sum = name => files.filter(file => file[name]).reduce((total, file) => total + (file[name].value ?? 0), 0);
    return { commit: commit.commit, parents: commit.parents, at: commit.at, files,
      parallel: sum("parallel"), formatting: sum("formatting"),
      parallelComplete: files.every(file => !file.parallel || file.parallel.value !== null),
      formattingComplete: files.every(file => !file.formatting || file.formatting.value !== null) };
  });
}

export function scoreGoParallelMetric(id, evidence) {
  if (!["native-net", "corroborated-net"].includes(id) || evidence?.valid !== true || evidence.complete !== true
    || !Array.isArray(evidence.events) || new Set(evidence.events.map(event => event?.id)).size !== evidence.events.length
    || evidence.events.some(event => !event || typeof event.id !== "string" || !event.id
      || !count(event.enabled) || !count(event.disabled) || typeof event.linked !== "boolean")) return null;
  return evidence.events.reduce((sum, event) => sum + (id === "native-net" || event.linked ? event.enabled - event.disabled : 0), 0);
}
