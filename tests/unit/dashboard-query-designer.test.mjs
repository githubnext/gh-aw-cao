import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";
import { assertQueryEditorAuthoring, assertQueryEditorEnhancement, assertQueryEditorIntent } from "../../dashboard/query-editor-contract.mjs";
import { enhanceQueryEditorIntent, generateDashboardQuery } from "../../com.github.copilot/extensions/cao-dashboard/query-designer.mjs";

const intent = { intent: "Find failing workflows", subject: "Workflow failures", acceptance: "Show native failure counts, not inferred outcomes." };

test("query designer rejects missing, oversized, and capability-shaped inputs", () => {
  assert.doesNotThrow(() => assertQueryEditorIntent(intent));
  for (const value of [null, [], {}, { ...intent, intent: " " }, { ...intent, model: "custom" }, { ...intent, subject: "x".repeat(2001) }]) {
    assert.throws(() => assertQueryEditorIntent(value));
  }
});

test("query designer uses the trusted skill and SDK session without ambient tools", async () => {
  let clientOptions;
  let config;
  let prompt;
  let stopped = 0;
  const result = await generateDashboardQuery(intent, {
    signal: new AbortController().signal,
    createClient: (options) => {
      clientOptions = options;
      return {
        createSession: async (options) => {
          config = options;
          return { sendAndWait: async (options) => { prompt = options.prompt; return { data: { content: '{"dashboard":{}}' } }; } };
        },
        stop: async () => { stopped += 1; return []; },
      };
    },
  });
  assert.equal(clientOptions.mode, "empty");
  assert.deepEqual(config.availableTools, []);
  assert.equal(config.enableConfigDiscovery, false);
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.skillDirectories, []);
  assert.deepEqual(config.tools, []);
  assert.deepEqual(config.customAgents, []);
  assert.equal(config.onPermissionRequest().kind, "reject");
  assert.equal(config.systemMessage.mode, "append");
  assert.match(config.systemMessage.content, /# Generate Dashboard IR/);
  assert.match(config.systemMessage.content, /Dashboard Language Specification/);
  assert.match(config.systemMessage.content, /data.limit of at most 200/);
  assert.match(config.systemMessage.content, /512 Unicode characters combined, not per field/);
  assert.match(config.systemMessage.content, /declare encoding\.x\["time-unit"\] as hour, day, week, or month/);
  assert.match(config.systemMessage.content, /Pre-bucketing with date-bucket does not replace this required encoding property/);
  assert.match(config.systemMessage.content, /# Declarative charts/);
  assert.match(config.systemMessage.content, /# Dashboard Authoring/);
  assert.ok(prompt.includes(JSON.stringify(intent)));
  assert.deepEqual(result, { document: '{"dashboard":{}}' });
  assert.equal(stopped, 1);
  await assert.rejects(stat(clientOptions.baseDirectory), { code: "ENOENT" });
});

test("one intent authoring session improves all fields using the trusted skill and no tools", async () => {
    const request = { intent: intent.intent };
    const authoring = { ...intent, objective: "Prioritize investigation." };
    assert.doesNotThrow(() => assertQueryEditorEnhancement(request));
    const result = await enhanceQueryEditorIntent(request, {
      signal: new AbortController().signal,
      createClient: () => ({
        createSession: async (config) => {
          assert.deepEqual(config.availableTools, []);
          assert.deepEqual(config.tools, []);
          assert.deepEqual(config.mcpServers, {});
          assert.deepEqual(config.skillDirectories, []);
          assert.match(config.systemMessage.content, /# Author dashboard intent/);
          assert.match(config.systemMessage.content, /512 Unicode characters combined, not per field/);
          return { sendAndWait: async ({ prompt }) => {
            assert.ok(prompt.includes(JSON.stringify(request)));
            return { data: { content: JSON.stringify(authoring) } };
          } };
        },
        stop: async () => [],
      }),
    });
    assert.deepEqual(result, authoring);
  assert.throws(() => assertQueryEditorEnhancement({ field: "document", text: "text", context: {} }));
  assert.throws(() => assertQueryEditorEnhancement({ field: "intent", text: "", context: {} }));
  assert.doesNotThrow(() => assertQueryEditorEnhancement({ intent: intent.intent }));
});

test("enhanced authoring and generation share the validator's combined Unicode character budget", () => {
  const boundary = {
    intent: "Preserve detailed context outside the annotation budget.",
    subject: "\u{1f600}".repeat(170), objective: "b".repeat(170), acceptance: "c".repeat(172),
  };
  assert.doesNotThrow(() => assertQueryEditorAuthoring(boundary));
  assert.doesNotThrow(() => assertQueryEditorIntent(boundary));
  const oversized = { ...boundary, acceptance: `${boundary.acceptance}d` };
  assert.throws(() => assertQueryEditorAuthoring(oversized), /at most 512 characters \(found 513\)/);
  assert.throws(() => assertQueryEditorIntent(oversized), /at most 512 characters \(found 513\)/);
  assert.doesNotThrow(() => assertQueryEditorEnhancement(oversized), "Overlong input must remain eligible for condensation.");
});

test("intent authoring rejects over-budget SDK output without silently truncating it", async () => {
  const output = { ...intent, objective: "x".repeat(500) };
  let stopped = 0;
  await assert.rejects(enhanceQueryEditorIntent({ intent: intent.intent }, {
    signal: new AbortController().signal,
    createClient: () => ({
      createSession: async () => ({
        sendAndWait: async () => ({ data: { content: JSON.stringify(output) } }),
      }),
      stop: async () => { stopped += 1; return []; },
    }),
  }), /at most 512 characters/);
  assert.equal(stopped, 1);
});

test("query designer aborts the SDK and cleans up on cancellation and errors", async () => {
  const controller = new AbortController();
  let aborted = 0;
  let stopped = 0;
  await assert.rejects(generateDashboardQuery(intent, {
    signal: controller.signal,
    createClient: () => ({
      createSession: async () => ({
        abort: async () => { aborted += 1; },
        sendAndWait: async () => { controller.abort(); return { data: { content: "{}" } }; },
      }),
      stop: async () => { stopped += 1; return []; },
    }),
  }), { name: "AbortError" });
  assert.equal(aborted, 1);
  assert.equal(stopped, 1);
  await assert.rejects(generateDashboardQuery(intent, {
    signal: new AbortController().signal,
    createClient: () => ({
      createSession: async () => { throw new Error("SDK unavailable"); },
      stop: async () => { stopped += 1; return []; },
    }),
  }), /SDK unavailable/);
  assert.equal(stopped, 2);
});
