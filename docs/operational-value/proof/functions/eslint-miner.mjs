import { inspectMkdir, commitInfo } from "../lint-rule/native.mjs";
import { makeDefinition, makeCollector, evidenceNative, facets } from "../lint-rule/model.mjs";

const workflow = "eslint-miner";
const source = body => `const fs = require("node:fs");\n${body}`;
const example = (before, after) => ({ workflow, native: { known: true, files: [
  { path: "actions/setup/js/example.cjs", before, after },
] } });
export const definition = makeDefinition(workflow, {
  targetAttained: example(source('fs.mkdirSync("x");'), source('try { fs.mkdirSync("x"); } catch (error) { throw error; }')),
  targetMissed: example(source('try { fs.mkdirSync("x"); } catch (error) { throw error; }'), source('fs.mkdirSync("x");')),
  missing: {}, malformed: example(null, "not JavaScript"),
});

export function scoreMetric(id, evidence) {
  if (id !== "observed-partial") return null;
  const raw = evidenceNative(workflow, evidence);
  if (!raw?.known || !Array.isArray(raw.files) || !raw.files.length ||
    new Set(raw.files.map(row => row.path)).size !== raw.files.length) return null;
  let total = 0;
  for (const row of raw.files) {
    if (!/^actions\/setup\/js\/.*\.cjs$/.test(row.path) || /\.test\.cjs$/.test(row.path)) return null;
    const before = inspectMkdir(row.before), after = inspectMkdir(row.after);
    if (!before.known || !after.known || before.opportunities < 1 || before.opportunities !== after.opportunities ||
      JSON.stringify(before.calls.map(call => call.expression).sort()) !==
      JSON.stringify(after.calls.map(call => call.expression).sort())) return null;
    total += before.rawUnguarded - after.rawUnguarded;
  }
  return total;
}

export const collectBatch = makeCollector(workflow, packet => {
  const { transition, targets } = facets[workflow], { parent } = commitInfo(packet, transition);
  const files = targets.map(filename => ({ path: filename, before: packet.text(parent, filename), after: packet.text(transition, filename) }));
  const known = files.every(row => row.before !== null && row.after !== null);
  return { known, files, reason: known ? null : "Selected immutable before/after JavaScript originals are unavailable",
    interpretation: "Raw local try/catch containment only; no execution of target code, no full error-handling or lint acceptance",
    ruleDelivery: facets[workflow].ruleDelivery };
});
