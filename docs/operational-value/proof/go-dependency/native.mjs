import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requirements = new Map();
export function readGoRequirements(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  if (requirements.has(text)) return requirements.get(text);
  const directory = mkdtempSync(path.join(os.tmpdir(), "go-dependency-mod-"));
  try {
    const file = path.join(directory, "go.mod");
    writeFileSync(file, text);
    const result = spawnSync("go", ["mod", "edit", "-json", `-modfile=${file}`], {
      cwd: directory, encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { ...process.env, GOTOOLCHAIN: "local", GO111MODULE: "on", GOPROXY: "off", GOSUMDB: "off", GOWORK: "off" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (!/errors parsing|invalid|unknown directive|requires go|repeated module/i.test(result.stderr)) {
        throw new Error(`Native Go module parser failed: ${result.stderr}`);
      }
      requirements.set(text, null);
      return null;
    }
    const parsed = JSON.parse(result.stdout), pins = new Map();
    if (!parsed.Module?.Path || !Array.isArray(parsed.Require)) return null;
    for (const row of parsed.Require) {
      if (pins.has(row.Path)) return null;
      pins.set(row.Path, { version: row.Version, direct: !row.Indirect,
        replaced: (parsed.Replace ?? []).some(replace => replace.Old.Path === row.Path
          && (!replace.Old.Version || replace.Old.Version === row.Version)),
        excluded: (parsed.Exclude ?? []).some(exclude => exclude.Path === row.Path && exclude.Version === row.Version) });
    }
    requirements.set(text, pins);
    return pins;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function semver(value) {
  const match = typeof value === "string" && value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+incompatible)?$/,
  );
  if (!match || match.slice(1, 4).some(value => !Number.isSafeInteger(Number(value)))) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core: match.slice(1, 4).map(Number), pre };
}

export function compareVersions(left, right) {
  const a = semver(left), b = semver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && !b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    if (numericX && numericY) return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function dependencyTarget(beforeText, afterText, target, { directOnly = true, skipMajor = false } = {}) {
  const before = readGoRequirements(beforeText), after = readGoRequirements(afterText);
  if (!before || !after) return { value: null, reason: "Unsupported or malformed Go module syntax/policy." };
  const old = before.get(target.module), next = after.get(target.module);
  if (!old || !next) return { value: 0, reason: "Dependency absent on one side; not a delivered version target." };
  if (directOnly && (!old.direct || !next.direct)) return { value: 0, reason: "Not a direct dependency on both sides." };
  if (old.replaced || next.replaced || old.excluded || next.excluded) {
    return { value: null, reason: "Requested target is replaced or excluded; declared pins do not establish the consumed target." };
  }
  const order = compareVersions(target.to, target.from);
  if (order === null) return { value: null, reason: "Unsupported native version syntax." };
  if (skipMajor && semver(target.to).core[0] !== semver(target.from).core[0]) {
    return { value: 0, reason: "Major updates excluded by frozen checker reference policy." };
  }
  return { value: old.version === target.from && next.version === target.to && order > 0 ? 1 : 0,
    module: target.module, before: old.version, after: next.version, directBefore: old.direct, directAfter: next.direct };
}

export function analyzeAssertions(inputs) {
  if (!Array.isArray(inputs) || inputs.some(row => typeof row.id !== "string" || typeof row.text !== "string")) {
    throw new Error("Invalid native Go oracle inputs");
  }
  const output = execFileSync("go", ["run", fileURLToPath(new URL("./oracle.go", import.meta.url))], {
    input: JSON.stringify(inputs), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GOTOOLCHAIN: "local", GO111MODULE: "off", GOPROXY: "off", GOSUMDB: "off", GOWORK: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const results = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== inputs.length
    || results.some((row, index) => row.id !== inputs[index].id || typeof row.valid !== "boolean"
      || !Array.isArray(row.sites))) throw new Error("Malformed native Go oracle output");
  return results;
}

export function assertionTransitions(before, after) {
  if (!before?.valid || !after?.valid) return { value: null, sites: [], reason: "Go syntax unavailable." };
  const keyed = facts => {
    const groups = new Map();
    for (const site of facts.sites) {
      const key = `${site.function}\0${site.key}`;
      const group = groups.get(key) ?? { old: [], next: [] };
      (site.kind === "error-string-contains" ? group.old : group.next).push(site);
      groups.set(key, group);
    }
    return groups;
  };
  const oldGroups = keyed(before), nextGroups = keyed(after), sites = [];
  for (const [key, old] of oldGroups) {
    const next = nextGroups.get(key);
    if (!next) continue;
    const delivered = Math.min(old.old.length - next.old.length, next.next.length - old.next.length);
    for (let index = 0; index < delivered; index++) {
      sites.push({ key, ordinal: index, beforeLine: old.old[index].line, afterLine: next.next[index].line });
    }
  }
  return { value: sites.length, sites };
}
