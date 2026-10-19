import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hostGateObservation } from "../../scripts/collect-host-assertion-evidence.mjs";
import { readConformanceLogArchive } from "../../scripts/collect-engine-conformance-evidence.mjs";
import { coreBehaviorProbes } from "../../scripts/native-engine-conformance.mjs";
import { HostLogEvidenceGap, parseExperimentAssignmentLog, readProtectedHostLog } from "../../scripts/protected-host-log.mjs";
import { readProtectedExperimentJobLog } from "../../scripts/protected-experiment-job-log.mjs";

const name = "sub_agent_strategy", stepName = "Pick experiment variants";
const variants = ["inline_strict", "delegated_sequential", "single_agent_control"];
const selector = { name: stepName, number: 8, status: "completed", conclusion: "success",
  started_at: "2026-10-18T14:00:00Z", completed_at: "2026-10-18T14:00:01Z" };
const line = (variant = variants[0], at = "2026-10-18T14:00:00.1234567Z") =>
  `${at} Experiment assignments (JSON): ${JSON.stringify({ [name]: variant })}`;

test("shared log extraction preserves the existing conformance report and receipt shape", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-conformance-log-"));
  try {
    const checks = [...coreBehaviorProbes, "fixtures", "agent-execution"].map(name => ({ name, status: "passed" }));
    const text = ["## Engine conformance: copilot", ...checks.map(check => `| ${check.name} | ${check.status} |`),
      "Overall: **PASSED**"].join("\n");
    const entry = "1_Assert engine conformance.txt";
    writeFileSync(path.join(directory, entry), text);
    execFileSync("zip", ["-q", "logs.zip", entry], { cwd: directory });
    const result = await readConformanceLogArchive(readFileSync(path.join(directory, "logs.zip")), "copilot");
    assert.deepEqual(result.report, { engine: "copilot", status: "passed", checks });
    assert.deepEqual(Object.keys(result).sort(), ["archiveSha256", "hostEntry", "hostLogSha256", "report"]);
    assert.equal(result.hostEntry, entry);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("protected log extraction selects the exact producer job and fails closed on ambiguity or missing evidence", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-log-test-"));
  try {
    for (const job of ["activation", "agent"]) mkdirSync(path.join(directory, job));
    const producer = `activation/8_${stepName}.txt`, decoy = `agent/8_${stepName}.txt`;
    writeFileSync(path.join(directory, producer), line());
    writeFileSync(path.join(directory, decoy), line("single_agent_control"));
    execFileSync("zip", ["-q", "logs.zip", producer, decoy], { cwd: directory });
    const archive = readFileSync(path.join(directory, "logs.zip"));
    const receipt = readProtectedHostLog(archive, stepName, "activation");
    assert.equal(receipt.text, line());
    assert.equal(receipt.hostEntry, producer);
    assert.match(receipt.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.hostLogSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => readProtectedHostLog(archive, stepName), HostLogEvidenceGap);
    assert.throws(() => readProtectedHostLog(archive, stepName, "missing"), HostLogEvidenceGap);
    const duplicate = `activation/9_${stepName}.txt`;
    writeFileSync(path.join(directory, duplicate), line());
    execFileSync("zip", ["-q", "logs.zip", duplicate], { cwd: directory });
    assert.throws(() => readProtectedHostLog(readFileSync(path.join(directory, "logs.zip")), stepName, "activation"), HostLogEvidenceGap);
    assert.throws(() => readProtectedHostLog(Buffer.from("not a zip"), stepName, "activation"), HostLogEvidenceGap);
    assert.throws(() => readProtectedHostLog(archive, "../unsafe"), /Invalid bounded/);
    assert.throws(() => readProtectedHostLog(Buffer.alloc(64 * 1024 * 1024 + 1), stepName), /Invalid bounded/);
    writeFileSync(path.join(directory, producer), "x".repeat(1024 * 1024 + 1));
    execFileSync("zip", ["-q", "large.zip", producer], { cwd: directory });
    assert.throws(() => readProtectedHostLog(readFileSync(path.join(directory, "large.zip")), stepName, "activation"), HostLogEvidenceGap);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("assignment receipts require exactly one source-declared variant inside the successful initial selector interval", () => {
  for (const variant of variants) assert.equal(parseExperimentAssignmentLog(line(variant), name, selector, variants).variant, variant);
  assert.equal(parseExperimentAssignmentLog(line(variants[0], "2026-10-18T14:00:01.999Z"), name, selector, variants).variant, variants[0]);
  for (const text of ["", `${line()}\n${line()}`, line("invented"),
    line(variants[0], "2026-10-18T13:59:59.999Z"), line(variants[0], "2026-10-18T14:00:02Z"),
    line().replace('"inline_strict"', 'null'), line().replace('}', ',"unreviewed":"extra"}'),
    line().replace('{"', '{"sub_agent_strategy":"single_agent_control","'),
    line().replace('{"', '{"broken", "')]) {
    assert.throws(() => parseExperimentAssignmentLog(text, name, selector, variants), HostLogEvidenceGap);
  }
  assert.throws(() => parseExperimentAssignmentLog(line(), name, { ...selector, conclusion: "failure" }, variants), HostLogEvidenceGap);
  assert.throws(() => parseExperimentAssignmentLog(line(), name, selector, ["duplicate", "duplicate"]), /Invalid bounded/);
});

test("aggregated ZIP layouts require the exact protected producer job and the source-bound selector interval", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cao-experiment-job-log-"));
  try {
    writeFileSync(path.join(directory, "7_activation.txt"), line("delegated_sequential"));
    writeFileSync(path.join(directory, "1_agent.txt"), line("inline_strict"));
    execFileSync("zip", ["-q", "logs.zip", "7_activation.txt", "1_agent.txt"], { cwd: directory });
    const policy = { name, variants };
    const archive = readFileSync(path.join(directory, "logs.zip"));
    const receipt = readProtectedExperimentJobLog(archive, "activation", policy, selector);
    assert.equal(receipt.variant, "delegated_sequential");
    assert.equal(receipt.hostEntry, "7_activation.txt");
    assert.equal(receipt.logLayout, "protected-job-step-interval");
    assert.throws(() => readProtectedExperimentJobLog(archive, "activation", policy,
      { ...selector, started_at: "2026-10-18T14:01:00Z", completed_at: "2026-10-18T14:01:01Z" }), HostLogEvidenceGap);
    mkdirSync(path.join(directory, "agent"));
    writeFileSync(path.join(directory, "agent/8_activation.txt"), line());
    execFileSync("zip", ["-q", "decoy.zip", "agent/8_activation.txt"], { cwd: directory });
    assert.throws(() => readProtectedExperimentJobLog(readFileSync(path.join(directory, "decoy.zip")),
      "activation", policy, selector), HostLogEvidenceGap);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("successful native subagent assertions need independently bound positive variants, never synthetic controls", () => {
  const contract = { until: "2026-10-18T15:00:12Z", jobs: { agent: { name: "agent" }, activation: { name: "activation" } } };
  const gate = { job: "agent", name: "Verify", experiment: { job: "activation", step: stepName,
    name, variants, positiveVariants: variants.slice(0, 2) } };
  const assertion = { ...selector, name: "Verify", number: 58 };
  const response = { total_count: 2, jobs: [{ id: 1, name: "agent", steps: [assertion] },
    { id: 2, name: "activation", steps: [selector] }] };
  const proof = variant => ({ status: "available", ...parseExperimentAssignmentLog(line(variant), name, selector, variants),
    jobName: "activation", jobId: 2, selectorReceipt: selector, hostEntry: `activation/8_${stepName}.txt`,
    archiveSha256: "a".repeat(64), hostLogSha256: "b".repeat(64) });
  for (const variant of variants.slice(0, 2)) assert.equal(hostGateObservation(contract, gate, response, proof(variant)).passed, true);
  const jobReceipt = { ...proof(variants[0]), hostEntry: "7_activation.txt", logLayout: "protected-job-step-interval" };
  assert.equal(hostGateObservation(contract, gate, response, jobReceipt).passed, null);
  assert.equal(hostGateObservation({ ...contract, conditionJobOracleSha256: "c".repeat(64) }, gate, response, jobReceipt).passed, true);
  for (const evidence of [null, { status: "unavailable", reason: "Expired" }, proof("single_agent_control"),
    { ...proof(variants[0]), jobId: 3 }, { ...proof(variants[0]), hostEntry: `agent/8_${stepName}.txt` },
    { ...proof(variants[0]), variant: "single_agent_control" }, { ...proof(variants[0]), archiveSha256: "" },
    { ...proof(variants[0]), selectorReceipt: { ...selector, number: 9 } },
    { ...proof(variants[0]), assignmentLine: line("invented") }]) {
    assert.equal(hostGateObservation(contract, gate, response, evidence).passed, null);
  }
});
