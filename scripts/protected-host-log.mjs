import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export class HostLogEvidenceGap extends Error {}

export function readProtectedHostLog(archive, stepName, jobName = null) {
  if (!Buffer.isBuffer(archive) || archive.length > 64 * 1024 * 1024
    || !/^[A-Za-z0-9 ()-]+$/.test(stepName)
    || jobName !== null && !/^[A-Za-z0-9 _()-]+$/.test(jobName)) throw new Error("Invalid bounded host-log request");
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-protected-step-"));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const unzip = args => {
    try {
      return execFileSync("unzip", args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (error.code === "ENOBUFS" || error.signal === "SIGTERM") throw new HostLogEvidenceGap("Protected step log exceeds its execution/byte budget.");
      if (Number.isInteger(error.status)) throw new HostLogEvidenceGap("Protected step log archive cannot be decoded.");
      throw error;
    }
  };
  try {
    const file = path.join(temporary, "logs.zip");
    writeFileSync(file, archive);
    const listing = unzip(["-Z1", file]);
    const entries = listing.trim().split("\n").filter(name => {
      const match = name.match(/^(?:(.+)\/)?\d+_(.+)\.txt$/);
      return match && match[2] === stepName && (jobName === null || match[1] === jobName);
    });
    if (entries.length !== 1 || !/^[A-Za-z0-9_ ./()-]+$/.test(entries[0]) || entries[0].split("/").includes("..")) {
      throw new HostLogEvidenceGap("No unique safe-named protected job/step log.");
    }
    const text = unzip(["-p", file, entries[0]]);
    return { text, archiveSha256: hash(archive), hostLogSha256: hash(text), hostEntry: entries[0] };
  } finally {
    rmSync(temporary, { recursive: true });
  }
}

export function parseExperimentAssignmentLog(text, name, step, variants) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024
    || !/^[a-z][a-z0-9_]*$/.test(name) || !Array.isArray(variants) || variants.length < 2 || variants.length > 20
    || new Set(variants).size !== variants.length || variants.some(variant => !/^[a-z][a-z0-9_-]{0,63}$/.test(variant))) {
    throw new Error("Invalid bounded experiment log request");
  }
  const start = Date.parse(step?.started_at), end = Date.parse(step?.completed_at);
  if (step?.status !== "completed" || step.conclusion !== "success"
    || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new HostLogEvidenceGap("No successful protected experiment-selection step.");
  }
  const matches = text.split(/\r?\n/).map(line =>
    line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) Experiment assignments \(JSON\): (\{[^\r\n]*\})$/)).filter(Boolean);
  if (matches.length !== 1) throw new HostLogEvidenceGap("No unique host-produced experiment assignment.");
  const [, at, json] = matches[0], timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end + 1000) {
    throw new HostLogEvidenceGap("Experiment assignment is outside the initial host-step interval.");
  }
  let assignments;
  try { assignments = JSON.parse(json); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HostLogEvidenceGap("Invalid host-produced assignment JSON.");
  }
  if (!assignments || Object.keys(assignments).length !== 1 || typeof assignments[name] !== "string"
    || !variants.includes(assignments[name]) || json !== JSON.stringify({ [name]: assignments[name] })) {
    throw new HostLogEvidenceGap("Unexpected experiment assignment schema or variant.");
  }
  return { experiment: name, variant: assignments[name], at, assignmentLine: matches[0][0] };
}
