import { createHash } from "node:crypto";
import path from "node:path";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const profileStart = "2026-10-18T06:32:44Z";
export const repository = "github/gh-aw";
export const repositoryId = 1036865607;
const maxBytes = 256 * 1024;
const text = value => typeof value === "string" && Buffer.byteLength(value) <= maxBytes;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const isUtc = value => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace("Z", ".000Z");

// Decode the compiler's actual ValidationResult/ValidationIssue JSON, not a quality report.
export function decodeCompileResult(raw, workflow) {
  if (!text(raw) || !text(workflow) || path.posix.basename(workflow) !== workflow || !workflow.endsWith(".md")) return null;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const issue = item => object(item) && typeof item.type === "string" && text(item.message)
    && (item.file === undefined || text(item.file))
    && (item.line === undefined || Number.isSafeInteger(item.line) && item.line >= 0);
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (!object(row) || row.scope !== undefined || row.workflow !== workflow || typeof row.valid !== "boolean"
    || !Array.isArray(row.errors) || !row.errors.every(issue)
    || !Array.isArray(row.warnings) || !row.warnings.every(issue)
    || row.warnings.some(item => ["shared_workflow", "redirect_only_workflow"].includes(item.type))
    || row.valid !== (row.errors.length === 0)) return null;
  return row;
}

export function decodeDiagnostic(message) {
  if (!text(message)) return null;
  const plain = message.replace(/\x1b\[[0-9;]*m/g, "");
  const match = /^([^\n\r]+):([1-9]\d*):([1-9]\d*): error: ([^\n\r]+)(?:\r?\n|$)/.exec(plain);
  if (!match || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) return null;
  return { file: match[1], line: Number(match[2]), column: Number(match[3]), message: match[4], plain };
}

// A closed mutation oracle, not a substitute YAML parser or a general compiler.
// The native baseline result must accept the complete unchanged document.
export function decodeMutation(before, after) {
  if (!text(before) || !text(after) || before.includes("\r") || after.includes("\r")
    || !before.startsWith("---\n") || !after.startsWith("---\n")) return null;
  const original = before.split("\n"), modified = after.split("\n");
  const end = original.indexOf("---", 1);
  if (end < 2 || end !== modified.indexOf("---", 1) || original.length !== modified.length
    || !original.slice(end + 1).join("\n").trim()) return null;
  const changed = original.flatMap((line, index) => line !== modified[index] ? [index] : []);
  if (changed.length !== 1 || changed[0] < 1 || changed[0] >= end) return null;
  const index = changed[0];
  const frontmatter = original.slice(1, end);
  if (frontmatter.some(line => /[\t&*]|<<\s*:/.test(line))
    || frontmatter.filter(line => /^engine:/.test(line)).length !== 1
    || !frontmatter.some(line => /^on:\s*\S/.test(line))
    || !/^engine: (copilot|claude|codex|gemini|pi)$/.test(original[index])
    || !/^engine: (?:0|[1-9]\d*)$/.test(modified[index])) return null;
  return { line: index + 1, keyStart: 1, keyEnd: 6, valueStart: 9, valueEnd: modified[index].length,
    originalLine: original[index],
    replacement: original[index].slice("engine: ".length), mutantLine: modified[index] };
}

export function validateNativeSchema(raw) {
  const schema = JSON.parse(raw);
  const branches = schema.$defs?.engine_config?.oneOf;
  if (schema.properties?.engine?.$ref !== "#/$defs/engine_config"
    || !Array.isArray(branches) || !branches.length
    || !branches.every(branch => ["string", "object"].includes(branch.type))) {
    throw new Error("Frozen native engine schema does not establish the numeric-engine oracle");
  }
}

export function decodeBuildInfo(raw) {
  if (!text(raw)) return null;
  const lines = raw.split("\n");
  const paths = lines.filter(line => /^\tpath\t/.test(line));
  const revisions = lines.filter(line => /^\tbuild\tvcs\.revision=/.test(line));
  const modified = lines.filter(line => /^\tbuild\tvcs\.modified=/.test(line));
  if (!/^[^\n]+: go1\.\d+(?:\.\d+)?(?: [^\n]+)?$/.test(lines[0])
    || paths.length !== 1 || paths[0] !== "\tpath\tgithub.com/github/gh-aw/cmd/gh-aw"
    || revisions.length !== 1 || revisions[0] !== `\tbuild\tvcs.revision=${revision}`
    || modified.length !== 1 || modified[0] !== "\tbuild\tvcs.modified=false"
    || !lines.includes("\tbuild\tvcs=git")) return null;
  return { revision };
}

export function assessCase(item) {
  if (!object(item) || !text(item.workflow) || !isUtc(item.completedAt)
    || item.completedAt < profileStart || item.completedAt > cutoff
    || !object(item.originals) || !decodeBuildInfo(item.originals.compilerBuildInfo)) return null;
  const { beforeInput, afterInput, beforeResult, afterResult } = item.originals;
  if (![beforeInput, afterInput, beforeResult, afterResult].every(text)
    || !Object.values(item.originals).every(text)) return null;
  const mutation = decodeMutation(beforeInput, afterInput);
  const before = decodeCompileResult(beforeResult, item.workflow);
  const after = decodeCompileResult(afterResult, item.workflow);
  if (!mutation || !before?.valid || !after || after.valid || after.errors.length !== 1
    || after.errors[0].type !== "parse_error") return null;
  const diagnostic = decodeDiagnostic(after.errors[0].message);
  // No diagnostic is a known failed location facet, not a missing original output.
  const correctLocation = diagnostic !== null && path.posix.normalize(diagnostic.file) === item.workflow
    && diagnostic.line === mutation.line
    && (diagnostic.column >= mutation.keyStart && diagnostic.column <= mutation.keyEnd
      || diagnostic.column >= mutation.valueStart && diagnostic.column <= mutation.valueEnd);
  const suggestions = diagnostic === null ? [] : [
    ...diagnostic.plain.matchAll(/(?:^|\n|\. )Did you mean '([a-z]+)'\?(?=\n|$| )/g),
    ...diagnostic.plain.matchAll(/(?:^|\n)Example:\nengine: ([a-z]+)(?=\n|$)/g),
  ].map(match => match[1]);
  const repair = correctLocation && suggestions.length === 1 && suggestions[0] === mutation.replacement;
  return {
    id: sha256(JSON.stringify([revision, item.workflow, sha256(afterInput)])),
    completedAt: item.completedAt, correctLocation: Number(correctLocation),
    verifiedRepair: Number(repair),
    originals: Object.fromEntries(Object.entries(item.originals).map(([key, value]) => [key, sha256(value)])),
  };
}

export function summarizeCases(items, windowStart, windowEnd, observedAt) {
  if (!Array.isArray(items) || ![windowStart, windowEnd, observedAt].every(isUtc)
    || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(observedAt) < Date.parse(windowEnd)) {
    throw new Error("Invalid native case window");
  }
  const seen = new Set();
  const accepted = [], unassessed = [];
  for (const item of items) {
    if (!object(item) || !isUtc(item.completedAt)) throw new Error("Native case has no authoritative completion timestamp");
    if (item.completedAt < windowStart || item.completedAt >= windowEnd || item.completedAt > observedAt) continue;
    const result = assessCase(item);
    if (!result) {
      unassessed.push(sha256(JSON.stringify(item)));
      continue;
    }
    if (seen.has(result.id)) throw new Error("Repeated native mutation identity");
    seen.add(result.id);
    accepted.push(result);
  }
  return {
    eligibleCount: accepted.length, unassessedCount: unassessed.length,
    correctLocations: accepted.reduce((sum, item) => sum + item.correctLocation, 0),
    verifiedRepairs: accepted.reduce((sum, item) => sum + item.verifiedRepair, 0),
    populationDigest: sha256(JSON.stringify(accepted.map(item => item.id).sort())),
    receipts: accepted, unassessed,
  };
}
