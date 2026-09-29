import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileAndCompare,
  doctorFindings,
  formatValidationReport,
  validateEnablement,
  validatePolicy,
  validateRepository,
  validateSecurity,
} from "../../activity/validation.mjs";

const version = "v0.89.22";
const metadata = `# gh-aw-metadata: {"compiler_version":"${version}"}\n`;

async function fixture({ lock = metadata, policyCampaign = true, declaration = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-validation-test-"));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "sample.md"), "---\nname: Sample\non: workflow_dispatch\n---\n");
  if (lock !== null) await writeFile(path.join(root, ".github", "workflows", "sample.lock.yml"), lock);
  if (declaration) {
    await mkdir(path.join(root, "sample"), { recursive: true });
    await writeFile(path.join(root, "sample", "cao.json"), JSON.stringify({
      campaign: "sample",
      orchestrator: "sample",
      workers: { worker: "sample-worker" },
    }));
    await writeFile(path.join(root, ".github", "workflows", "sample-worker.md"), "---\nname: Worker\non: workflow_dispatch\n---\n");
    await writeFile(path.join(root, ".github", "workflows", "sample-worker.lock.yml"), metadata);
  }
  const policy = {
    version: 1,
    "gh-aw-version": version,
    "control-plane": {
      campaigns: policyCampaign ? {
        sample: { workers: { worker: { workflow: "sample-worker" } } },
      } : {},
    },
  };
  await writeFile(path.join(root, ".github", "workflows", "cao.json"), JSON.stringify(policy));
  return root;
}

function compiler({ status = 0, output } = {}) {
  return (command, args, options) => {
    if (command === "git" && args[0] === "init") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "gh" && args[0] === "aw" && args[1] === "compile") {
      if (output) output(args, options);
      return { status, stdout: "", stderr: status ? "invalid workflow trigger" : "" };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("strict compiler accepts a clean generated workflow set", async () => {
  const root = await fixture({ declaration: false });
  try {
    assert.deepEqual(await compileAndCompare(root, compiler(), version), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes compiler errors", async () => {
  const root = await fixture({ declaration: false });
  try {
    const findings = await compileAndCompare(root, compiler({ status: 1 }), version);
    assert.equal(findings[0].id, "invalid-trigger");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects missing generated workflows", async () => {
  const root = await fixture({ declaration: false, lock: null });
  try {
    const findings = await compileAndCompare(root, compiler({
      output(args, options) {
        writeFileSync(path.join(options.cwd, ".github", "workflows", "sample.lock.yml"), metadata);
      },
    }), version);
    assert.equal(findings[0].id, "missing-generated-workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects stale generated workflows", async () => {
  const root = await fixture({ declaration: false });
  try {
    const findings = await compileAndCompare(root, compiler({
      output(args, options) {
        writeFileSync(path.join(options.cwd, ".github", "workflows", "sample.lock.yml"), `${metadata}changed\n`);
      },
    }), version);
    assert.equal(findings[0].id, "stale-generated-workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects generated workflows from another compiler version", async () => {
  const root = await fixture({ declaration: false, lock: '# gh-aw-metadata: {"compiler_version":"v0.1.0"}\n' });
  try {
    const findings = await compileAndCompare(root, compiler(), version);
    assert.equal(findings[0].id, "unexpected-compiler-version");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production policy validation rejects invalid policy", async () => {
  const root = await fixture({ declaration: false });
  try {
    const { findings } = await validatePolicy(root, '{"version":2}');
    assert.equal(findings[0].id, "invalid-cao-policy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects installed campaigns absent from policy", async () => {
  const root = await fixture({ policyCampaign: false });
  try {
    const source = await readFile(path.join(root, ".github", "workflows", "cao.json"), "utf8");
    const { findings } = await validatePolicy(root, source);
    assert.equal(findings.some(({ id }) => id === "installed-campaign-absent-from-policy"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects campaign declarations with a missing worker workflow", async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, ".github", "workflows", "sample-worker.md"));
    const source = await readFile(path.join(root, ".github", "workflows", "cao.json"), "utf8");
    const { findings } = await validatePolicy(root, source);
    assert.equal(findings.some(({ id }) => id === "missing-workflow"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects partially disabled campaigns from one workflow registry call", () => {
  let calls = 0;
  const execute = () => {
    calls += 1;
    return {
      status: 0,
      stdout: JSON.stringify([
        { path: ".github/workflows/sample.lock.yml", state: "active" },
        { path: ".github/workflows/sample-worker.lock.yml", state: "disabled_manually" },
      ]),
      stderr: "",
    };
  };
  const findings = validateEnablement(".", execute, [{
    campaign: "sample", orchestrator: "sample", workers: { worker: "sample-worker" },
  }]);
  assert.equal(calls, 1);
  assert.equal(findings[0].id, "campaign-partially-disabled");
});

test("preserves unavailable GitHub enablement state as unknown", () => {
  const findings = validateEnablement(".", () => ({ status: 1, stdout: "", stderr: "no auth" }), []);
  assert.equal(findings[0].id, "github-enablement-state-unavailable");
  assert.equal(findings[0].severity, "warning");
});

test("detects bounded static security findings", async () => {
  const root = await fixture({ declaration: false });
  try {
    await writeFile(path.join(root, ".github", "workflows", "unsafe.yml"), [
      "on:", "  pull_request_target:", "jobs:", "  test:", "    steps:",
      "      - uses: someone/action@v1", "",
    ].join("\n"));
    const findings = await validateSecurity(root, "{}");
    assert.deepEqual(findings.map(({ id }) => id), [
      "unsafe-pull-request-target",
      "unpinned-third-party-action",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows only the reviewed protected-main publisher exception", async () => {
  const root = await fixture({ declaration: false });
  try {
    await writeFile(path.join(root, ".github", "workflows", "package.yml"), [
      "jobs:",
      "  publish:",
      "    uses: githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main # zizmor: ignore[unpinned-uses] protected default-branch publisher",
      "  unreviewed:",
      "    uses: githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main",
      "  other:",
      "    uses: githubnext/gh-aw-cao/.github/workflows/other.yml@main",
      "  external:",
      "    steps:",
      "      - uses: someone/action@main",
      "",
    ].join("\n"));
    const findings = await validateSecurity(root, "{}");
    assert.deepEqual(findings.map(({ observed }) => observed), [
      "githubnext/gh-aw-cao/.github/workflows/cao-package-publish.yml@main",
      "githubnext/gh-aw-cao/.github/workflows/other.yml@main",
      "someone/action@main",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects worker dispatch and orchestrator mutation capabilities", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, ".github", "workflows", "sample.md"), [
      "---", "safe-outputs:", "  create-issue:", "---", "",
    ].join("\n"));
    await writeFile(path.join(root, ".github", "workflows", "sample-worker.md"), [
      "---", "safe-outputs:", "  dispatch-workflow:", "---", "",
    ].join("\n"));
    const findings = await validateSecurity(root, "{}", [{
      campaign: "sample", orchestrator: "sample", workers: { worker: "sample-worker" },
    }]);
    assert.deepEqual(findings.map(({ id }) => id), [
      "orchestrator-can-mutate-target",
      "worker-can-dispatch-workflow",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor failures are warnings", () => {
  const execute = (command) => command === "git"
    ? { status: 0, stdout: "https://github.com/acme/control.git\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "not authenticated" };
  assert.equal(doctorFindings(".", execute)[0].severity, "warning");
});

function cleanExecutor() {
  return (command, args) => {
    if (command === "git" && args[0] === "init") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "gh" && args.join(" ") === "aw version") {
      return { status: 0, stdout: "", stderr: `gh aw version ${version}\n` };
    }
    if (command === "gh" && args[0] === "aw" && args[1] === "compile") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "gh" && args[0] === "aw" && args[1] === "doctor") {
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (command === "gh" && args[0] === "workflow") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { path: ".github/workflows/sample.lock.yml", state: "active" },
          { path: ".github/workflows/sample-worker.lock.yml", state: "active" },
        ]),
        stderr: "",
      };
    }
    if (command === "git") return { status: 0, stdout: "https://github.com/acme/control.git\n", stderr: "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("clean repositories and warnings-only repositories exit successfully", async () => {
  const root = await fixture();
  try {
    const clean = await validateRepository({ root, execute: cleanExecutor(), now: () => new Date(0) });
    assert.equal(clean.exitCode, 0);
    assert.deepEqual(clean.summary, { errors: 0, warnings: 0, notes: 0 });
    const warning = await validateRepository({
      root,
      execute(command, args, options) {
        if (command === "gh" && args[0] === "workflow") return { status: 1, stdout: "", stderr: "offline" };
        return cleanExecutor()(command, args, options);
      },
      now: () => new Date(0),
    });
    assert.equal(warning.exitCode, 0);
    assert.equal(warning.summary.warnings, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation errors exit 1 and internal failures exit 2", async () => {
  const root = await fixture();
  const missing = await mkdtemp(path.join(os.tmpdir(), "cao-validation-missing-"));
  try {
    const wrongVersion = await validateRepository({
      root,
      execute(command, args, options) {
        if (command === "gh" && args.join(" ") === "aw version") {
          return { status: 0, stdout: "v0.1.0", stderr: "" };
        }
        return cleanExecutor()(command, args, options);
      },
    });
    assert.equal(wrongVersion.exitCode, 1);
    assert.equal(wrongVersion.findings.some(({ id }) => id === "wrong-gh-aw-compiler-version"), true);
    const missingPolicy = await validateRepository({ root: missing, execute: cleanExecutor() });
    assert.equal(missingPolicy.exitCode, 1);
    assert.equal(missingPolicy.findings[0].id, "missing-cao-policy");
    const internalFailure = await validateRepository({
      root,
      execute() {
        throw new Error("executor failed");
      },
    });
    assert.equal(internalFailure.exitCode, 2);
    assert.equal(internalFailure.findings.at(-1).id, "validator-failure");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
  }
});

test("human and JSON frontends represent the same report", async () => {
  const root = await fixture();
  try {
    const report = await validateRepository({ root, execute: cleanExecutor(), now: () => new Date(0) });
    const human = formatValidationReport(report);
    const json = JSON.parse(JSON.stringify(report));
    assert.match(human, /CAO validation/);
    assert.equal(json.summary.errors, report.summary.errors);
    assert.deepEqual(json.findings, report.findings);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
