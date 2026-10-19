import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { renderNativeSlideGeometry } from "../../scripts/collect-slide-geometry-history.mjs";
import { parsePublicLfsPointer, verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";
import { scanNativeSlideGeometry, scoreNativeSlideGeometry } from "../../scripts/native-slide-geometry-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("native slide bounds count affected slides separately from nested overflowing elements", () => {
  const evidence = { valid: true, slides: [{ bounds: [0, 0, 1280, 720],
    elements: [[20, 20, 1200, 700], [20, 30, 1250, 750], [30, 40, 1260, 740]] },
  { bounds: [0, 730, 1280, 1450], elements: [[0, 730, 1280, 1450]] }] };
  assert.deepEqual(scanNativeSlideGeometry(evidence), { "overflowing-slides": 1, "overflowing-elements": 2 });
  assert.equal(scoreNativeSlideGeometry("overflowing-slides", evidence), 1);
  assert.equal(scoreNativeSlideGeometry("overflowing-elements", evidence), 2);
  for (const elements of [[[0, 0, 0, 1]], [[0, 0, Infinity, 1]], [[0, 0, 1]], [null]]) {
    assert.equal(scanNativeSlideGeometry({ valid: true, slides: [{ bounds: [0, 0, 1280, 720], elements }] }), null);
  }
  assert.equal(scanNativeSlideGeometry({ valid: true, slides: [] }), null);
  assert.equal(scanNativeSlideGeometry({ ...evidence, valid: false }), null);
  assert.throws(() => scoreNativeSlideGeometry("runs", evidence), /Unknown/);
  for (const rectangle of [[-1, 0, 20, 20], [0, -1, 20, 20], [0, 0, 1281, 20], [0, 0, 20, 721]]) {
    assert.equal(scoreNativeSlideGeometry("overflowing-slides", { valid: true,
      slides: [{ bounds: [0, 0, 1280, 720], elements: [rectangle] }] }), 1);
  }
});

test("immutable slide inputs distinguish exact LFS pointers from native content and reject altered Git identities", () => {
  const oid = "a".repeat(64), bytes = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n`);
  assert.deepEqual(parsePublicLfsPointer(bytes), { oid, size: 123 });
  assert.equal(parsePublicLfsPointer(Buffer.from("# Actual slide")), null);
  assert.throws(() => parsePublicLfsPointer(Buffer.from(bytes.toString().replace("123", "999999999"))), /over-budget/);
  assert.throws(() => parsePublicLfsPointer(Buffer.from(bytes.toString().replace("v1", "v2"))), /Malformed/);
  const id = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(verifyPublicGitBlob(bytes, id), bytes);
  assert.throws(() => verifyPublicGitBlob(Buffer.concat([bytes, Buffer.from("x")]), id), /identity mismatch/);
});

test("native browser replay measures bounds with scripts disabled and external visual resources fail closed", {
  skip: !existsSync(chromium.executablePath()),
}, async () => {
  const browser = await chromium.launch({ headless: true });
  class FixtureMarp {
    themeSet = { add() {} };
    render(content) {
      return { html: content, css: "section{position:relative;width:1280px;height:720px}p{position:absolute;left:0;top:0;width:100px;height:30px;margin:0}" };
    }
  }
  const source = content => ({ id: "a".repeat(40), path: "docs/slides/index.md", bytes: Buffer.from(content) });
  try {
    const result = await renderNativeSlideGeometry(browser, FixtureMarp, () => null, "b".repeat(40),
      source('<section><p>Fits</p><p style="left:1270px">Overflows</p><script>document.body.innerHTML=""</script></section>'), source(""));
    assert.deepEqual(scanNativeSlideGeometry(result.geometry), { "overflowing-slides": 1, "overflowing-elements": 1 });
    const external = await renderNativeSlideGeometry(browser, FixtureMarp, () => null, "b".repeat(40),
      source('<section><img src="https://example.invalid/image.png"></section>'), source(""));
    assert.equal(external.geometry.valid, false);
    assert.deepEqual(external.blockedExternalAssets, ["image"]);
    assert.equal(scoreNativeSlideGeometry("overflowing-slides", external.geometry), null);
  } finally {
    await browser.close();
  }
});

test("retained native slide history replays Git/LFS identities and every measured rectangle", {
  skip: !existsSync("docs/operational-value/proof/slide-geometry/index.json"),
}, () => {
  const directory = "docs/operational-value/proof/slide-geometry";
  const [contract] = readCensusJson(`${directory}/contracts.json`), index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`), sources = readCensusJson(`${directory}/sources.json.gz`);
  assert.equal(index.complete, true);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.factsSha256, censusDigest(facts));
  assert.equal(index.sourcesSha256, censusDigest(sources));
  assert.equal(contract.renderer.scripts, "disabled");
  assert.equal(facts.states.length, 45);
  assert.equal(facts.states.filter(state => state.geometry.valid).length, 36);
  assert.equal(facts.states.at(-1).geometry.slides.length, 36);
  assert.equal(scoreNativeSlideGeometry("overflowing-slides", facts.states.at(-1).geometry), 0);
  assert.ok(facts.states.some(state => scoreNativeSlideGeometry("overflowing-slides", state.geometry) === 3));
  assert.equal(scoreNativeSlideGeometry("overflowing-slides", facts.states[0].geometry), null);
  for (const source of sources) {
    const bytes = Buffer.from(source.content, "base64"), native = Buffer.from(source.native, "base64");
    verifyPublicGitBlob(native, source.id);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
    assert.deepEqual(parsePublicLfsPointer(native), source.lfs);
    if (source.lfs) {
      assert.equal(bytes.length, source.lfs.size);
      assert.equal(source.sha256, source.lfs.oid);
    } else assert.deepEqual(bytes, native);
  }
  for (const state of facts.states) {
    for (const file of state.files) assert.ok(sources.some(source => source.id === file.gitBlob));
    if (state.geometry.valid) assert.notEqual(scanNativeSlideGeometry(state.geometry), null);
  }
  const timelinePath = "docs/operational-value/proof/reports/github-gh-aw/slide-deck-maintainer-timeline.json";
  if (existsSync(timelinePath)) {
    const timeline = readCensusJson(timelinePath);
    for (const snapshot of timeline.snapshots) {
      const state = facts.states.find(state => state.windowEnd === snapshot.window.endAt);
      for (const metric of ["overflowing-slides", "overflowing-elements"]) {
        assert.equal(snapshot.metrics[metric], scoreNativeSlideGeometry(metric, state?.geometry));
      }
    }
    assert.equal(timeline.valueReview.current.status, "complete");
    assert.equal(timeline.valueReview.current.eligibleCount, 36);
    assert.equal(timeline.valueReview.recentComparison.nativeDelta, 0);
    assert.equal(timeline.valueReview.decision.status, "not-rated");
  }
});
