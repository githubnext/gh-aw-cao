import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.join(root, "dist");
const publicBase = new URL("https://githubnext.github.io/gh-aw-cao/");

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

test("an external agent can traverse static discovery and resource metadata", async () => {
  const landingHtml = await readFile(path.join(dist, "index.html"), "utf8");
  const scopedHref = hrefForRel(landingHtml, "describedby");
  assert.ok(scopedHref, "landing HTML must advertise scoped llms.txt");
  const indexHref = hrefForRel(landingHtml, "index", "application/json");
  assert.ok(indexHref, "landing HTML must advertise the machine-readable resource index");
  const index = JSON.parse(await readFile(fileForPublicUrl(indexHref), "utf8"));
  assert.ok(index.resources.some((entry) => entry.id === "dashboard"));

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

  assert.equal(resource.provenance.repository, "githubnext/gh-aw-cao");
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
  assert.equal(dashboard.interfaces.cli[0].subcommand, "pages");
  assert.deepEqual(
    dashboard.interfaces.mcp.map((binding) => [binding.transport, binding.capability]),
    [["cli", "cao_catalog"], ["web", "cao_overview"]],
  );
  assert.equal(dashboard.recommendedInterface.default, "web-mcp");
});
