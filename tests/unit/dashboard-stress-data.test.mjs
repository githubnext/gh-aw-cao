import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateDashboardStressData } from "../helpers/dashboard-stress-data.mjs";

test("stress shards are deterministic and parametric", async () => {
  const root = await mkdtemp(join(tmpdir(), "cao-dashboard-stress-"));
  const first = join(root, "first");
  const second = join(root, "second");
  try {
    const options = {
      repositories: 4,
      runs: 8,
      derivedEventsPerRun: 7,
      shards: 3,
      workflows: 2,
    };
    const firstManifest = await generateDashboardStressData({ ...options, outputDirectory: first });
    const secondManifest = await generateDashboardStressData({ ...options, outputDirectory: second });
    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(firstManifest.expected, {
      repositories: 4,
      runs: 8,
      audits: 56,
    });
    assert.equal(firstManifest.files.length, 3);
    for (const file of firstManifest.files) {
      assert.equal(
        await readFile(join(first, file.name), "utf8"),
        await readFile(join(second, file.name), "utf8"),
      );
    }
    await generateDashboardStressData({ ...options, outputDirectory: first, shards: 1 });
    assert.equal((await readdir(first)).filter((name) => name.endsWith(".jsonl")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stress shards preserve observed operational shapes without copying identities", async () => {
      const root = await mkdtemp(join(tmpdir(), "cao-dashboard-stress-profile-"));
      const sampleDirectory = join(root, "samples");
      const outputDirectory = join(root, "output");
      await mkdir(sampleDirectory);
      const samples = [
        {
          schema_version: 2,
          kind: "run",
          run: {
            run_id: 41,
            run_attempt: 1,
            organization: "real-owner",
            repository: "real-owner/private-repository",
            workflow_name: "Observed workflow",
            workflow_path: ".github/workflows/observed.md",
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-01T00:02:00Z",
            engine: "observed-engine",
            model: "observed-model-a",
            token_usage_summary: { total_aic: 2.5, input_tokens: 4_000, output_tokens: 500 },
            working_set: { files: 12, bytes: 65_536 },
            job_details: [{ id: 91, name: "observed-agent-job" }],
            audit: { missing_tools: [{ tool: "real-tool", status: "missing" }] },
          },
        },
        {
          schema_version: 2,
          kind: "run",
          run: {
            run_id: 42,
            run_attempt: 1,
            organization: "real-owner",
            repository: "real-owner/other-repository",
            workflow_name: "Other workflow",
            workflow_path: ".github/workflows/other.md",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-01T00:05:00Z",
            engine_id: "other-engine",
            resolved_model: "observed-model-b",
            audit: { recommendations: [{ action: "real recommendation", priority: "high" }] },
          },
        },
      ];
      await writeFile(
        join(sampleDirectory, "observed.jsonl"),
        `${samples.map(JSON.stringify).join("\n")}\n`,
      );
      try {
        const manifest = await generateDashboardStressData({
          outputDirectory,
          samplePath: sampleDirectory,
          repositories: 2,
          runs: 4,
          derivedEventsPerRun: 7,
          shards: 2,
          workflows: 2,
        });
        assert.deepEqual(manifest.sampleProfile.conclusions, { failure: 1, success: 1 });
        assert.deepEqual(manifest.sampleProfile.fieldPresence, {
          jobs: 1,
          tokenUsage: 1,
          workingSet: 1,
          audit: 2,
        });
        assert.deepEqual(manifest.sampleProfile.durationSeconds, { minimum: 120, maximum: 300, mean: 210 });
        assert.deepEqual(Object.values(manifest.sampleProfile.engines).sort(), [1, 1]);
        assert.deepEqual(Object.values(manifest.sampleProfile.models).sort(), [1, 1]);
        assert.ok(Object.keys(manifest.sampleProfile.engines).every((name) => /^engine-\d{2}$/.test(name)));
        assert.ok(Object.keys(manifest.sampleProfile.models).every((name) => /^model-\d{2}$/.test(name)));
        const generated = (await Promise.all(manifest.files.map(async ({ name }) =>
          (await readFile(join(outputDirectory, name), "utf8")).trim().split("\n").map(JSON.parse)
        ))).flat();
        assert.equal(new Set(generated.map(({ run }) => run.model)).size, 2);
        assert.ok(generated.every(({ run }) => /^model-\d{2}$/.test(run.model)));
        assert.deepEqual(generated.map(({ run }) => run.job_details[0].name), [
          "agent",
          "job",
          "agent",
          "job",
        ]);
        assert.equal(JSON.stringify(generated).includes("real-owner"), false);
        assert.equal(JSON.stringify(generated).includes("real recommendation"), false);
        assert.equal(JSON.stringify(generated).includes("real-tool"), false);
        assert.equal(JSON.stringify(generated).includes("observed-model"), false);
        assert.equal(JSON.stringify(generated).includes("observed-engine"), false);
        assert.equal(manifest.sample, "schema-v2-run-data");
        await assert.rejects(
          generateDashboardStressData({
            outputDirectory: join(root, "too-many-events"),
            samplePath: sampleDirectory,
            repositories: 1,
            runs: 1,
            derivedEventsPerRun: 101,
            shards: 1,
            workflows: 1,
          }),
          /derivedEventsPerRun must be at most 100/,
        );
        await assert.rejects(
          generateDashboardStressData({
            outputDirectory: join(root, "too-many-workflows"),
            samplePath: sampleDirectory,
            repositories: 1,
            runs: 1,
            workflows: 2,
          }),
          /workflows cannot exceed runs/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
});

test("stress sampling is deterministic across reordered real-data shards", async () => {
      const root = await mkdtemp(join(tmpdir(), "cao-dashboard-stress-sampling-"));
      const firstSample = join(root, "first", "sample.jsonl");
      const secondSample = join(root, "second", "sample.jsonl");
      const records = Array.from({ length: 300 }, (_, index) => ({
        schema_version: 2,
        kind: "run",
        run: {
          run_id: index,
          organization: "observed",
          repository: `observed/repository-${index}`,
          workflow_name: "Observed",
          workflow_path: ".github/workflows/observed.md",
          conclusion: index % 3 === 0 ? "cancelled" : "success",
          started_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-01T00:01:00Z",
          model: `model-${index % 4}`,
        },
      }));
      await mkdir(join(root, "first"));
      await mkdir(join(root, "second"));
      await writeFile(firstSample, `${records.map(JSON.stringify).join("\n")}\n`);
      await writeFile(secondSample, `${records.toReversed().map(JSON.stringify).join("\n")}\n`);
      try {
        const options = {
          repositories: 4,
          runs: 8,
          derivedEventsPerRun: 6,
          shards: 2,
          workflows: 2,
        };
        const first = await generateDashboardStressData({
          ...options,
          outputDirectory: join(root, "first-output"),
          samplePath: firstSample,
        });
        const second = await generateDashboardStressData({
          ...options,
          outputDirectory: join(root, "second-output"),
          samplePath: secondSample,
        });
        assert.deepEqual(first.sampleProfile, second.sampleProfile);
        assert.equal(first.sampleProfile.sourceRuns, 300);
        assert.equal(first.sampleProfile.retainedTemplates, 256);
        assert.deepEqual(
          first.files.map(({ sha256 }) => sha256),
          second.files.map(({ sha256 }) => sha256),
        );
        assert.equal(
          await readFile(join(root, "first-output", "manifest.json"), "utf8"),
          await readFile(join(root, "second-output", "manifest.json"), "utf8"),
        );
        const generated = (await readFile(join(root, "first-output", first.files[0].name), "utf8"))
          .trim().split("\n").map(JSON.parse);
        assert.ok(generated.some(({ run }) => run.conclusion === "cancelled"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
});
