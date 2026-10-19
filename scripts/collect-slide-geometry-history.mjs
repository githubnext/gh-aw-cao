import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { scanNativeSlideGeometry } from "./native-slide-geometry-value.mjs";

const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", until = "2026-10-18T15:00:12Z";
const directory = "docs/operational-value/proof/slide-geometry";

export async function renderNativeSlideGeometry(browser, Marp, read, commit, deck, theme) {
  const files = [{ path: deck.path, gitBlob: deck.id }, { path: theme.path, gitBlob: theme.id }];
  const missingAssets = new Set(), blockedExternalAssets = new Set();
  const marp = new Marp({ html: true });
  marp.themeSet.add(theme.bytes.toString("utf8"));
  const rendered = marp.render(deck.bytes.toString("utf8"));
  if (Buffer.byteLength(rendered.html) + Buffer.byteLength(rendered.css) > 8 * 1024 * 1024) {
    throw new Error("Native slide render exceeds byte budget");
  }
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block",
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" });
  try {
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "https://immutable.invalid") {
        blockedExternalAssets.add(request.resourceType());
        await route.abort("blockedbyclient");
        return;
      }
      const file = decodeURIComponent(url.pathname.slice(1));
      if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.split("/").some(part => ["", ".", ".."].includes(part))) {
        throw new Error("Unsafe native slide asset reference");
      }
      if (files.length + missingAssets.size >= 40) throw new Error("Native slide asset count budget exhausted");
      const source = read(commit, file);
      if (!source) {
        missingAssets.add(file);
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      if (!files.some(row => row.path === file)) files.push({ path: file, gitBlob: source.id });
      const type = file.endsWith(".woff2") ? "font/woff2" : file.endsWith(".css") ? "text/css"
        : file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
      await route.fulfill({ status: 200, contentType: type, body: source.bytes });
    });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><base href="https://immutable.invalid/docs/slides/"><style>${rendered.css}</style></head><body>${rendered.html}</body></html>`,
      { waitUntil: "networkidle", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const slides = await page.locator("section").evaluateAll(sections => sections.map(section => {
      const rect = element => {
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return [left, top, right, bottom];
      };
      return { bounds: rect(section), elements: [...section.querySelectorAll("*")].map(rect)
        .filter(([left, top, right, bottom]) => right > left && bottom > top) };
    }));
    const geometry = { valid: blockedExternalAssets.size === 0, slides };
    if (geometry.valid && scanNativeSlideGeometry(geometry) === null) throw new Error("Malformed native slide geometry output");
    if (!geometry.valid) geometry.missingReason = "External visual resources are outside the frozen static replay.";
    return { geometry, files, missingAssets: [...missingAssets].sort(), blockedExternalAssets: [...blockedExternalAssets].sort() };
  } finally {
    await context.close();
  }
}

export async function collectSlideGeometryHistory(cache, rendererDirectory, prepareOnly = false) {
  const repository = "github/gh-aw", workflowId = "slide-deck-maintainer", sourcePath = `.github/workflows/${workflowId}.md`;
  const source = publicGitSourceReader(cache, repository), git = source.metadata;
  const require = createRequire(path.join(path.resolve(rendererDirectory), "package.json"));
  const { Marp } = require("@marp-team/marp-core");
  const version = JSON.parse(readFileSync(path.join(rendererDirectory, "node_modules/@marp-team/marp-core/package.json"), "utf8")).version;
  if (version !== "4.4.0") throw new Error("Expected the reviewed Marp 4.4.0 renderer");
  const browser = await chromium.launch({ headless: true });
  try {
    const adoption = git(["log", "--first-parent", "--diff-filter=A", "--format=%H", revision, "--", sourcePath]).split("\n");
    if (adoption.length !== 1 || !/^[a-f0-9]{40}$/.test(adoption[0])) throw new Error("Ambiguous slide-workflow adoption");
    const commit = adoption[0], baseline = git(["rev-parse", `${commit}^`]);
    for (const file of [sourcePath, sourcePath.replace(/\.md$/, ".lock.yml")]) {
      if (git(["diff-tree", "--no-commit-id", "--name-status", "-r", baseline, commit, "--", file]) !== `A\t${file}`) {
        throw new Error("Slide-workflow adoption is not a source/compiled addition");
      }
    }
    const date = commit => new Date(git(["show", "-s", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
    const contract = { repository, workflowId, sourcePath, sourceRevision: revision, until, directory,
      sourceGitBlob: git(["rev-parse", `${revision}:${sourcePath}`]),
      adoption: { commit, adoptedAt: date(commit), baselineCommit: baseline, baselineAt: date(baseline) },
      deckPath: "docs/slides/index.md", themePath: "docs/slides/gh-aw-theme.css",
      interpreterSha256: sha("scripts/native-slide-geometry-value.mjs"),
      sourceReaderSha256: sha("scripts/immutable-public-git-source.mjs"),
      renderer: { marp: version, chromium: browser.version(), platform: `${os.platform()}-${os.arch()}`,
        osRelease: os.release(), dependencyLockSha256: sha(path.join(rendererDirectory, "package-lock.json")),
        scripts: "disabled", externalRequests: "blocked", viewport: [1440, 900], scale: 1,
        geometryPolicy: "Positive-area descendants outside any of the four native section bounds; no rounding tolerance." } };
    mkdirSync(`${directory}/renders`, { recursive: true });
    const functionFile = `docs/operational-value/proof/functions/${workflowId}.mjs`;
    const wrapper = `import { nativeSlideGeometryModule } from "../../../../scripts/native-slide-geometry-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = nativeSlideGeometryModule(${JSON.stringify(contract, null, 2)});\n`;
    if (existsSync(functionFile) && readFileSync(functionFile, "utf8") !== wrapper) throw new Error("Refusing to replace frozen slide function");
    writeFileSync(functionFile, wrapper);
    writeCensusJson(`${directory}/contracts.json`, [contract]);
    copyFileSync(path.join(rendererDirectory, "package-lock.json"), `${directory}/renderer-lock.json`);
    if (prepareOnly) return { prepared: workflowId, renderer: contract.renderer };
    if (existsSync(`${directory}/index.json`)) {
      const index = readCensusJson(`${directory}/index.json`), facts = readCensusJson(`${directory}/facts.json.gz`);
      const sources = readCensusJson(`${directory}/sources.json.gz`);
      if (!index.complete || index.contractSha256 !== censusDigest(contract)
        || index.factsSha256 !== censusDigest(facts) || index.sourcesSha256 !== censusDigest(sources)) {
        throw new Error("Retained native slide acquisition changed");
      }
      return { reused: true, states: facts.states.length };
    }
    const start = Date.parse(contract.adoption.adoptedAt), end = Date.parse(until), week = 7 * 86400000;
    const endpoints = new Set([end, end - week]);
    for (let at = start + week; at <= end; at += week) endpoints.add(at);
    const states = [];
    for (const at of [...endpoints].filter(at => at > start).sort((a, b) => a - b)) {
      const windowEnd = new Date(at).toISOString().replace(".000Z", "Z");
      const commit = git(["rev-list", "--first-parent", "-1", `--before=${windowEnd}`, revision]);
      const deck = source.read(commit, contract.deckPath), theme = source.read(commit, contract.themePath);
      if (!deck || !theme) {
        states.push({ windowEnd, commit, files: [], geometry: { valid: false, missingReason: "Immutable deck or theme is absent." } });
        continue;
      }
      const key = censusDigest({ deck: deck.id, theme: theme.id, commit, contract: censusDigest(contract) });
      const file = `${directory}/renders/${key}.json.gz`;
      let result;
      if (existsSync(file)) {
        const cached = readCensusJson(file);
        if (cached.contractSha256 !== censusDigest(contract) || cached.commit !== commit
          || cached.sha256 !== censusDigest(cached.result)) throw new Error("Retained native slide render changed");
        result = cached.result;
        for (const entry of result.files) {
          if (source.read(commit, entry.path)?.id !== entry.gitBlob) throw new Error("Retained slide asset identity changed");
        }
      } else {
        result = await renderNativeSlideGeometry(browser, Marp, source.read, commit, deck, theme);
        writeCensusJson(file, { contractSha256: censusDigest(contract), commit, sha256: censusDigest(result), result });
      }
      states.push({ windowEnd, commit, ...result });
      console.log(JSON.stringify({ windowEnd, slides: result.geometry.slides.length,
        metrics: scanNativeSlideGeometry(result.geometry), missingAssets: result.missingAssets.length }));
    }
    const facts = { states }, sources = source.sources();
    writeCensusJson(`${directory}/facts.json.gz`, facts);
    writeCensusJson(`${directory}/sources.json.gz`, sources);
    const index = { schemaVersion: 1, complete: true, repository, workflowId, sourceRevision: revision, until,
      contractSha256: censusDigest(contract), factsSha256: censusDigest(facts), sourcesSha256: censusDigest(sources),
      states: states.length, sourceBlobs: sources.length, acquiredAt: new Date().toISOString(),
      producer: { path: "scripts/collect-slide-geometry-history.mjs", sha256: sha(import.meta.filename) } };
    writeCensusJson(`${directory}/index.json`, index);
    return { complete: true, states: states.length, sourceBlobs: sources.length };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === import.meta.filename) {
  const [cache, renderer, flag, ...extra] = process.argv.slice(2);
  if (!cache || !renderer || extra.length || flag && flag !== "--prepare-only") {
    throw new Error("usage: collect-slide-geometry-history.mjs BARE_CACHE PINNED_RENDERER_DIRECTORY [--prepare-only]");
  }
  console.log(JSON.stringify(await collectSlideGeometryHistory(cache, renderer, flag === "--prepare-only")));
}
