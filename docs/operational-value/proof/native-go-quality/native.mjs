import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let executable;
let temporary;
export function closeOracle() {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  executable = undefined; temporary = undefined;
}
export function analyze(inputs) {
  if (!Array.isArray(inputs) || inputs.some(row => typeof row.id !== "string" || typeof row.text !== "string")) {
    throw new Error("Malformed native source input");
  }
  if (!executable) {
    temporary = mkdtempSync(path.join(tmpdir(), "native-go-quality-"));
    process.once("exit", closeOracle);
    executable = path.join(temporary, "oracle");
    const version = execFileSync("go", ["version"], { encoding: "utf8", env: { ...process.env, GOTOOLCHAIN: "local" } }).trim();
    if (!/^go version go1\.25\.3 /.test(version)) throw new Error(`Pinned native toolchain requires Go 1.25.3; found ${version}`);
    execFileSync("go", ["build", "-o", executable, new URL("oracle.go", import.meta.url).pathname], {
      env: { ...process.env, GOWORK: "off", GOENV: "off", GOFLAGS: "", GOTOOLCHAIN: "local",
        GOPROXY: "off", GOSUMDB: "off", GOCACHE: process.env.NATIVE_GO_QUALITY_GOCACHE ?? path.join(temporary, "build"), GOPATH: path.join(temporary, "gopath") },
      stdio: ["pipe", "pipe", "pipe"], timeout: 120000,
    });
  }
  return JSON.parse(execFileSync(executable, [], { input: JSON.stringify(inputs), maxBuffer: 64 * 1024 * 1024, timeout: 60000 }));
}

export function transitions(before, after, slug) {
  if (!before?.valid || !after?.valid || !Array.isArray(before.sites) || !Array.isArray(after.sites)) {
    return { value: null, sites: [], reason: "Native Go syntax unavailable" };
  }
  const kind = slug === "go-logger" ? "logger-computation" : "test-prerequisite";
  const identity = row => `${row.function}|${row.key}`;
  const rows = new Map();
  for (const site of before.sites.filter(row => row.kind === kind)) {
    const key = identity(site), entry = rows.get(key) ?? [];
    entry.push(site); rows.set(key, entry);
  }
  const accepted = [];
  const used = new Set();
  const afterCounts = new Map();
  for (const site of after.sites.filter(row => row.kind === kind)) {
    const key = identity(site);
    afterCounts.set(key, (afterCounts.get(key) ?? 0) + 1);
  }
  for (const site of after.sites.filter(row => row.kind === kind)) {
    const key = identity(site);
    const prior = rows.get(key);
    if (!prior || prior.length !== 1 || afterCounts.get(key) !== 1 || used.has(key)) continue;
    used.add(key);
    if (prior[0].initializer !== site.initializer || prior[0].field !== site.field) continue;
    if (slug === "go-logger" ? !prior[0].guarded && site.guarded : !prior[0].fatal && site.fatal) {
      accepted.push({ ...site, identity: key, beforeLine: prior[0].line });
    }
  }
  return { value: accepted.length, sites: accepted, reason: null };
}
