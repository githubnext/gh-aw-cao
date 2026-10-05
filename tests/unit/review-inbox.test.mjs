import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { inert, normalizeFinding, publishInbox, validateHandoff } from "../../.github/workflows/shared/review-inbox.mjs";
import { runtimeScope, runInbox, validateFindings } from "../../.github/workflows/shared/review-inbox-runtime.mjs";

const scope = {
  campaign: "repo-assist", worker: "issue-triage", target: "acme/target",
  destination: "acme/review", control: "acme/control", sha: "a".repeat(40),
  workflow: "repo-assist-issue-triage", runId: "123",
  runUrl: "https://github.com/acme/control/actions/runs/123",
};
const proposal = { type: "create_issue", title: "[repo-assist:issue-triage] Fix parser",
  body: "<!-- cao-finding-key: parser -->\nTarget repository: acme/target\nVerified evidence." };
const bot = { login: "cao[bot]", type: "Bot" };

function mock() {
  const issues = [];
  const comments = new Map();
  const writes = [];
  const permissions = new Map([["writer", "write"], ["reader", "read"]]);
  let sequence = 1;
  let crash = "";
  let failPage = 0;
  const check = (operation) => {
    if (crash === operation) { crash = ""; throw new Error(`crash after ${operation}`); }
  };
  const api = {
    rest: {
      repos: {
        get: async () => ({ data: { private: true } }),
        getCollaboratorPermissionLevel: async ({ username }) => {
          if (permissions.get(username) === "error") throw new Error("permission API failed");
          return { data: { permission: permissions.get(username) ?? "read" } };
        },
      },
      issues: {
        listForRepo: async () => {},
        listComments: async () => {},
        create: async (input) => {
          writes.push(["create", input]);
          const issue = { ...input, number: sequence++, user: bot, labels: [], state: "open" };
          issues.push(issue); comments.set(issue.number, []);
          check("create");
          return { data: structuredClone(issue) };
        },
        createComment: async (input) => {
          writes.push(["comment", input]);
          const comment = { ...input, id: sequence++, user: bot, created_at: "2026-10-01T00:00:00Z" };
          comments.get(input.issue_number).push(comment);
          check("comment");
          return { data: structuredClone(comment) };
        },
        update: async (input) => {
          writes.push(["update", input]);
          Object.assign(issues.find(({ number }) => number === input.issue_number), input);
          check("update");
          return {};
        },
      },
    },
    paginate: async (method, input) => {
      assert.equal(input.per_page, 100);
      assert.equal(input.owner, "acme");
      assert.equal(input.repo, "review", "never read/write the target through the publishing credential");
      const rows = method === api.rest.issues.listForRepo ? issues : comments.get(input.issue_number) ?? [];
      const result = [];
      for (let page = 1; ; page += 1) {
        if (page === failPage) throw new Error("pagination failed");
        const batch = rows.slice((page - 1) * 100, page * 100);
        result.push(...structuredClone(batch));
        if (batch.length < 100) return result;
      }
    },
  };
  return { api, issues, comments, writes, permissions,
    crash: (operation) => { crash = operation; },
    failPage: (page) => { failPage = page; },
    human(body, login = "writer", number = issues[0].number) {
      const comment = { id: sequence++, body, user: { type: "User", login }, created_at: "2026-10-02T00:00:00Z" };
      comments.get(number).push(comment);
      return comment;
    },
    latest() {
      return comments.get(issues.at(-1).number).filter(({ body }) => body.startsWith("<!-- cao-review-record:"))
        .map(({ body }) => JSON.parse(Buffer.from(body.match(/^<!-- cao-review-record: (\S+) -->/)[1], "base64").toString()).finding).at(-1);
    },
  };
}

test("finding identity uses target, worker and canonical actionable key, never run", () => {
  const first = normalizeFinding(proposal, scope);
  assert.equal(first.id, normalizeFinding({ ...proposal, title: "Changed text" }, { ...scope, runId: "456" }).id);
  assert.notEqual(first.id, normalizeFinding(proposal, { ...scope, target: "acme/other" }).id);
  assert.notEqual(first.id, normalizeFinding(proposal, { ...scope, worker: "maintenance" }).id);
  assert.equal(normalizeFinding({ type: "create_issue", title: "[campaign:worker] FIX   parser", body: "" }, scope).id,
    normalizeFinding({ type: "create_issue", title: "fix parser", body: "" }, scope).id);
  assert.equal(normalizeFinding({ type: "add_comment", issue_number: 42, body: "first" }, scope).id,
    normalizeFinding({ type: "close_issue", issue_number: 42, body: "resolved" }, scope).id);
  assert.throws(() => normalizeFinding({ type: "create_issue", body: "" }, scope), /stable/);
});

test("one inbox, append-only details, bounded bot summary and stable no-op reruns", async () => {
  const m = mock();
  await publishInbox(m.api, scope, [proposal]);
  const writes = m.writes.length;
  await publishInbox(m.api, { ...scope, runId: "456", runUrl: scope.runUrl.replace("123", "456") }, [proposal]);
  assert.equal(m.writes.length, writes);
  assert.equal(m.issues.length, 1);
  assert.equal(m.latest().status, "pending");
  assert.match(m.issues[0].body, /gh-aw-workflow-id: repo-assist-issue-triage/);
  assert.match(m.issues[0].body, /Generated by/);
  assert.match(m.comments.get(1)[0].body, /original agent output and review bundles/);
  const many = Array.from({ length: 125 }, (_, index) => ({ ...proposal, title: `Entry ${index}`, body: `<!-- cao-finding-key: entry-${index} -->` }));
  await publishInbox(m.api, scope, many);
  assert.match(m.issues[0].body, /Showing at most 40 of 126 actionable findings \(126 total\)/);
  assert.ok(m.issues[0].body.length < 20000);
  assert.equal(m.comments.get(1).length, 126);
  const after = m.writes.length;
  await publishInbox(m.api, scope, []);
  assert.equal(m.writes.length, after, "all comment pages participate in checkpoint validation");
});

test("terminal history never crowds pending or accepted summary rows; titles are bounded and inert", async () => {
  const m = mock();
  const terminal = Array.from({ length: 45 }, (_, index) => ({
    ...proposal, type: "close_issue", title: `Terminal ${index}`,
    body: `<!-- cao-finding-key: terminal-${index} -->`,
  }));
  await publishInbox(m.api, scope, terminal);
  assert.match(m.issues[0].body, /No actionable findings/);
  const title = "@writer | [unsafe](https://evil.test) " + "x".repeat(150);
  const accepted = { ...proposal, title };
  await publishInbox(m.api, scope, [accepted]);
  m.human(`/cao-review ${m.latest().id} accepted`);
  await publishInbox(m.api, scope, []);
  const pending = { ...proposal, title: "Fix urgent parser", body: "<!-- cao-finding-key: urgent -->" };
  await publishInbox(m.api, scope, [pending]);
  const rows = m.issues[0].body.split("\n").filter((line) => line.startsWith("| `"));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /pending/);
  assert.match(rows[1], /accepted/);
  assert.ok(rows[0].includes(inert("Fix urgent parser")));
  assert.ok(rows[1].includes(inert(title.slice(0, 80) + "…")));
  assert.doesNotMatch(rows.join("\n"), /Terminal|@writer|https:\/\/evil/);
  assert.match(m.issues[0].body, /resolved: 45/);
  assert.match(m.issues[0].body, /2 actionable findings \(47 total\)/);
  assert.equal(m.comments.get(1).filter(({ user }) => user.type === "Bot").length, 48);
});

for (const status of ["accepted", "rejected", "superseded", "pending"]) {
  test(`model close proposals cannot override a writer's ${status} decision`, async () => {
    const m = mock();
    await publishInbox(m.api, scope, [proposal]);
    const decision = m.human(`/cao-review ${m.latest().id} ${status}`);
    await publishInbox(m.api, scope, []);
    await publishInbox(m.api, scope, [{ ...proposal, type: "close_issue" }]);
    assert.equal(m.latest().status, status);
    assert.equal(m.latest().decision, decision.id);
    const writes = m.writes.length;
    await publishInbox(m.api, scope, [{ ...proposal, type: "close_issue" }]);
    assert.equal(m.writes.length, writes);
    m.human(`/cao-review ${m.latest().id} resolved`);
    await publishInbox(m.api, scope, []);
    assert.equal(m.latest().status, "resolved");
  });
}

test("material records expose stable firstSeen, updatedAt and source decision dates without rerun writes", async () => {
  const m = mock();
  let date = "2026-10-03T00:00:00.000Z";
  const options = { now: () => date };
  await publishInbox(m.api, scope, [proposal], options);
  assert.equal(m.latest().firstSeen, date);
  assert.equal(m.latest().updatedAt, date);
  date = "2026-10-04T00:00:00.000Z";
  const revised = { ...proposal, body: proposal.body + "\nRevision" };
  await publishInbox(m.api, scope, [revised], options);
  assert.equal(m.latest().firstSeen, "2026-10-03T00:00:00.000Z");
  assert.equal(m.latest().updatedAt, date);
  const writes = m.writes.length;
  date = "2026-10-05T00:00:00.000Z";
  await publishInbox(m.api, scope, [revised], options);
  assert.equal(m.writes.length, writes);
  assert.equal(m.latest().updatedAt, "2026-10-04T00:00:00.000Z");
  const decision = m.human(`/cao-review ${m.latest().id} accepted`);
  decision.updated_at = "2026-10-02T01:00:00Z";
  await publishInbox(m.api, scope, [], options);
  assert.equal(m.latest().firstSeen, "2026-10-03T00:00:00.000Z");
  assert.equal(m.latest().updatedAt, date);
  assert.equal(m.latest().decisionAt, decision.updated_at);
  assert.match(m.comments.get(1).at(-1).body, new RegExp(inert(decision.updated_at)));
  date = "2026-10-06T00:00:00.000Z";
  await publishInbox(m.api, scope, [{ ...revised, type: "close_issue" }], options);
  assert.equal(m.latest().decisionAt, decision.updated_at);
  const later = m.human(`/cao-review ${m.latest().id} rejected`);
  await publishInbox(m.api, scope, [], options);
  assert.equal(m.latest().decisionAt, later.created_at);
  const after = m.writes.length;
  await publishInbox(m.api, scope, [], options);
  assert.equal(m.writes.length, after);
});

test("human edits to a different campaign inbox do not block this campaign", async () => {
  const m = mock();
  await publishInbox(m.api, { ...scope, campaign: "other-campaign" }, [proposal]);
  m.issues[0].body += "\nHuman edit";
  await publishInbox(m.api, scope, [proposal]);
  assert.equal(m.issues.length, 2);
  const writes = m.writes.length;
  await publishInbox(m.api, scope, [proposal]);
  assert.equal(m.writes.length, writes);
  m.issues[1].body += "\nHuman edit";
  await assert.rejects(publishInbox(m.api, scope, [proposal]), /human-edited/);
  assert.equal(m.writes.length, writes);
});

for (const operation of ["create", "comment", "update"]) {
  test(`retry recovers a crash after ${operation} without duplicates`, async () => {
    const m = mock();
    m.crash(operation);
    await assert.rejects(publishInbox(m.api, scope, [proposal]), /crash/);
    await publishInbox(m.api, scope, [proposal]);
    assert.equal(m.issues.length, 1);
    assert.equal(m.comments.get(1).length, 1);
    const writes = m.writes.length;
    await publishInbox(m.api, scope, [proposal]);
    assert.equal(m.writes.length, writes);
  });
}

test("queued publishers merge targets/workers and independently retain all entries", async () => {
  const m = mock();
  // Model the native job's serialization, with overlapping callers in one control repo.
  let queue = Promise.resolve();
  const queued = (targetScope) => {
    queue = queue.then(() => publishInbox(m.api, targetScope, [proposal]));
    return queue;
  };
  await Promise.all([queued(scope), queued({ ...scope, target: "acme/other" }),
    queued({ ...scope, worker: "maintenance" }), queued(scope)]);
  assert.equal(m.issues.length, 1);
  assert.equal(m.comments.get(1).length, 3);
  assert.match(m.issues[0].body, /pending: 3/);
});

test("writer decisions persist across reruns and revisions, never edit human comments or grant live", async () => {
  const m = mock();
  await publishInbox(m.api, scope, [proposal]);
  const id = m.latest().id;
  const denied = m.human(`/cao-review ${id} accepted`, "reader");
  await publishInbox(m.api, scope, []);
  assert.equal(m.latest().status, "pending");
  const decision = m.human(`/cao-review ${id} accepted`);
  await publishInbox(m.api, scope, []);
  assert.equal(m.latest().status, "accepted");
  assert.equal(m.latest().decision, decision.id);
  await publishInbox(m.api, scope, [{ ...proposal, body: proposal.body + "\nNew evidence." }]);
  assert.equal(m.latest().status, "accepted");
  assert.equal(decision.body, `/cao-review ${id} accepted`);
  assert.equal(denied.body, `/cao-review ${id} accepted`);
  for (const status of ["rejected", "resolved", "superseded", "pending"]) {
    m.human(`/cao-review ${id} ${status}`);
    await publishInbox(m.api, scope, []);
    assert.equal(m.latest().status, status);
  }
  assert.ok(m.writes.every(([kind, input]) => kind !== "update" || Object.keys(input).sort().join() === "body,issue_number,owner,repo"));
});

test("explicit resolution changes the same finding instead of closing inbox or legacy issues", async () => {
  const m = mock();
  await publishInbox(m.api, scope, [proposal]);
  await publishInbox(m.api, scope, [{ ...proposal, type: "close_issue" }]);
  assert.equal(m.latest().status, "resolved");
  assert.equal(m.issues[0].state, "open");
  assert.equal(m.issues.length, 1);
});

test("staged mode previews without creating or changing inbox or decisions", async () => {
  const m = mock();
  assert.equal((await publishInbox(m.api, scope, [proposal], { staged: true })).staged, true);
  assert.equal(m.writes.length, 0);
  await publishInbox(m.api, scope, [proposal]);
  m.human(`/cao-review ${m.latest().id} accepted`);
  const count = m.writes.length;
  await publishInbox(m.api, scope, [], { staged: true });
  assert.equal(m.writes.length, count);
  assert.equal(m.latest().status, "pending");
});

test("permission lookup and pagination failures propagate instead of empty discovery", async () => {
  const m = mock();
  for (let index = 0; index < 101; index += 1) m.issues.push({ number: 1000 + index, title: "Unrelated" });
  m.failPage(2);
  await assert.rejects(publishInbox(m.api, scope, [proposal]), /pagination/);
  assert.equal(m.writes.length, 0);
  m.failPage(0);
  await publishInbox(m.api, scope, [proposal]);
  const inbox = m.issues.at(-1);
  const id = m.latest().id;
  m.permissions.set("writer", "error");
  m.human(`/cao-review ${id} accepted`, "writer", inbox.number);
  await assert.rejects(publishInbox(m.api, scope, []), /permission API/);
});

test("invalid, missing, corrupt or human-owned state fails closed", async () => {
  for (const damage of ["body", "record", "missing-record", "missing-state", "human-owner", "duplicate-inbox"]) {
    const m = mock();
    await publishInbox(m.api, scope, [proposal]);
    if (damage === "body") m.issues[0].body += "\nHuman text";
    if (damage === "record") m.comments.get(1)[0].body += "\nCorrupt";
    if (damage === "missing-record") m.comments.set(1, []);
    if (damage === "missing-state") m.issues[0].body = "";
    if (damage === "human-owner") m.issues[0].user = { type: "User", login: "writer" };
    if (damage === "duplicate-inbox") m.issues.push({ ...m.issues[0], number: 900 });
    const writes = m.writes.length;
    await assert.rejects(publishInbox(m.api, scope, [proposal]));
    assert.equal(m.writes.length, writes, damage);
  }
});

test("migration requires exact labels/provenance/target and preserves original discussion", async () => {
  const m = mock();
  const legacy = {
    number: 900, user: bot, title: proposal.title,
    body: `${proposal.body}\n<!-- gh-aw-workflow-id: ${scope.workflow} -->`,
    labels: [{ name: scope.campaign }, { name: `${scope.campaign}:${scope.worker}` }],
  };
  m.issues.push(legacy);
  m.comments.set(900, []);
  const decision = m.human("/cao-review rejected", "writer", 900);
  const original = structuredClone(legacy);
  await publishInbox(m.api, scope, []);
  assert.deepEqual(legacy, original);
  assert.equal(decision.body, "/cao-review rejected");
  assert.equal(m.latest().legacy, 900);
  assert.equal(m.latest().status, "rejected");
  assert.match(m.comments.get(m.issues.at(-1).number)[0].body, /Original review issue and human discussion/);
  const writes = m.writes.length;
  await publishInbox(m.api, scope, []);
  assert.equal(m.writes.length, writes);
  const beforeResolution = m.comments.get(m.issues.at(-1).number).length;
  await publishInbox(m.api, scope, [{ type: "close_issue", issue_number: 900, repo: scope.destination, body: "Verified resolution" }]);
  assert.equal(m.latest().id, normalizeFinding(proposal, scope).id, "legacy updates retain original finding identity");
  assert.equal(m.latest().status, "rejected", "legacy human decisions survive model resolution");
  assert.equal(m.comments.get(m.issues.at(-1).number).length, beforeResolution + 1);
  assert.deepEqual(legacy, original);
  const unsafe = mock();
  unsafe.issues.push({ ...legacy, labels: [{ name: scope.campaign }] });
  await publishInbox(unsafe.api, scope, []);
  assert.equal(unsafe.writes.length, 0);
});

test("all untrusted body content is inert, provenance and evidence links remain trusted", async () => {
  const text = "@writer acme/target#42 https://github.com/acme/target/issues/42 [target](https://github.com/acme/target/issues/42) <a href='https://evil.test'>x</a>";
  const m = mock();
  await publishInbox(m.api, scope, [{ ...proposal, body: `${proposal.body}\n${text}` }]);
  const body = m.comments.get(1)[0].body;
  assert.ok(body.includes(inert(text)));
  assert.doesNotMatch(body, /@writer|target#42|https:\/\/github.com\/acme\/target|https:\/\/evil.test/);
  assert.match(body, /https:\/\/github.com\/acme\/control\/actions\/runs\/123/);
});

test("handoff validation binds exact control SHA, role, mode, campaign, worker, target and review repo", () => {
  const handoff = { authorized: true, control_role: "worker", campaign: scope.campaign,
    worker: scope.worker, target_repo: scope.target, safe_output_repo: scope.destination,
    safe_output_mode: "review", policy_source: { repository: scope.control, sha: scope.sha } };
  validateHandoff(handoff, scope);
  for (const field of ["authorized", "control_role", "campaign", "worker", "target_repo", "safe_output_repo", "safe_output_mode"]) {
    assert.throws(() => validateHandoff({ ...handoff, [field]: "bad" }, scope));
  }
  assert.throws(() => validateHandoff({ ...handoff, policy_source: { repository: scope.control, sha: "b".repeat(40) } }, scope), /SHA/);
  assert.throws(() => validateHandoff({ ...handoff, safe_output_repo: scope.target }, { ...scope, destination: scope.target }), /destination/);
});

test("live and orchestrator runtime paths remain untouched, workflow refs include slash-containing refs", async () => {
  await runInbox({}, "intercept", { CAO_ROLE: "worker", CAO_MODE: "live" });
  await runInbox({}, "publish", { CAO_ROLE: "orchestrator", CAO_MODE: "review" });
  assert.equal(runtimeScope({ GITHUB_WORKFLOW_REF: "acme/control/.github/workflows/triage.lock.yml@refs/heads/feature/test" }).workflow, "triage");
});

test("adapter preserves declared primitive/count bounds and dispatched repository reach", () => {
  validateFindings([proposal], scope, { create_issue: 1 });
  assert.throws(() => validateFindings([proposal, proposal], scope, { create_issue: 1 }), /excessive/);
  assert.throws(() => validateFindings([{ type: "add_comment", issue_number: 1, body: "text" }], scope, { create_issue: 1 }), /undeclared/);
  assert.throws(() => validateFindings([{ ...proposal, repo: "other/untrusted" }], scope, { create_issue: 1 }), /scope/);
  assert.throws(() => validateFindings([proposal], scope, null), /limits/);
});

test("runtime intercepts only findings, publishes original evidence, honors staged flag, and rejects bad prerequisites", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cao-review-runtime-"));
  const paths = { handoff: join(directory, "handoff.json"), ready: join(directory, "ready.json") };
  const output = join(directory, "agent_output.json");
  const env = {
    CAO_ROLE: "worker", CAO_MODE: "review", CAO_CAMPAIGN: scope.campaign, CAO_WORKER: scope.worker,
    CAO_TARGET_REPOSITORY: scope.target, CAO_SAFE_OUTPUT_REPOSITORY: scope.destination,
    GITHUB_REPOSITORY: scope.control, GITHUB_WORKFLOW_SHA: scope.sha, GITHUB_RUN_ID: scope.runId,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW_REF: `${scope.control}/.github/workflows/${scope.workflow}.lock.yml@refs/heads/main`,
    GH_AW_AGENT_OUTPUT: output, CAO_REVIEW_FINDING_LIMITS: '{"create_issue":1}',
  };
  const handoff = { authorized: true, control_role: "worker", campaign: scope.campaign, worker: scope.worker,
    target_repo: scope.target, safe_output_repo: scope.destination, safe_output_mode: "review",
    policy_source: { repository: scope.control, sha: scope.sha } };
  const originals = JSON.stringify({ items: [proposal, { type: "publish_review_bundle", bundle_name: "evidence" },
    { type: "dispatch_workflow", workflow: "existing" }, { type: "noop", message: "existing" }] });
  const outputs = new Map();
  const core = {
    setOutput: (name, value) => outputs.set(name, value),
    summary: { addHeading() { return this; }, addRaw() { return this; }, async write() {} },
  };
  const m = mock();
  try {
    writeFileSync(paths.handoff, JSON.stringify(handoff));
    writeFileSync(output, originals);
    await runInbox({ github: m.api, core }, "intercept", { ...env, GH_AW_SAFE_OUTPUTS_STAGED: "true" }, paths);
    assert.equal(JSON.parse(readFileSync(paths.ready, "utf8")).digest,
      createHash("sha256").update(originals).digest("hex"), "ready digest binds the raw restored artifact bytes");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).items.map(({ type }) => type),
      ["publish_review_bundle", "dispatch_workflow", "noop"]);
    assert.equal(outputs.get("review_inbox_staged"), "true");
    await assert.rejects(runInbox({ github: m.api, core }, "publish", env, paths), /artifact mismatch/);
    writeFileSync(output, originals);
    await runInbox({ github: m.api, core }, "publish", env, paths);
    assert.equal(m.writes.length, 0);
    await runInbox({ github: m.api, core }, "intercept", env, paths);
    writeFileSync(output, originals);
    await runInbox({ github: m.api, core }, "publish", env, paths);
    assert.equal(m.issues.length, 1);
    rmSync(paths.ready);
    await assert.rejects(runInbox({ github: m.api, core }, "publish", env, paths));
    writeFileSync(output, '{"items":null}');
    await assert.rejects(runInbox({ github: m.api, core }, "intercept", env, paths), /invalid/);
    writeFileSync(output, originals);
    writeFileSync(paths.handoff, JSON.stringify({ ...handoff, authorized: false }));
    await assert.rejects(runInbox({ github: m.api, core }, "intercept", env, paths), /unauthorized/);
    assert.equal(readFileSync(output, "utf8"), originals, "invalid prerequisites must not suppress findings");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
