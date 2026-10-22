import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist");
const publicBase = new URL("https://githubnext.github.io/gh-cao/");

function hrefForRel(html, rel, type) {
  const tags = html.match(/<link\b[^>]*>/g) ?? [];
  const tag = tags.find((candidate) =>
    candidate.includes(`rel="${rel}"`) && (!type || candidate.includes(`type="${type}"`))
  );
  return tag?.match(/\bhref="([^"]+)"/)?.[1];
}

function markdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

function fileForPublicUrl(url) {
  const parsed = new URL(url, publicBase);
  assert.equal(parsed.origin, publicBase.origin);
  assert.ok(parsed.pathname.startsWith(publicBase.pathname));
  const relative = parsed.pathname.slice(publicBase.pathname.length);
  return path.join(dist, relative || "index.html");
}

test("documentation links expose complete static social cards for Teams", async () => {
  function meta(html, key) {
    const tags = (html.match(/<meta\b[^>]*>/g) ?? [])
      .filter((tag) => tag.includes(`property="${key}"`) || tag.includes(`name="${key}"`));
    assert.equal(tags.length, 1, `expected exactly one ${key} tag`);
    return tags[0].match(/\bcontent="([^"]+)"/)?.[1];
  }

  for (const route of ["", "architecture/", "catalog/", "blog/"]) {
    const html = await readFile(path.join(dist, route, "index.html"), "utf8");
    const imageUrl = meta(html, "og:image");
    assert.equal(imageUrl, new URL("social-card.png", publicBase).href);
    assert.equal(meta(html, "twitter:image"), imageUrl);
    assert.equal(meta(html, "twitter:card"), "summary_large_image");
    assert.equal(meta(html, "og:image:type"), "image/png");
    assert.ok(meta(html, "og:image:alt"));
    assert.equal(meta(html, "twitter:image:alt"), meta(html, "og:image:alt"));
    assert.ok(meta(html, "og:title"));
    assert.ok(meta(html, "og:description"));
    assert.equal(meta(html, "og:url"), new URL(route, publicBase).href);

    const image = await readFile(fileForPublicUrl(imageUrl));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(image.readUInt32BE(16), Number(meta(html, "og:image:width")));
    assert.equal(image.readUInt32BE(20), Number(meta(html, "og:image:height")));
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
  }

  const landingHtml = await readFile(path.join(dist, "index.html"), "utf8");
  assert.deepEqual(landingHtml.match(/<title>[^<]*<\/title>/g), [
    "<title>Central Agentic Ops (CAO)</title>",
  ]);
  assert.equal(meta(landingHtml, "og:title"), "Central Agentic Ops (CAO)");
  assert.equal(meta(landingHtml, "og:type"), "website");
  const articleHtml = await readFile(path.join(dist, "architecture/index.html"), "utf8");
  assert.equal(meta(articleHtml, "og:type"), "article");
  assert.match(articleHtml, /<title>Architecture \| Central Agentic Ops<\/title>/);
});

test("an external agent can traverse static discovery and resource metadata", async () => {
  const landingHtml = await readFile(path.join(dist, "index.html"), "utf8");
  const scopedHref = hrefForRel(landingHtml, "describedby");
  assert.ok(scopedHref, "landing HTML must advertise scoped llms.txt");
  const indexHref = hrefForRel(landingHtml, "index", "application/json");
  assert.ok(indexHref, "landing HTML must advertise the machine-readable resource index");
  const index = JSON.parse(await readFile(fileForPublicUrl(indexHref), "utf8"));
  const dashboardSummary = index.resources.find((entry) => entry.id === "dashboard");
  assert.deepEqual(dashboardSummary.interfaces, ["cli", "cli-mcp", "web-mcp"]);

  const scoped = await readFile(fileForPublicUrl(scopedHref), "utf8");
  const links = markdownLinks(scoped);
  const resourceHtmlUrl = links.find((link) => link.endsWith("/architecture/"));
  assert.ok(resourceHtmlUrl, "scoped llms.txt must expose an important resource route");

  const resourceHtml = await readFile(
    path.join(fileForPublicUrl(resourceHtmlUrl), "index.html"),
    "utf8",
  );
  const alternateHref = hrefForRel(resourceHtml, "alternate", "application/json");
  assert.ok(alternateHref, "resource HTML must advertise JSON metadata");

  const resource = JSON.parse(await readFile(fileForPublicUrl(alternateHref), "utf8"));
  const related = resource.links.find((link) => link.rel === "related");
  assert.ok(related, "resource metadata must expose a related resource");
  const relatedResource = JSON.parse(await readFile(fileForPublicUrl(related.href), "utf8"));

  assert.equal(resource.provenance.repository, "githubnext/gh-cao");
  assert.match(resource.provenance.commit, /^[0-9a-f]{40}$/);
  assert.equal(resource.provenance.commit, process.env.PUBLIC_PAGES_BUILD_COMMIT
    || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  assert.ok(Number.isFinite(Date.parse(resource.freshness.generatedAt)));
  assert.ok(Number.isFinite(Date.parse(resource.freshness.sourceCommittedAt)));
  assert.equal(resource.source.path, "docs/architecture.md");
  assert.match(resource.integrity.sourceDigest, /^[0-9a-f]{64}$/);
  assert.equal(typeof relatedResource.id, "string");
  assert.equal(typeof relatedResource.provenance.source, "string");
  assert.ok(Number.isFinite(Date.parse(relatedResource.freshness.generatedAt)));

  const dashboard = JSON.parse(await readFile(path.join(dist, "dashboard", "index.json"), "utf8"));
  assert.equal(dashboard.interfaces.cli[0].subcommand, "status");
  assert.deepEqual(dashboard.interfaces.cli[0].arguments, {
    positional: ["pages", "overview"],
    options: { "--json": true },
  });
  assert.deepEqual(
    dashboard.interfaces.mcp.map((binding) => [binding.transport, binding.capability]),
    [["cli", "cao_catalog"], ["web", "cao_overview"]],
  );
  assert.equal(dashboard.recommendedInterface.default, "web-mcp");

  const catalog = JSON.parse(await readFile(path.join(dist, "agent-analysis", "index.json"), "utf8"));
  assert.equal(catalog.interfaces.cli[0].subcommand, "status");
  assert.deepEqual(catalog.interfaces.cli[0].arguments, {
    positional: ["pages"],
    options: { "--json": true },
  });
  assert.deepEqual(
    catalog.interfaces.mcp.map((binding) => binding.arguments),
    [{ kind: "pages" }, { kind: "queries" }],
  );
});
