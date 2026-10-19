#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateLifetime, readLifetime } from "./measure-file-diet-lifetime.mjs";
import { requireArgs, writeJson } from "../.github/skills/add-operational-value/scripts/common.mjs";

export function fileDietValueEvents(proof, inventories) {
  const report = evaluateLifetime(proof, inventories);
  const pulls = new Map(proof.pulls.map(pull => [pull.number, pull]));
  const root = `https://github.com/${proof.repository}`;
  const events = report.deliveries.filter(delivery => delivery.issues.length > 0).map(delivery => {
    const pull = pulls.get(delivery.number);
    return { id: pull.id, at: delivery.mergedAt, value: delivery.oversized800Reduction,
      attribution: delivery.receiptVerifiedIssues.length ? "receipt-verified" : "corroborated",
      label: `${proof.repository}#${delivery.number}`,
      detail: `${delivery.targets.map(target => `${target.path}: ${target.before} -> ${target.after} lines`
        + (target.newFiles.length ? `; added ${target.newFiles.map(file => `${file.path} (${file.lines})`).join(", ")}` : "")).join(". ")}. `
        + "Net change includes replacement oversized files. Behavior preservation and full acceptance remain unverified. Shared workflow-enabled contribution.",
      evidence: [
        { label: "Merged PR", url: `${root}/pull/${delivery.number}` },
        { label: "Before revision", url: `${root}/tree/${pull.preMergeSha}` },
        { label: "Merge revision", url: `${root}/tree/${pull.mergeSha}` },
        ...delivery.issues.map(number => ({ label: `Origin issue #${number}`, url: `${root}/issues/${number}` })),
      ] };
  });
  const window = { startAt: proof.adoption.at, endAt: proof.until };
  return { schemaVersion: 1, kind: "operational-value-events",
    repository: proof.repository, workflowSlug: "daily-file-diet", workflowName: "Daily File Diet",
    sourcePath: proof.sourcePath, observedAt: proof.observedAt, cadenceDays: 1,
    metric: { id: "oversized-files-reduced", name: "Workflow-enabled oversized-file reductions",
      unit: "files", direction: "increase", version: "observed-800-line-net-reductions-v1" },
    basis: "workflow-contribution", window, coverage: [{ ...window, status: "complete" }],
    opportunities: report.periods.at(-1).oversized800, events,
    limitations: [
      "Coverage is the surviving discovered File Diet issue cohort and its explicit merge links, not unknowable deleted outputs or an exclusive causal effect.",
      "48 net 800+ file reductions are demonstrated; 13 have creation receipts. Missing receipts do not erase the other corroborated contributions.",
      "Full behavior preservation, required coverage and all-new-files-under-500 acceptance remain unverified; this measures structural progress.",
      `The repository still has ${report.periods.at(-1).oversized800} oversized files. Growth by other actors is not attributed to this workflow.`,
    ] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  requireArgs(args, 2, 2, "build-file-diet-value-events.mjs <proof-directory> <events.json>");
  const { proof, inventories } = readLifetime(args[0]);
  mkdirSync(path.dirname(path.resolve(args[1])), { recursive: true });
  writeFileSync(args[1], writeJson(fileDietValueEvents(proof, inventories)));
  console.log(`wrote ${args[1]}`);
}
