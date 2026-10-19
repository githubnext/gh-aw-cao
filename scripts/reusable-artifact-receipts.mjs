import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "./reusable-artifact-value.mjs";

export class ReusableReceiptGap extends Error {}

export function readReusableArchiveEntries(bytes, requested, scratchRoot) {
  const relativeScratch = typeof scratchRoot === "string" ? path.relative(process.cwd(), path.resolve(scratchRoot)) : "..";
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024
    || !Array.isArray(requested) || !requested.length || requested.length > 20
    || requested.some(name => typeof name !== "string" || !/^[A-Za-z0-9_ ./()-]+$/.test(name)
      || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === ".."))
    || new Set(requested).size !== requested.length
    || relativeScratch === ".." || relativeScratch.startsWith(`..${path.sep}`) || path.isAbsolute(relativeScratch)) {
    throw new Error("Unsafe bounded reusable-artifact archive request");
  }
  const directory = mkdtempSync(path.join(scratchRoot, "receipt-"));
  try {
    const file = path.join(directory, "archive.zip");
    writeFileSync(file, bytes);
    const run = args => {
      try {
        return execFileSync("unzip", args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        if (Number.isInteger(error.status) || error.code === "ENOBUFS" || error.signal === "SIGTERM") {
          throw new ReusableReceiptGap("Provider ZIP is unavailable, malformed or exceeds bounded decoding limits.");
        }
        throw error;
      }
    };
    const names = run(["-Z1", file]).toString("utf8").trimEnd().split("\n");
    if (names.length > 10000 || new Set(names).size !== names.length) {
      throw new ReusableReceiptGap("Duplicate or over-budget ZIP identities.");
    }
    const selected = {};
    for (const name of requested) {
      if (!names.includes(name)) throw new ReusableReceiptGap(`Required archive member is absent: ${name}`);
      const content = run(["-p", file, name]);
      selected[name] = { bytes: content, sha256: sha256(content) };
    }
    return { archiveSha256: sha256(bytes), entries: selected };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

export function verifyReusableProviderArtifact(metadata, archive, run, expectedName) {
  if (!metadata || !Number.isSafeInteger(metadata.id) || metadata.id <= 0
    || metadata.name !== expectedName || metadata.expired !== false
    || metadata.runId !== run.runId || metadata.headSha !== run.headSha
    || !/^sha256:[a-f0-9]{64}$/.test(metadata.digest ?? "")
    || !Buffer.isBuffer(archive) || sha256(archive) !== metadata.digest.slice(7)) {
    throw new ReusableReceiptGap("Artifact identity, provider digest or payload bytes do not match the exact execution.");
  }
  return { ...metadata, archiveSha256: sha256(archive) };
}

export function reusableExpectedInputs(contract, caller) {
  const job = contract.callerJobs[caller];
  if (!job) throw new Error("Unknown frozen caller identity");
  const values = Object.fromEntries(Object.entries(contract.declaredInputs).map(([key, field]) => {
    if (!Object.hasOwn(field, "default")) throw new ReusableReceiptGap("No frozen default for an omitted workflow input.");
    return [key, field.default];
  }));
  for (const [key, value] of Object.entries(job.with)) {
    if (!Object.hasOwn(values, key) || typeof value !== typeof values[key]) {
      throw new ReusableReceiptGap("Caller input vocabulary or type differs from the frozen source.");
    }
    values[key] = value;
  }
  return values;
}

export function verifyReusableInputSerialization(serialization, expected) {
  if (typeof serialization !== "string" || Buffer.byteLength(serialization) > 65536) {
    throw new ReusableReceiptGap("No bounded original input serialization.");
  }
  let actual;
  try { actual = JSON.parse(serialization); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ReusableReceiptGap("Malformed original invocation input JSON.");
  }
  if (!isDeepStrictEqual(actual, expected)) throw new ReusableReceiptGap("Original invocation inputs differ from declared caller/default values.");
  return { inputSha256: sha256(serialization) };
}

export function verifyReusablePayloadContents(sourceMarkdown, expectedInputs, activationPrompt, agentOutput) {
  if (typeof sourceMarkdown !== "string" || typeof activationPrompt !== "string"
    || typeof agentOutput !== "string" || Buffer.byteLength(activationPrompt) > 4 * 1024 * 1024
    || Buffer.byteLength(agentOutput) > 4 * 1024 * 1024) throw new ReusableReceiptGap("Missing bounded original payload content.");
  const frontmatter = sourceMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) throw new Error("Frozen reusable source has no complete frontmatter");
  const body = sourceMarkdown.slice(frontmatter[0].length).trim().replace(/\r\n/g, "\n")
    .replace(/\$\{\{\s*inputs\.([a-z0-9-]+)\s*\}\}/g, (_match, key) => {
      if (!Object.hasOwn(expectedInputs, key)) throw new ReusableReceiptGap("Unresolved source input expression.");
      return String(expectedInputs[key]);
    });
  if (!activationPrompt.replace(/\r\n/g, "\n").includes(body)) {
    throw new ReusableReceiptGap("Activation payload does not establish the complete source-defined input-correlated task.");
  }
  let parsed;
  try { parsed = JSON.parse(agentOutput); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ReusableReceiptGap("Agent output payload is not valid JSON.");
  }
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length !== 1
    || parsed.items[0]?.type !== "noop"
    || parsed.items[0].message !== `Completed task: ${expectedInputs["task-description"]}`) {
    throw new ReusableReceiptGap("Agent output does not establish the exact source-defined noop for this invocation.");
  }
  return { payloadCorrect: true, payloadReceiptSha256: sha256(JSON.stringify({
    sourceSha256: sha256(sourceMarkdown), promptSha256: sha256(activationPrompt),
    agentOutputSha256: sha256(agentOutput), expectedInputs,
  })) };
}

export function verifyReusableProtectedReadback(logText, step, expectedMessage) {
  const start = Date.parse(step?.started_at), end = Date.parse(step?.completed_at);
  if (step?.name !== "Process Safe Outputs" || step.status !== "completed" || step.conclusion !== "success"
    || !Number.isFinite(start) || !Number.isFinite(end) || end < start
    || typeof logText !== "string" || Buffer.byteLength(logText) > 4 * 1024 * 1024
    || typeof expectedMessage !== "string" || /[\r\n]/.test(expectedMessage)) {
    throw new ReusableReceiptGap("No successful bounded source-defined protected consumer step.");
  }
  const prefix = "✓ Recorded noop message: ";
  const receipts = logText.split(/\r?\n/).map(line => line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/))
    .filter(match => match && match[2].startsWith(prefix));
  if (receipts.length !== 1 || receipts[0][2] !== `${prefix}${expectedMessage}`
    || Date.parse(receipts[0][1]) < start || Date.parse(receipts[0][1]) > end) {
    throw new ReusableReceiptGap("No unique exact protected noop readback within its host step interval.");
  }
  return { consumerCorrect: true, consumerReceiptSha256: sha256(logText) };
}
