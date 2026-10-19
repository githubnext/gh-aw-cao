import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Docker installs dashboard build dependencies without test tooling or install scripts", () => {
  const manifest = JSON.parse(readFileSync(new URL("dashboard/site/package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("dashboard/site/package-lock.json", root), "utf8"));
  const dockerfile = readFileSync(new URL("server/Dockerfile", root), "utf8");

  const buildDependencies = ["@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/xterm", "esbuild", "strip-ansi", "yaml"];
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), buildDependencies);
  assert.ok(!Object.hasOwn(manifest.devDependencies, "rollup"));
  assert.ok(!Object.hasOwn(lock.packages, "node_modules/rollup"));
  assert.ok(!Object.keys(lock.packages).some((name) => name.startsWith("node_modules/@rollup/")));
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  for (const name of buildDependencies) {
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

test("Docker Go stage preserves both module roots and native embedded resources", () => {
  const dockerfile = readFileSync(new URL("server/Dockerfile", root), "utf8");
  const stage = dockerfile.split(/(?=^FROM )/m).find((section) => section.includes(" AS server-build"));
  assert.match(stage, /WORKDIR \/workspace\/server/);
  assert.match(stage, /COPY go\.mod go\.sum \.\.\//);
  assert.match(stage, /COPY server\/go\.mod server\/go\.sum \.\//);
  assert.match(stage, /COPY server\/ \.\//);
  assert.match(stage, /COPY operator_assets\.go \.\.\//);
  assert.match(stage, /COPY dashboard\/ \.\.\/dashboard\//);
  for (const source of ["server/internal/localpreview/workspace.go", "dashboard/queryengine/api.go"]) {
    assert.ok(readFileSync(new URL(source, root)));
  }
  const rootModule = readFileSync(new URL("go.mod", root), "utf8");
  const serverModule = readFileSync(new URL("server/go.mod", root), "utf8");
  assert.match(rootModule, /replace github\.com\/githubnext\/gh-aw-cao\/server => \.\/server/);
  assert.match(serverModule, /replace github\.com\/githubnext\/gh-aw-cao => \.\./);
  const embedded = readFileSync(new URL("operator_assets.go", root), "utf8");
  const resources = embedded.split("\n").find((line) => line.startsWith("//go:embed ")).slice("//go:embed ".length).split(" ");
  for (const resource of resources) {
    const copies = [...stage.matchAll(/^COPY (\S+) (\S+)$/gm)];
    assert.ok(copies.some(([, source, destination]) => {
      if (source.endsWith("/")) return resource.startsWith(source) && destination === `../${source}`;
      return source === resource && destination === `../${resource}`;
    }), `Go stage is missing embedded resource ${resource}`);
  }
  const ignored = readFileSync(new URL(".dockerignore", root), "utf8");
  assert.match(ignored, /^!docs\/dashboard-language-specification\.md$/m);
});
