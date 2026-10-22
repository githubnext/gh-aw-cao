import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assertUnknownCommandsRejectBeforeIO(runtimeRoot, t) {
  runtimeRoot = realpathSync(runtimeRoot);
  const directory = mkdtempSync(path.join(tmpdir(), "cao-unknown-commands-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.resolve(import.meta.dirname, "../../dashboard/site/test/fixtures/gh-aw-logs");
  for (const name of ["context.json", "ingets"]) {
    copyFileSync(path.join(fixture, "context.json"), path.join(directory, name));
  }
  mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(directory, ".github/workflows/cao.json"), '{"version":1}\n');
  writeFileSync(path.join(directory, "snapshot.sqlite"), "must not open or modify this database");
  writeFileSync(path.join(directory, "malformed.json"), "{");
  const before = readdirSync(directory, { recursive: true }).sort();
  const originals = before
    .filter(name => ![".github", path.join(".github", "workflows")].includes(name))
    .map(name => [name, readFileSync(path.join(directory, name))]);
  const moduleUrl = relative => pathToFileURL(path.join(runtimeRoot, relative)).href;
  const cases = [
    ["not-a-command"],
    ["not-a-command", "--help"],
    ["not-a-command", "--stdin"],
    ["not-a-command", "--database"],
    ["not-a-command", "snapshot.sqlite"],
    ["not-a-command", "--database", "snapshot.sqlite"],
    ["not-a-command", "one", "two"],
    ["ingets", path.join(fixture, "run-303")],
    ["./context.json", path.join(fixture, "run-303")],
    [path.join(directory, "context.json"), path.join(fixture, "run-303")],
    ["malformed.json", path.join(fixture, "run-303")],
    ["missing.json", path.join(fixture, "run-303")],
  ];
  // Load dependencies before guarding I/O so module loading is not mistaken for command execution.
  const guard = `
    import fs from "node:fs";
    import promises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import ${JSON.stringify(moduleUrl("activity/cli/run.mjs"))};
    import { SqliteIndexedDBFactory } from ${JSON.stringify(moduleUrl("dashboard/site/src/data/storage/sqlite-indexeddb.js"))};
    const forbidden = name => () => { throw new Error("Unexpected command I/O: " + name); };
    const isEntrypoint = file => [${JSON.stringify(path.join(runtimeRoot, "activity/cao.mjs"))}, ${JSON.stringify(moduleUrl("activity/cao.mjs"))}].includes(String(file));
    const readFile = promises.readFile;
    promises.readFile = (file, ...args) => isEntrypoint(file)
      ? readFile(file, ...args) : forbidden("readFile")();
    for (const name of ["mkdir", "mkdtemp", "rm", "readdir", "stat", "open", "writeFile"]) {
      promises[name] = forbidden(name);
    }
    const openSync = fs.openSync;
    fs.openSync = (file, ...args) => isEntrypoint(file)
      && (args[0] === "r" || args[0] === 0) ? openSync(file, ...args) : forbidden("openSync: " + file)();
    for (const name of ["mkdirSync", "mkdtempSync", "rmSync", "writeFileSync", "appendFileSync", "createReadStream"]) {
      fs[name] = forbidden(name);
    }
    SqliteIndexedDBFactory.prototype.open = forbidden("SQLite open");
    syncBuiltinESMExports();
  `;
  const execute = args => spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(guard)}`, ...args,
  ], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CAO_DEBUG: "", NODE_OPTIONS: "" },
    input: "must not consume stdin",
  });
  const source = execute(["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { runCli } from ${JSON.stringify(moduleUrl("activity/cli/run.mjs"))};
    import { UsageError } from ${JSON.stringify(moduleUrl("activity/cli/options.mjs"))};
    const input = { [Symbol.asyncIterator]() { assert.fail("Unexpected stdin read"); } };
    for (const args of ${JSON.stringify(cases)}) {
      await assert.rejects(runCli(args, input), error =>
        error instanceof UsageError && error.message === "Unknown command: " + args[0]);
    }
  `]);
  assert.equal(source.status, 0, source.error?.message ?? source.stderr);
  assert.equal(source.stdout, "");
  assert.equal(source.stderr, "");
  for (const args of cases) {
    const result = execute([path.join(runtimeRoot, "activity/cao.mjs"), ...args]);
    assert.equal(result.status, 1, `${args}: ${result.error?.message ?? result.stderr}`);
    assert.equal(result.stdout, "", String(args));
    assert.equal(result.stderr, `Error: Unknown command: ${args[0]}\n`, String(args));
  }
  assert.deepEqual(readdirSync(directory, { recursive: true }).sort(), before);
  for (const [name, content] of originals) {
    assert.deepEqual(readFileSync(path.join(directory, name)), content);
  }
}
