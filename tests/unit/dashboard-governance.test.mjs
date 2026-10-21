import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveQueuedCliAction } from "../../dashboard/cli-action-api.mjs";
import { executeDashboardCommand } from "../../dashboard/cli-actions.mjs";
import { executeEnvironmentDefaults } from "../../dashboard/environment-defaults.mjs";

const fragment = JSON.parse(readFileSync(new URL("../../dashboard/site/dashboard-fragments/governance.json", import.meta.url)));
const dashboard = { dashboard: fragment };
const yaml = 'default_max_turns: "20"\ndefault_model_copilot: null\n';

test("Governance queue admission requires validated YAML only for declared scoped updates", () => {
  for (const [scope, field, target] of [
    ["repo", "repository", "acme/target"], ["org", "organization", "acme"], ["ent", "enterprise", "acme-enterprise"],
  ]) {
    const get = { id: `governance-get-${scope}`, values: { [field]: target } };
    assert.match(resolveQueuedCliAction(dashboard, get).command, /^gh aw env get cao-governance.yml/);
    assert.throws(() => resolveQueuedCliAction(dashboard, { ...get, input: yaml }), { status: 400 });
    const update = { id: `governance-update-${scope}`, values: {
      [field]: target, ...(scope === "repo" ? {} : { visibility: "all" }),
    } };
    assert.throws(() => resolveQueuedCliAction(dashboard, update), { status: 400 });
    assert.match(resolveQueuedCliAction(dashboard, { ...update, input: yaml }).command, /--dry-run$/);
    assert.doesNotMatch(resolveQueuedCliAction(dashboard, {
      ...update, input: yaml, arguments: { "dry-run": false },
    }).command, /--dry-run/);
    for (const input of [
      'default_max_turns: 10', 'secret: "no"', 'default_model: [a]', '{}',
      'default_model: "first"\ndefault_model: "second"', 'default_model: &value "x"',
      'default_model: "x"\n---\ndefault_other: "y"',
    ]) {
      assert.throws(() => resolveQueuedCliAction(dashboard, { ...update, input }), { status: 400 });
    }
    assert.throws(() => resolveQueuedCliAction(dashboard, {
      ...update, input: yaml, values: { ...update.values, [field]: "acme;whoami" },
    }), { status: 400 });
  }
});

test("the managed file executor separates downloaded YAML from diagnostics and cleans up", async () => {
  for (const streaming of [false, true]) {
    let directory;
    const events = [];
    const result = await executeDashboardCommand({
      command: "gh aw env get cao-governance.yml --scope org --org acme",
      workingDirectory: process.cwd(), githubToken: "test-fixture",
      execute: async (executable, args, options) => {
        assert.equal(executable, "gh");
        if (args.includes("--help")) return { stdout: "", stderr: "" };
        assert.deepEqual(args, ["aw", "env", "get", "cao-governance.yml", "--scope", "org", "--org", "acme"]);
        assert.equal(options.terminal, false);
        directory = options.cwd;
        await writeFile(join(directory, "cao-governance.yml"), yaml);
        return { stdout: "diagnostic", stderr: "saved\n" };
      },
      streamCommand: async ({ args, workingDirectory, terminal, input, onOutput }) => {
        assert.deepEqual(args.slice(0, 4), ["aw", "env", "get", "cao-governance.yml"]);
        assert.equal(terminal, false);
        assert.equal(input, undefined);
        directory = workingDirectory;
        onOutput({ stream: "stdout", data: "Progress\n" });
        onOutput({ stream: "stderr", data: "Saved\n" });
        await writeFile(join(directory, "cao-governance.yml"), yaml);
        return { ok: true, exitCode: 0 };
      },
      ...(streaming ? { onOutput: (event) => events.push(event) } : {}),
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, yaml);
    if (!streaming) assert.equal(result.stderr, "diagnostic\nsaved\n");
    assert.notEqual(directory, process.cwd());
    await assert.rejects(stat(directory), { code: "ENOENT" });
    if (streaming) assert.deepEqual(events, [
      { stream: "stderr", data: "Progress\n" }, { stream: "stderr", data: "Saved\n" }, { stream: "stdout", data: yaml },
    ]);
  }
});

test("the managed file executor never puts YAML into argv or stdin and removes staged files", async () => {
  let directory;
  const input = 'default_model_copilot: "model; $(this is data)"\n';
  await executeDashboardCommand({
    command: "gh aw env update cao-governance.yml --scope ent --enterprise acme --visibility all --yes --dry-run",
    workingDirectory: process.cwd(), githubToken: "test-fixture", input, onOutput: () => {},
    execute: async () => ({ stdout: "", stderr: "" }),
    streamCommand: async (options) => {
      directory = options.workingDirectory;
      assert.equal(options.input, undefined);
      assert.equal(options.terminal, false);
      assert.equal(options.args.some((arg) => arg.includes("this is data")), false);
      const file = join(directory, "cao-governance.yml");
      assert.equal(await readFile(file, "utf8"), input);
      if (process.platform !== "win32") {
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
      }
      return { ok: true, exitCode: 0 };
    },
  });
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("failed, malformed, missing and canceled downloads never produce successful YAML", async () => {
  for (const outcome of ["failed", "invalid", "missing", "throws", "canceled"]) {
    let directory;
    const signal = new AbortController();
    const events = [];
    const invocation = executeEnvironmentDefaults({
      operation: "get", signal: signal.signal, onOutput: (event) => events.push(event),
      run: async (cwd) => {
        directory = cwd;
        if (outcome === "failed") return { ok: false, exitCode: 1, error: "Permission denied" };
        if (outcome === "throws") throw new Error("Subprocess failure");
        if (outcome === "canceled") signal.abort();
        if (outcome !== "missing") await writeFile(join(cwd, "cao-governance.yml"), "not a defaults mapping");
        return { ok: true, exitCode: 0 };
      },
    });
    if (outcome === "failed") assert.equal((await invocation).ok, false);
    else await assert.rejects(invocation);
    assert.equal(events.some((event) => event.stream === "stdout"), false);
    await assert.rejects(stat(directory), { code: "ENOENT" });
  }
});
