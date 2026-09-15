import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      jobs: 8,
      sessions: 8,
      events: 56,
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
        assert.deepEqual(manifest.sampleProfile, {
          sourceRuns: 2,
          retainedTemplates: 2,
          conclusions: { success: 1, failure: 1 },
          engines: { "observed-engine": 1, "other-engine": 1 },
          models: { "observed-model-a": 1, "observed-model-b": 1 },
          fieldPresence: { jobs: 1, tokenUsage: 1, workingSet: 1, audit: 2 },
          durationSeconds: { minimum: 120, maximum: 300, mean: 210 },
        });
        const generated = (await Promise.all(manifest.files.map(async ({ name }) =>
          (await readFile(join(outputDirectory, name), "utf8")).trim().split("\n").map(JSON.parse)
        ))).flat();
        assert.deepEqual(generated.map(({ run }) => run.model), [
          "observed-model-a",
          "observed-model-b",
          "observed-model-a",
          "observed-model-b",
        ]);
        assert.deepEqual(generated.map(({ run }) => run.job_details[0].name), [
          "observed-agent-job",
          "agent",
          "observed-agent-job",
          "agent",
        ]);
        assert.equal(JSON.stringify(generated).includes("real-owner"), false);
        assert.equal(JSON.stringify(generated).includes("real recommendation"), false);
        assert.equal(JSON.stringify(generated).includes("real-tool"), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    assert.equal(firstManifest.files.length, 3);
    for (const file of firstManifest.files) {
      assert.equal(
        await readFile(join(first, file.name), "utf8"),
        await readFile(join(second, file.name), "utf8"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
