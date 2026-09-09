import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const checker = path.resolve("scripts/check-svg-visual-language.mjs");

function withFixtures(files, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "central-ops-svg-"));
  try {
    const paths = Object.entries(files).map(([name, content]) => {
      const filePath = path.join(directory, name);
      writeFileSync(filePath, content);
      return filePath;
    });
    callback(paths);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runChecker(paths) {
  return spawnSync(process.execPath, [checker], {
    encoding: "utf8",
    env: { ...process.env, SVG_FILES: paths.join(" ") },
  });
}

test("accepts accessible paired diagrams with semantic metadata", () => {
  const svg = (
    theme,
  ) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" role="img" aria-labelledby="title description" data-visual-kind="diagram" data-visual-id="flow">
    <title id="title">Flow</title><desc id="description">A bounded flow.</desc>
    <g data-node="step"><rect fill="${theme === "light" ? "#ffffff" : "#101411"}"/><text font-size="16">Step</text></g>
  </svg>`;

  withFixtures({ "flow-light.svg": svg("light"), "flow-dark.svg": svg("dark") }, (paths) => {
    const result = runChecker(paths);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("rejects incomplete metadata, gradients, and undersized labels", () => {
  const invalid = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" role="img" aria-label="Flow" data-visual-kind="diagram" data-visual-id="flow">
    <defs><linearGradient id="fade"><stop offset="0"/></linearGradient></defs>
    <text font-size="12">Tiny label</text>
  </svg>`;
  const validCounterpart = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" role="img" aria-label="Flow" data-visual-kind="diagram" data-visual-id="flow"><g data-node="step"/></svg>`;

  withFixtures({ "flow-light.svg": invalid, "flow-dark.svg": validCounterpart }, (paths) => {
    const result = runChecker(paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no data-node/);
    assert.match(result.stderr, /uses a gradient/);
    assert.match(result.stderr, /require at least 16px/);
  });
});

test("rejects missing theme counterparts and incorrect state colors", () => {
  const invalid = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" role="img" aria-label="Status" data-visual-kind="diagram" data-visual-id="status">
    <g data-node="status"><rect data-state="success" fill="#f85149"/></g>
  </svg>`;

  withFixtures({ "status-dark.svg": invalid }, (paths) => {
    const result = runChecker(paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing theme counterpart/);
    assert.match(result.stderr, /must use #3fb950 in dark mode/);
  });
});
