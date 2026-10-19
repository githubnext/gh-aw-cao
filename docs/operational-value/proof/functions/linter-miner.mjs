import { inspectGo, commitInfo } from "../lint-rule/native.mjs";
import { makeDefinition, makeCollector, evidenceNative, facets } from "../lint-rule/model.mjs";

const workflow = "linter-miner";
const filename = "pkg/cli/upgrade_command.go";
const before = 'package library\nimport "os"\nfunc run() error { os.Exit(0); return nil }\n';
const after = 'package library\nfunc run() error { return &ExitCodeError{Code: 0} }\n';
const example = (a, b) => ({ workflow, native: { known: true, files: [{ path: filename, before: a, after: b }] } });
export const definition = makeDefinition(workflow, {
  targetAttained: example(before, after), targetMissed: example(after, before),
  missing: {}, malformed: example("invalid Go", after),
});

const memo = new Map();
export function nativeGoChange(files) {
  if (!Array.isArray(files) || files.length !== 1 || files[0].path !== filename ||
    typeof files[0].before !== "string" || typeof files[0].after !== "string") return null;
  const key = JSON.stringify(files);
  if (memo.has(key)) return memo.get(key);
  const [a, b] = inspectGo([{ path: filename, source: files[0].before }, { path: filename, source: files[0].after }]);
  if (!a.known || !b.known || a.package !== b.package) return null;
  const removed = a.rawExits - b.rawExits, addedReturns = b.returnCodes - a.returnCodes;
  const sites = rows => rows.map(row => `${row.function}\0${row.code}`).sort();
  const delta = (left, right) => {
    const retained = [...right];
    return left.filter(value => {
      const index = retained.indexOf(value);
      if (index < 0) return true;
      retained.splice(index, 1);
      return false;
    });
  };
  const exitsRemoved = delta(sites(a.exits), sites(b.exits));
  const returnsAdded = delta(sites(b.returns), sites(a.returns));
  const exitsAdded = delta(sites(b.exits), sites(a.exits));
  const returnsRemoved = delta(sites(a.returns), sites(b.returns));
  const result = removed === addedReturns &&
    JSON.stringify(exitsRemoved) === JSON.stringify(returnsAdded) &&
    JSON.stringify(exitsAdded) === JSON.stringify(returnsRemoved) ? removed : null;
  memo.set(key, result);
  return result;
}
export function scoreMetric(id, evidence) {
  const raw = evidenceNative(workflow, evidence);
  if (id !== "observed-partial" || !raw?.known) return null;
  return nativeGoChange(raw.files);
}
export const collectBatch = makeCollector(workflow, packet => {
  const { transition } = facets[workflow], { parent } = commitInfo(packet, transition);
  const files = [{ path: filename, before: packet.text(parent, filename), after: packet.text(transition, filename) }];
  const errorType = packet.text(transition, "pkg/cli/exit_code_error.go");
  const entrypoint = packet.text(transition, "cmd/gh-aw/main.go");
  const known = files.every(row => row.before !== null && row.after !== null) && errorType !== null && entrypoint !== null;
  return { known, files, errorType, entrypoint,
    reason: known ? null : "Missing original native Go source or caller-control propagation source",
    ruleDelivery: facets[workflow].ruleDelivery,
    interpretation: "Two library process-termination sites can move to caller control; tests, all-path behavior, rule precision, context TODO substitutions and workflow causation are separate" };
});
