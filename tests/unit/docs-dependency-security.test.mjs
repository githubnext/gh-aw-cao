import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = new URL("../../", import.meta.url);
const minimumVersions = {
  sharp: "0.35.5",
  "smol-toml": "1.9.0",
  "postcss-selector-parser": "7.1.6",
  katex: "0.18.2",
};

test("lockfiles exclude vulnerable documentation dependency versions with available fixes", () => {
  const found = new Set();
  for (const directory of ["", "dashboard/site/", "server/spec/"]) {
    const lock = JSON.parse(readFileSync(new URL(`${directory}package-lock.json`, root), "utf8"));
    for (const [path, entry] of Object.entries(lock.packages)) {
      for (const [name, minimum] of Object.entries(minimumVersions)) {
        if (!path.endsWith(`/node_modules/${name}`) && path !== `node_modules/${name}`) continue;
        found.add(name);
        assert.match(entry.version, /^\d+\.\d+\.\d+$/);
        const actual = entry.version.split(".").map(Number);
        const floor = minimum.split(".").map(Number);
        const difference = actual.findIndex((part, index) => part !== floor[index]);
        assert.ok(difference === -1 || actual[difference] > floor[difference],
          `${directory}${path}: ${entry.version} must be at least ${minimum}`);
      }
    }
  }
  assert.deepEqual([...found].sort(), Object.keys(minimumVersions).sort());
});

test("Expressive Code's nested CSS works with the patched selector parser", async () => {
  const coreRequire = createRequire(require.resolve("@expressive-code/core"));
  const nestedRequire = createRequire(coreRequire.resolve("postcss-nested"));
  const parser = nestedRequire("postcss-selector-parser");
  const selectors = parser().astSync(".code:is(.light, .dark) > [data-language=\"js\"]");
  assert.equal(selectors.toString(), ".code:is(.light, .dark) > [data-language=\"js\"]");

  const result = await coreRequire("postcss")([coreRequire("postcss-nested")]).process(
    ".code { &:is(.light, .dark) { color: red; } @media (min-width: 40rem) { & > pre { color: blue; } } }",
    { from: undefined },
  );
  assert.match(result.css, /\.code:is\(\.light, \.dark\)/);
  assert.match(result.css, /@media \(min-width: 40rem\)/);
  assert.match(result.css, /\.code > pre/);
});

test("Mermaid can load the patched KaTeX API and stylesheet", () => {
  const mermaidRequire = createRequire(require.resolve("mermaid"));
  const katex = mermaidRequire("katex");
  assert.match(katex.renderToString(String.raw`\frac{1}{2}`, { throwOnError: true }), /class="katex"/);
  assert.ok(readFileSync(mermaidRequire.resolve("katex/dist/katex.min.css"), "utf8").length > 0);
  assert.throws(() => katex.renderToString(String.raw`\invalidcommand`, { throwOnError: true }), /Undefined control sequence/);
});

test("Astro can parse TOML and render SVG images with the patched dependencies", async () => {
  const astroRequire = createRequire(require.resolve("astro"));
  const { parse } = astroRequire("smol-toml");
  const document = parse('[project]\nname = "CAO"\nenabled = true\n');
  assert.equal(document.project.name, "CAO");
  assert.equal(document.project.enabled, true);
  const sharp = astroRequire("sharp");
  const { info } = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>',
  )).png().toBuffer({ resolveWithObject: true });
  assert.equal(info.format, "png");
  assert.equal(info.width, 2);
  assert.equal(info.height, 3);
});
