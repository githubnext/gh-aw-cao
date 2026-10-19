import { createHash } from "node:crypto";
import { censusDigest } from "./operational-value-census-io.mjs";
import { multiPrFilename, multiPrHostProjection, multiPrOperations, multiPrPatchPayload } from "./native-smoke-multi-pr-value.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function multiPrFixtureObject(type, bytes) {
  const content = Buffer.from(bytes);
  return { id: createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex"),
    content: content.toString("base64") };
}
export function multiPrFixture(context, actualSource = null) {
  const profile = context.profiles.find(item => item.era === "crlf");
  const source = actualSource ?? { checkout: "1".repeat(40), workflowGitBlob: profile.workflowGitBlob,
    taskSha256: profile.taskSha256, compiledGitBlob: "2".repeat(40),
    jobSha256: "3".repeat(64), runtime: [], actionGitBlob: "4".repeat(40) };
  const hostProfileSha256 = censusDigest(source);
  const artifactProducer = context.artifactProducers?.[hostProfileSha256] ?? {
    jobSha256: "7".repeat(64), uploadStepSha256: "8".repeat(64), jobName: "agent", stepName: "Upload agent artifacts",
  };
  const cases = ["doc", "crlf"].map((kind, i) => {
    const filename = multiPrFilename(1, kind), branch = `smoke-multi-pr-${kind}-1-${i + 1}`;
    const label = kind === "doc" ? "Documentation" : "CRLF", ending = kind === "crlf" ? "\r\n" : "\n";
    const content = Buffer.from([`${label} smoke test for multi-PR workflow`, "Run ID: 1",
      "Created at: 2026-10-16T12:00:30Z", `PR: ${i + 1} of 2`,
      ...(kind === "crlf" ? ["Line ending: CRLF (Windows-style \\r\\n)"] : []), ""].join(ending));
    const blob = multiPrFixtureObject("blob", content);
    const existing = Buffer.concat([Buffer.from("100644 README.md\0"), Buffer.from("a".repeat(40), "hex")]);
    const baseTree = multiPrFixtureObject("tree", existing);
    const headTree = multiPrFixtureObject("tree", Buffer.concat([existing, Buffer.from(`100644 ${filename}\0`), Buffer.from(blob.id, "hex")]));
    const commit = (tree, parent = null) => multiPrFixtureObject("commit",
      `tree ${tree.id}\n${parent ? `parent ${parent.id}\n` : ""}author Fixture <fixture@example.invalid> 1792152000 +0000\ncommitter Fixture <fixture@example.invalid> 1792152000 +0000\n\nFixture\n`);
    const base = commit(baseTree), head = commit(headTree, base);
    const count = content.toString().split("\n").length - 1;
    const patch = Buffer.from(`From ${"b".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: fixture\n\n`
      + `diff --git a/${filename} b/${filename}\nnew file mode 100644\nindex 0000000..${blob.id.slice(0, 7)}\n`
      + `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${count} @@\n`
      + content.toString().split("\n").slice(0, -1).map(line => `+${line}\n`).join("") + "-- \n2.50.1\n");
    const step = { name: "Process Safe Outputs", number: 11, status: "completed", conclusion: "success",
      started_at: "2026-10-16T12:01:00Z", completed_at: "2026-10-16T12:02:00Z" };
    const messages = ["Base branch for github/gh-aw: main",
      `pushSignedCommits: creating remote branch ${branch} at parent OID ${base.id}`,
      `pushSignedCommits: remote branch ${branch} created successfully`,
      `pushSignedCommits: calling createCommitOnBranch mutation (expectedHeadOid=${base.id})`,
      `pushSignedCommits: signed commit created: ${head.id}`,
      `Created pull request #${i + 1}: https://github.com/github/gh-aw/pull/${i + 1}`];
    const lines = multiPrHostProjection(messages.map((message, j) => `2026-10-16T12:01:${String(j).padStart(2, "0")}Z ${message}`).join("\n"), step);
    return { kind, source: { ...source, hostProfileSha256 },
      payload: { branch, runId: 1, artifactId: i + 1, archiveSha256: "c".repeat(64), providerDigest: `sha256:${"c".repeat(64)}`,
        producer: { ...artifactProducer, job: { id: 2, name: artifactProducer.jobName, run_id: 1, run_attempt: 1, head_sha: source.checkout },
          step: { name: artifactProducer.stepName, number: 20, status: "completed", conclusion: "success",
            started_at: "2026-10-16T12:00:40Z", completed_at: "2026-10-16T12:00:42Z" }, artifactCreatedAt: "2026-10-16T12:00:41Z" },
        patchBase64: patch.toString("base64"), patchSha256: hash(patch),
        appliedPayloadSha256: hash(content), nativeGitVersion: "git version 2.50.1" },
      operation: { jobId: 1, step, logSha256: "d".repeat(64), lines, number: i + 1, proof: multiPrOperations(lines)[0] },
      target: { base, head, baseTree, headTree, blob } };
  });
  return { context: { ...context, reviewedHosts: [...context.reviewedHosts, hostProfileSha256],
    artifactProducers: { ...context.artifactProducers, [hostProfileSha256]: artifactProducer } },
    evidence: { valid: true, observations: [{ run: { id: 1, headSha: source.checkout, attempt: 1,
      at: "2026-10-16T12:00:00Z" }, era: "crlf", cases }] } };
}

export function missedMultiPrFixture(evidence) {
  const missed = structuredClone(evidence), cases = missed.observations[0].cases;
  delete cases[0].target;
  const patch = Buffer.from(cases[1].payload.patchBase64, "base64").toString("utf8").replaceAll("\r", "");
  cases[1].payload.patchBase64 = Buffer.from(patch).toString("base64");
  cases[1].payload.patchSha256 = hash(patch);
  cases[1].payload.appliedPayloadSha256 = hash(multiPrPatchPayload(Buffer.from(patch), multiPrFilename(1, "crlf")));
  return missed;
}
