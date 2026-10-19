import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = new URL("./", import.meta.url);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let binary, temporary;
export function analyze(inputs) {
  if (!Array.isArray(inputs) || inputs.some(x => typeof x?.id !== "string" || typeof x.text !== "string")) throw new Error("Invalid native inputs");
  if (!binary) {
    const lock = JSON.parse(readFileSync(new URL("toolchain.json", base)));
    if (lock.nodeVersion !== process.version || lock.nodePlatform !== process.platform || lock.nodeArch !== process.arch
      || lock.nodeBinarySha256 !== sha256(readFileSync(process.execPath))) throw new Error("Unpinned Node toolchain");
    const env = { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GO111MODULE: "off", GOENV: "off", GOWORK: "off" };
    const result = spawnSync("go", ["version"], { env, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.stdout.trim() !== lock.version) throw new Error("Unpinned Go toolchain");
    const go = spawnSync("go", ["env", "GOROOT"], { env, encoding: "utf8" });
    if (go.error) throw go.error;
    if (go.status !== 0) throw new Error(go.stderr);
    const root = go.stdout.trim();
    const resolved = spawnSync("which", ["go"], { encoding: "utf8" });
    if (resolved.error) throw resolved.error;
    if (resolved.status !== 0 || realpathSync(resolved.stdout.trim()) !== realpathSync(path.join(root, "bin/go"))) throw new Error("Go executable is not the pinned toolchain");
    for (const row of lock.files) if (sha256(readFileSync(path.join(root, row.path))) !== row.sha256) throw new Error(`Toolchain custody changed: ${row.path}`);
    if (sha256(readFileSync(new URL("oracle.go", base))) !== lock.oracleSha256) throw new Error("Native oracle custody changed");
    temporary = mkdtempSync(path.join(tmpdir(), "native-code-debt-"));
    binary = path.join(temporary, "oracle");
    const build = spawnSync("go", ["build", "-trimpath", "-o", binary, new URL("oracle.go", base).pathname], { env, encoding: "utf8", timeout: 180000 });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(build.stderr);
    process.once("exit", () => rmSync(temporary, { recursive: true }));
  }
  const result = spawnSync(binary, [], { input: JSON.stringify(inputs), maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const rows = JSON.parse(result.stdout);
  if (rows.length !== inputs.length || rows.some((row, i) => row.id !== inputs[i].id)) throw new Error("Oracle output identity mismatch");
  return rows;
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function consolidation(before, after) {
  if (!before?.valid || !after?.valid || before.package !== "workflow" || after.package !== "workflow" || before.generated || after.generated
    || before.cgo || after.cgo || [...before.directives, ...after.directives].some(x => /go:(?:linkname|wasmexport)|\/\/export /.test(x))) {
    return { value: null, reason: "Unavailable or unsupported native source" };
  }
  const fn = (row, name) => {
    const found = row.functions.filter(x => x.name === name && !x.receiver && !x.entry);
    return found.length === 1 ? found[0] : null;
  };
  const old = fn(before, "runGHWithSpinner"), shared = fn(before, "runGHWithSpinnerContext"), retained = fn(after, "runGHWithSpinnerContext");
  if (!old || !shared || !retained) return { value: 0, reason: "No supported prior duplicate pair" };
  if (!equal(before.imports, after.imports) || before.imports.context !== "context"
    || old.type !== "func(spinnerMessage string, combined bool, args ...string) ([]byte, error)"
    || shared.type !== "func(ctx context.Context, spinnerMessage string, combined bool, args ...string) ([]byte, error)") {
    return { value: 0, reason: "Unsupported import or parameter bindings" };
  }
  if (!equal(old.body.slice(1), shared.body.slice(1)) || !shared.body.slice(1).length
    || old.body[0] !== "cmd := ExecGH(args...)" || shared.body[0] !== "cmd := ExecGHContext(ctx, args...)") {
    return { value: 0, reason: "Distinct native command-result algorithms" };
  }
  const unchanged = ["ExecGH", "ExecGHContext", "enrichGHError", "runGHWithSpinnerContext", "RunGHContext", "RunGHCombinedContext"];
  for (const name of unchanged) {
    const a = fn(before, name), b = fn(after, name);
    if (!a || !b || a.type !== b.type || !equal(a.body, b.body)) return { value: 0, reason: `Changed helper or routing: ${name}` };
  }
  for (const [name, selector] of [["RunGH", "false"], ["RunGHCombined", "true"]]) {
    const a = fn(before, name), b = fn(after, name);
    const context = `${name}Context`;
    const route = fn(after, context);
    if (!a || !b || a.type !== b.type || !equal(a.body, [`return runGHWithSpinner(spinnerMessage, ${selector}, args...)`])
      || !equal(b.body, [`return ${context}(context.Background(), spinnerMessage, args...)`])
      || !equal(route?.body, [`return runGHWithSpinnerContext(ctx, spinnerMessage, ${selector}, args...)`])) {
      return { value: 0, reason: `Unverified forwarding semantics: ${name}` };
    }
  }
  if (after.functions.some(x => x.name === old.name) || after.identifiers[old.name]) return { value: 0, reason: "Duplicate implementation or calls remain" };
  if (before.identifiers[old.name] !== 3 || before.identifiers[shared.name] !== 3 || after.identifiers[shared.name] !== 3) {
    return { value: 0, reason: "Unsupported declaration/call universe" };
  }
  if (before.functions.filter(x => equal(x.body.slice(1), shared.body.slice(1))).length !== 2
    || after.functions.filter(x => equal(x.body.slice(1), shared.body.slice(1))).length !== 1) return { value: 0, reason: "Native duplicate multiplicity mismatch" };
  return { value: 1, identity: `${old.name}+${shared.name}`, algorithmSha256: sha256(JSON.stringify(shared.body.slice(1))),
    nativeStatementSequence: shared.body.slice(1),
    constructorChanged: !equal(fn(before, "setupGHCommand")?.body, fn(after, "setupGHCommand")?.body),
    qualification: "One exact duplicated command-result handling algorithm consolidated. Command construction changes from nil context to background context and logging differs; full behavior preservation is NOT established." };
}
