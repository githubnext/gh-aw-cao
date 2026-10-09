import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Docker installs dashboard build dependencies without test tooling or install scripts", () => {
  const manifest = JSON.parse(readFileSync(new URL("dashboard/site/package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("dashboard/site/package-lock.json", root), "utf8"));
  const dockerfile = readFileSync(new URL("server/Dockerfile", root), "utf8");

  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["esbuild", "yaml"]);
  assert.ok(!Object.hasOwn(manifest.devDependencies, "rollup"));
  assert.ok(!Object.hasOwn(lock.packages, "node_modules/rollup"));
  assert.ok(!Object.keys(lock.packages).some((name) => name.startsWith("node_modules/@rollup/")));
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

test("dashboard build uses esbuild without a Rollup repacking pass", () => {
  const source = readFileSync(new URL("dashboard/site/scripts/build.mjs", root), "utf8");
  assert.match(source, /import \{ build, transform \} from "esbuild"/);
  assert.doesNotMatch(source, /\brollup\b/i);
  assert.doesNotMatch(source, /\.bundle-client/);
});
