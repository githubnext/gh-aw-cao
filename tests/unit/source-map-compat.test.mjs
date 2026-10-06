import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { SourceMapConsumer, SourceMapGenerator } = require("source-map-js");
const postcss = require("postcss");
const cssTree = require("css-tree");
const csso = require("csso");

function originalMap(options = {}) {
  const map = new SourceMapGenerator({ file: "input.css", ...options });
  map.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 3, column: 2 },
    source: "original.scss",
    name: "color",
  });
  map.setSourceContent("original.scss", "$color: red;\n\na { color: $color; }");
  return map;
}

test("both lockfiles resolve every source-map-js dependency to a real local package", () => {
  for (const directory of ["", "dashboard/site/"]) {
    const base = new URL(`../../${directory}`, import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("package.json", base), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", base), "utf8"));
    assert.equal(manifest.overrides["source-map-js"], "$source-map-js");
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith("/source-map-js"));
    assert.equal(entries.length, 1);
    for (const [, entry] of entries) {
      assert.equal(entry.link, true);
      assert.equal(lock.packages[entry.resolved].name, "@central-agentic-ops/source-map-compat");
      const local = JSON.parse(readFileSync(new URL(`${entry.resolved}/package.json`, base), "utf8"));
      assert.equal(local.scripts, undefined);
    }
    assert.doesNotMatch(JSON.stringify(lock), /source-map-js-1\.2\.2\.tgz/);
  }
});

test("CommonJS and CSS-tree's ESM deep imports share the generator", async () => {
  const deep = require.resolve("source-map-js/lib/source-map-generator.js");
  assert.equal(require(deep).SourceMapGenerator, SourceMapGenerator);
  assert.equal((await import(deep)).SourceMapGenerator, SourceMapGenerator);
});

test("maps round-trip names, positions, unmapped segments, and source content", () => {
  const map = originalMap();
  map.addMapping({ generated: { line: 1, column: 5 } });
  const consumer = new SourceMapConsumer(map.toString());
  assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 4 }), {
    source: "original.scss", line: 3, column: 2, name: "color",
  });
  assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 5 }), {
    source: null, line: null, column: null, name: null,
  });
  assert.equal(consumer.sourceContentFor("original.scss"), "$color: red;\n\na { color: $color; }");
  assert.equal(consumer.hasContentsOfAllSources(), true);
  const mappings = [];
  consumer.eachMapping(function (mapping) { this.push(mapping); }, mappings);
  assert.equal(mappings.length, 2);
  assert.equal(mappings[0].generatedLine, 1);
  assert.equal(mappings[0].originalLine, 3);
});

test("mapping positions are copied rather than retaining CSS-tree's mutable objects", () => {
  const map = new SourceMapGenerator();
  const mapping = { generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "in.css" };
  map.addMapping(mapping);
  mapping.generated.column = 8;
  mapping.original.line = 2;
  map.addMapping(mapping);
  const consumer = new SourceMapConsumer(map.toJSON());
  assert.equal(consumer.originalPositionFor({ line: 1, column: 0 }).line, 1);
  assert.equal(consumer.originalPositionFor({ line: 1, column: 8 }).line, 2);
});

test("missing source content is distinct from an unknown source", () => {
  const consumer = new SourceMapConsumer({ version: 3, sources: ["input.css"], names: [], mappings: "AAAA" });
  assert.equal(consumer.sourceContentFor("input.css"), null);
  assert.equal(consumer.hasContentsOfAllSources(), false);
  assert.equal(consumer.sourceContentFor("missing.css", true), null);
  assert.throws(() => consumer.sourceContentFor("missing.css"), /Source not found/);
  assert.throws(() => new SourceMapConsumer("{"), SyntaxError);
});

test("indexed maps honor section offsets", () => {
  const consumer = new SourceMapConsumer({
    version: 3,
    sections: [{ offset: { line: 2, column: 5 }, map: originalMap().toJSON() }],
  });
  assert.equal(consumer.originalPositionFor({ line: 3, column: 5 }).line, 3);
  assert.equal(consumer.originalPositionFor({ line: 3, column: 4 }).source, null);
});

test("fromSourceMap preserves a changed output filename and disabled source content", () => {
  const consumer = SourceMapConsumer.fromSourceMap(originalMap());
  consumer.file = "output.css";
  consumer.sourcesContent = null;
  const copy = SourceMapGenerator.fromSourceMap(consumer);
  assert.equal(copy.toJSON().file, "output.css");
  assert.ok(copy.toJSON().sourcesContent.every((content) => content == null));
  assert.equal(new SourceMapConsumer(copy.toJSON()).sourceContentFor("original.scss"), null);
  copy._file = "minified.css";
  assert.equal(copy.toJSON().file, "minified.css");
});

test("invalid mappings throw unless PostCSS explicitly requests ignoring them", () => {
  const invalid = { generated: { line: 1, column: -1 } };
  assert.throws(() => new SourceMapGenerator().addMapping(invalid), /Invalid source map mapping/);
  const map = new SourceMapGenerator({ ignoreInvalidMapping: true });
  map.addMapping(invalid);
  assert.equal(map.toJSON().mappings, "");
  assert.throws(() => map.applySourceMap(new SourceMapConsumer({
    version: 3, sources: [], names: [], mappings: "",
  })), /source file is required/);
});

test("chained maps preserve unrelated and unmapped segments and rebase original sources", () => {
  const map = new SourceMapGenerator({ file: "output.css" });
  map.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "input.css" });
  map.addMapping({ generated: { line: 1, column: 5 } });
  map.addMapping({ generated: { line: 2, column: 0 }, original: { line: 4, column: 0 }, source: "other.css" });
  map.setSourceContent("input.css", "generated CSS");
  map.setSourceContent("other.css", "other CSS");
  map.applySourceMap(new SourceMapConsumer(originalMap().toJSON()), undefined, "../src");
  const consumer = new SourceMapConsumer(map.toJSON());
  assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 0 }), {
    source: "../src/original.scss", line: 3, column: 2, name: "color",
  });
  assert.equal(consumer.originalPositionFor({ line: 1, column: 5 }).source, null);
  assert.equal(consumer.originalPositionFor({ line: 2, column: 0 }).source, "other.css");
  assert.equal(consumer.sourceContentFor("other.css"), "other CSS");
  assert.ok(!consumer.sources.includes("input.css"));
});

test("source roots and URL source paths survive map composition", () => {
  const map = new SourceMapGenerator({ file: "output.css", sourceRoot: "https://example.com/src/" });
  map.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "input.css" });
  const previous = originalMap({ sourceRoot: "https://example.com/scss/" });
  map.applySourceMap(new SourceMapConsumer(previous.toJSON()), "https://example.com/src/input.css");
  const consumer = new SourceMapConsumer(map.toJSON());
  assert.equal(consumer.originalPositionFor({ line: 1, column: 0 }).source, "https://example.com/scss/original.scss");
  assert.equal(consumer.sourceContentFor("https://example.com/scss/original.scss"), "$color: red;\n\na { color: $color; }");
});

test("relative source roots preserve raw source names and embedded content", () => {
  const previous = new SourceMapConsumer(originalMap({ sourceRoot: "src" }).toJSON());
  assert.equal(previous.sourceContentFor("src/original.scss"), "$color: red;\n\na { color: $color; }");
  const map = new SourceMapGenerator({ sourceRoot: "src" });
  map.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "input.css" });
  map.applySourceMap(new SourceMapConsumer(originalMap().toJSON()));
  assert.equal(new SourceMapConsumer(map.toJSON()).originalPositionFor({ line: 1, column: 0 }).source, "src/original.scss");
});

test("PostCSS generates and chains real maps, including inline and content-free output", async () => {
  const plugin = { postcssPlugin: "change-color", Declaration(declaration) { declaration.value = "blue"; } };
  const first = await postcss([plugin]).process("a { color: red; }", {
    from: "/styles/input.css", to: "/styles/intermediate.css",
    map: { inline: false, annotation: false, prev: originalMap() },
  });
  const second = await postcss([plugin]).process(first.css, {
    from: "/styles/intermediate.css", to: "/styles/output.css",
    map: { inline: false, annotation: false, prev: first.map },
  });
  const consumer = new SourceMapConsumer(second.map.toJSON());
  assert.equal(consumer.originalPositionFor({ line: 1, column: 4 }).source, "original.scss");
  assert.equal(consumer.originalPositionFor({ line: 1, column: 4 }).line, 3);
  assert.match(second.css, /blue/);
  const noContent = await postcss([plugin]).process(first.css, {
    from: "/styles/intermediate.css", to: "/styles/no-content.css",
    map: { inline: false, prev: first.map, sourcesContent: false },
  });
  assert.ok(noContent.map.toJSON().sourcesContent.every((content) => content == null));
  const inline = await postcss([plugin]).process("a { color: red; }", {
    from: "/styles/input.css", map: { inline: true },
  });
  assert.match(inline.css, /sourceMappingURL=data:application\/json/);
});

test("PostCSS diagnostics point to the original source", () => {
  const input = new postcss.Input("a { color: red; }", {
    from: "/styles/input.css", map: { prev: originalMap() },
  });
  const error = input.error("bad color", 1, 5);
  assert.equal(error.file, "/styles/original.scss");
  assert.equal(error.line, 3);
  assert.equal(error.column, 3);
  assert.equal(error.source, "$color: red;\n\na { color: $color; }");
});

test("CSS-tree and CSSO generate usable CSS maps through the deep import", () => {
  const css = "a { color: red; }";
  const tree = cssTree.parse(css, { positions: true, filename: "input.css" });
  const result = cssTree.generate(tree, { sourceMap: true });
  assert.equal(result.css, "a{color:red}");
  assert.equal(new SourceMapConsumer(result.map.toJSON()).originalPositionFor({ line: 1, column: 0 }).source, "input.css");
  const minified = csso.minify(css, { sourceMap: true, filename: "input.css" });
  assert.equal(minified.map.toJSON().file, "input.css");
  assert.equal(new SourceMapConsumer(minified.map.toJSON()).sourceContentFor("input.css"), css);
});
