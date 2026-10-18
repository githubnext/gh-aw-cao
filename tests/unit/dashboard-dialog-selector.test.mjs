import assert from "node:assert/strict";
import test from "node:test";
import { lookupDialogOptions } from "../../dashboard/dialog-selector.mjs";
import { assertDialogSelector } from "../../dashboard/site/src/dialog-selector.js";

const selector = {
  label: "Repository", "debounce-ms": 300,
  query: { command: "gh search repos", fields: ["fullName", "description"], limit: 20 },
  mapping: { value: "fullName", label: "fullName", description: "description", target: "repository" },
};
const action = { command: "gh cao repos add {{repository}}", selector };

test("selector runs only declared read-only argv and maps results declaratively", async () => {
  const options = await lookupDialogOptions(action, "--help; $(echo untrusted)", {
    workingDirectory: "/tmp", execute: async (command, args, config) => {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["search", "repos", "--limit", "20", "--json", "fullName,description", "--", "--help; $(echo untrusted)"]);
      assert.equal(config.cwd, "/tmp");
      assert.equal(config.timeout, 15000);
      return { stdout: JSON.stringify([{ fullName: "octo/repo", description: "Example" }]) };
    },
  });
  assert.deepEqual(options, [{ value: "octo/repo", label: "octo/repo", description: "Example" }]);
});

test("selector rejects unsupported commands, mappings, query fields, limits, and debounce", () => {
  for (const changed of [
    { query: { ...selector.query, command: "gh api" } },
    { query: { ...selector.query, fields: ["fullName", "not-a-field"] } },
    { query: { ...selector.query, limit: 100 } },
    { mapping: { ...selector.mapping, target: "missing" } },
    { mapping: { ...selector.mapping, label: "missing" } },
    { "debounce-ms": 0 }, { extra: true },
  ]) assert.throws(() => assertDialogSelector({ ...selector, ...changed }, ["repository"]), /Dialog selector/);
});

test("lookup fails on malformed results and propagates lookup failures", async () => {
  for (const stdout of ["{}", '[{"fullName":"octo/repo","description":{}}]', "[{}]", "not json"]) {
    await assert.rejects(lookupDialogOptions(action, "octo", { execute: async () => ({ stdout }) }));
  }
  await assert.rejects(lookupDialogOptions(action, "x"), /2 to 200/);
  await assert.rejects(lookupDialogOptions(action, "octo", { execute: async () => { throw new Error("not authenticated"); } }), /not authenticated/);
});

test("broad searches remain bounded when hundreds of repositories match", async () => {
  const matches = Array.from({ length: 500 }, (_, index) => ({
    fullName: `octo/repository-${index}`, description: `Repository ${index}`,
  }));
  const controller = new AbortController();
  const options = await lookupDialogOptions(action, "repository", {
    signal: controller.signal,
    execute: async (_command, args, config) => {
      assert.equal(config.signal, controller.signal);
      assert.equal(config.timeout, 15000);
      assert.equal(config.maxBuffer, 256 * 1024);
      const limit = Number(args[args.indexOf("--limit") + 1]);
      assert.equal(limit, selector.query.limit);
      return { stdout: JSON.stringify(matches.slice(0, limit)) };
    },
  });
  assert.equal(options.length, selector.query.limit);
  assert.equal(options.at(-1).value, "octo/repository-19");
  await assert.rejects(lookupDialogOptions(action, "repository", {
    execute: async () => ({ stdout: JSON.stringify(matches) }),
  }), /invalid results/);
});
