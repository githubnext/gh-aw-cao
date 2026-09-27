import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWizardHost,
  buildWizardPolicy,
  selectConfiguredOperations,
} from "../../docs/lib/configured-operations.mjs";

const controlPolicy = JSON.parse(readFileSync(".github/workflows/cao.json", "utf8"));

const landingPage = readFileSync("docs/README.md", "utf8");
const hero = readFileSync("docs/components/HierarchyHero.astro", "utf8");
const heroIntro = readFileSync("docs/components/HeroIntro.astro", "utf8");
const terminal = readFileSync("docs/components/TerminalDemo.astro", "utf8");
const wizard = readFileSync("docs/components/OpsWizard.astro", "utf8");
const setupPage = readFileSync("docs/pages/setup.astro", "utf8");
const headerLinks = readFileSync("docs/components/HeaderLinks.astro", "utf8");
const catalog = readFileSync("docs/lib/catalog.ts", "utf8");

test("landing page presents the product through real operational surfaces", () => {
  assert.match(landingPage, /text: Explore CAO[\s\S]*?link: \/gh-aw-cao\/architecture-at-a-glance\//);
  assert.match(landingPage, /text: Get started[\s\S]*?link: \/gh-aw-cao\/getting-started\//);
  assert.match(landingPage, /text: Dashboard[\s\S]*?link: https:\/\/githubnext\.github\.io\/gh-aw-cao\/cao/);
  assert.doesNotMatch(headerLinks, /label: "Dashboard"/);
  assert.match(landingPage, /title: Central Agentic Ops \(CAO\)/);
  assert.match(landingPage, /Hyperscale Agentic Campaigns\.<br \/>Centralized Control Planes\./);
  assert.match(hero, /cao-dashboard-mobile-overview\.png/);
  assert.match(hero, /cao-dashboard-mobile-overview-light\.png/);
  assert.match(hero, /cao-dashboard-run-history-mobile\.png/);
  assert.match(hero, /cao-dashboard-run-history-mobile-light\.png/);
  assert.match(hero, /cao-dashboard-campaign-value-mobile\.png/);
  assert.match(hero, /cao-dashboard-campaign-value-mobile-light\.png/);
  assert.match(hero, /product-shot-mobile product-shot-runs/);
  assert.match(hero, /product-shot-mobile product-shot-value/);
  assert.match(hero, /\.product-shot-runs \{[\s\S]*?height: clamp\(25rem, 38vw, 29rem\)/);
  assert.match(hero, /\.product-shot-value \{[\s\S]*?height: clamp\(28rem, 38vw, 31rem\)/);
  assert.match(hero, /\.product-shot-value :global\(picture\[data-theme-picture\]\) \{[\s\S]*?width: min\(100%, 22rem\)/);
  assert.match(hero, /ThemeImage/);
  assert.match(hero, /@media \(max-width: 42rem\) \{[\s\S]*?\.hero-callout \{[\s\S]*?display: flex/);
  assert.match(hero, /\.hero-callout \.callout-line \{[\s\S]*?display: none/);
  assert.match(hero, /From one control repo to many campaigns/);
  assert.match(hero, /\.terminal-story \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(hero, /Coordinate campaigns from one control plane/);
  assert.match(terminal, /raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/install\.sh/);
  assert.match(terminal, /\.\/cao\.sh setup-auth workflow-token/);
  assert.match(terminal, /\.\/cao\.sh add githubnext\/gh-aw-cao\/dependabot/);
  assert.match(terminal, /--raw-field target_repo="acme\/example-service"/);
  assert.match(terminal, /--raw-field safe_output_mode="review"/);
  assert.match(hero, /See every campaign\. Focus where it diverges/);
  assert.match(hero, /Prove value before multiplying work/);
  assert.doesNotMatch(hero, /One operating picture|phone-caption/);
  assert.doesNotMatch(hero, /OpsWizard|Stand up a control plane in three steps/);
  assert.doesNotMatch(hero, /trust-section|Coordination without concentrated risk|section-actions/);
  assert.doesNotMatch(`${landingPage}\n${hero}`, /\bfactor(?:y|ies)\b/i);
  assert.doesNotMatch(`${landingPage}\n${hero}`, /\bfleets?\b/i);
});

test("setup wizard lives on a dedicated page linked from the header", () => {
  assert.match(headerLinks, /\{ label: "Setup", href: "\/gh-aw-cao\/setup\/" \}/);
  assert.match(setupPage, /<OpsWizard open \/>/);
  assert.match(setupPage, /Stand up a control plane in three steps/);
  assert.match(wizard, /Choose the first operation/);
});

test("landing page uses a theme-aware blueprint background", () => {
  assert.match(hero, /--cao-page-grid-minor: rgba\(26, 127, 55,/);
  assert.match(hero, /--cao-page-grid-major: rgba\(26, 127, 55,/);
  assert.match(hero, /:global\(:root\[data-theme="dark"\] \.content-panel:has\(\.hierarchy-hero\)\)/);
  assert.match(hero, /--cao-page-grid-minor: rgba\(63, 185, 80,/);
  assert.match(hero, /--cao-page-grid-major: rgba\(63, 185, 80,/);
  assert.match(hero, /--cao-story-text: #4d5560/);
  assert.match(hero, /--cao-story-text: #b1bac4/);
  assert.match(hero, /--cao-section-accent-start: 12%/);
  assert.match(hero, /--cao-section-accent-start: 16%/);
  assert.match(hero, /--cao-page-grid-major: rgba\(63, 185, 80, 0\.22\)/);
  assert.match(hero, /--cao-page-glow: rgba\(63, 185, 80, 0\.22\)/);
  assert.match(hero, /radial-gradient\(ellipse 58rem 42rem at 76% 8%/);
  assert.match(hero, /:global\(:root\[data-theme="dark"\]\) \.product-story::before \{[\s\S]*?display: none/);
  assert.match(hero, /background: var\(--section-accent\)/);
  assert.match(hero, /\.section-eyebrow::before \{[\s\S]*?border-radius: 1px/);
  assert.doesNotMatch(hero, /--section-accent: #(?:58a6ff|a371f7)/);
  assert.doesNotMatch(hero, /--cao-page-blue-glow/);
  assert.match(hero, /background-size: auto, auto, 160px 160px, 160px 160px, 32px 32px, 32px 32px/);
  assert.match(hero, /linear-gradient\(var\(--cao-page-grid-major\) 1px, transparent 1px\)/);
  assert.match(hero, /linear-gradient\(var\(--cao-page-grid-minor\) 1px, transparent 1px\)/);
});

test("landing product name uses an accessible GitHub-style cursor typing animation", () => {
  assert.match(heroIntro, /class="product-name" aria-label=\{data\.title\}/);
  assert.match(heroIntro, /font-family: "Mona Sans Mono", monospace/);
  assert.match(heroIntro, /font-weight: 600/);
  assert.match(heroIntro, /color: var\(--cao-product-label\)/);
  assert.match(hero, /--cao-product-label: #59636e/);
  assert.match(hero, /--cao-product-label: #a4aea6/);
  assert.match(heroIntro, /class="product-name-cursor"/);
  assert.match(heroIntro, /width: 9px/);
  assert.match(heroIntro, /height: 14px/);
  assert.match(heroIntro, /background: #5fed83/);
  assert.match(heroIntro, /const TYPE_DELAY_MS = 900/);
  assert.match(heroIntro, /const CHARACTER_INTERVAL_MS = 32/);
  assert.match(heroIntro, /const TRANSIENT_GLYPHS = \["\*", "_", ""\]/);
  assert.match(heroIntro, /cursor\?\.classList\.add\("is-animated"\)/);
  assert.match(heroIntro, /@keyframes product-name-cursor-blink/);
  assert.match(heroIntro, /@media \(prefers-reduced-motion: reduce\)/);
});

test("landing terminal uses accessible CSS motion without a JavaScript player", () => {
  assert.doesNotMatch(terminal, /<script>|lottie/i);
  assert.match(terminal, /animation: terminal-line-enter/);
  assert.match(terminal, /@keyframes terminal-line-enter/);
  assert.match(terminal, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(terminal, /animation: none/);
  assert.match(terminal, /--terminal-bg: #ffffff/);
  assert.match(terminal, /:global\(:root\[data-theme="dark"\]\) \.terminal/);
  assert.match(terminal, /--terminal-bg: #0d1117/);
  assert.match(terminal, /background: var\(--terminal-bg\)/);
});

test("landing wizard prompt references the raw setup skill", () => {
  assert.match(
    wizard,
    /https:\/\/raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/skills\/setup-cao\/SKILL\.md/,
  );
});

test("landing wizard delegates setup decisions to the setup skill", () => {
  assert.doesNotMatch(wizard, /buildWizardPolicy|CATALOG_REF = "main"/);
  assert.doesNotMatch(wizard, /Set `engine:|gh aw add .*@main/);
  assert.match(wizard, /Ask me to choose the exact repository for the first review run/);
  assert.match(wizard, /Ask separately whether I also want to create a custom campaign/);
  assert.match(wizard, /Use the CAO installer and repository-local `\.\/cao\.sh` commands required by the setup skill/);
});

test("landing wizard operations come from the checked-in control policy", () => {
  assert.match(catalog, /import controlPolicy from "\.\.\/\.\.\/\.github\/workflows\/cao\.json"/);
  assert.match(catalog, /\.experimental\/\*\/aw\.\{yml,yaml\}/);
  assert.match(catalog, /export const catalogEntries = campaignEntries\s+\.filter\(\(entry\) => !entry\.private\)/);
  assert.match(catalog, /selectConfiguredOperations\(controlPolicy, campaignEntries\)/);
  assert.match(wizard, /configuredOperationEntries as operations/);
  assert.doesNotMatch(wizard, /operation\.slug === "dependabot"/);
});

test("configured wizard operations follow policy campaign order", () => {
  const first = { slug: "first" };
  const second = { slug: "second" };
  const policy = { "control-plane": { campaigns: { second: {}, first: {} } } };

  assert.deepEqual(selectConfiguredOperations(policy, [first, second]), [second, first]);
});

test("configured wizard operations require a campaign map", () => {
  assert.throws(
    () => selectConfiguredOperations({}, []),
    /must define control-plane\.campaigns as an object/,
  );
});

test("configured wizard operations require a matching catalog manifest", () => {
  const policy = { "control-plane": { campaigns: { missing: {} } } };

  assert.throws(
    () => selectConfiguredOperations(policy, []),
    /Configured campaign missing must have a catalog manifest/,
  );
});

test("configured wizard operations exclude private campaigns", () => {
  const first = { slug: "first" };
  const privateCampaign = { slug: "private", private: true };
  const policy = { "control-plane": { campaigns: { private: {}, first: {} } } };

  assert.deepEqual(selectConfiguredOperations(policy, [first, privateCampaign]), [first]);
});

test("configured wizard operations exclude builtin campaigns", () => {
  const first = { slug: "first" };
  const builtinCampaign = { slug: "builtin", builtin: true };
  const policy = { "control-plane": { campaigns: { builtin: {}, first: {} } } };

  assert.deepEqual(selectConfiguredOperations(policy, [first, builtinCampaign]), [first]);
});

test("wizard policy keeps the checked-in campaign configuration", () => {
  const policy = buildWizardPolicy(controlPolicy, "acme", "dependabot");
  const { icon, ...expectedCampaign } = controlPolicy["control-plane"].campaigns.dependabot;

  assert.deepEqual(policy["control-plane"].scope["allowed-owners"], ["acme"]);
  assert.deepEqual(policy["control-plane"].campaigns.dependabot, expectedCampaign);
  assert.equal(icon, "dependabot");
});

test("wizard composes app target and Redis provider modules", () => {
  const host = buildWizardHost("container", "upstash");
  const policy = buildWizardPolicy(controlPolicy, "acme", "dependabot", host);

  assert.deepEqual(policy["control-plane"].web.host, {
    target: { module: "container", replicas: 1 },
    redis: {
      module: "upstash",
      "namespace-env": "REDIS_NAMESPACE",
      tls: { mode: "required" },
    },
  });
  assert.equal(buildWizardHost("none", "generic"), undefined);
  assert.throws(
    () => buildWizardHost("azure-functions", "upstash"),
    /Upstash requires the container app target/,
  );
  assert.deepEqual(buildWizardHost("azure-functions", "redis-cloud").redis, {
    module: "redis-cloud",
    "namespace-env": "CAO_REDIS_NAMESPACE",
    "url-env": "CAO_REDIS_URL",
    tls: { mode: "required" },
  });
  assert.deepEqual(buildWizardHost("container", "render").redis, {
    module: "render",
    "namespace-env": "REDIS_NAMESPACE",
    tls: { mode: "auto" },
    "allow-private-plaintext": true,
  });
  assert.deepEqual(buildWizardHost("azure-functions", "render").redis, {
    module: "render",
    "namespace-env": "CAO_REDIS_NAMESPACE",
    "url-env": "CAO_REDIS_URL",
    tls: { mode: "required" },
  });
});