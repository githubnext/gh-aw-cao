import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Docker installs dashboard build dependencies without test tooling or install scripts", () => {
  const manifest = JSON.parse(readFileSync(new URL("dashboard/site/package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("dashboard/site/package-lock.json", root), "utf8"));
  const dockerfile = readFileSync(new URL("server/Dockerfile", root), "utf8");

  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["esbuild", "yaml"]);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  for (const name of ["esbuild", "yaml"]) {
    assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
  }
  for (const name of ["vitest", "vite", "postcss", "@jridgewell/gen-mapping"]) {
    assert.equal(lock.packages[`node_modules/${name}`].dev, true);
  }
  assert.equal(lock.packages["packages/source-map-compat"].dev, true);
  assert.match(dockerfile, /npm --prefix dashboard\/site ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /COPY dashboard\/site\/packages\/source-map-compat/);
});
