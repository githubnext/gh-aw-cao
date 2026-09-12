import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildWizardPolicy, selectConfiguredOperations } from "../../docs/lib/configured-operations.mjs";

const controlPolicy = JSON.parse(readFileSync(".github/workflows/cao.json", "utf8"));

const hero = readFileSync("docs/components/HierarchyHero.astro", "utf8");
const wizard = readFileSync("docs/components/OpsWizard.astro", "utf8");
const catalog = readFileSync("docs/lib/catalog.ts", "utf8");
const packageManifest = readFileSync("package.json", "utf8");
const sparklePathData = "M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.492 7.492 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.492 7.492 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.492 7.492 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.492 7.492 0 0 0 4.464-4.464Z";

function withoutRootPalette(svg) {
  return svg.replace(/:root \{[^}]+\}/, ":root {}");
}

test("landing diagram fallbacks use concrete light and dark palettes", () => {
  for (const layout of ["fallback", "mobile"]) {
    const light = readFileSync(`docs/assets/control-plane-dispatch-${layout}.svg`, "utf8");
    const dark = readFileSync(`docs/assets/control-plane-dispatch-${layout}-dark-mode.svg`, "utf8");

    assert.doesNotMatch(light, /prefers-color-scheme/);
    assert.doesNotMatch(dark, /prefers-color-scheme/);
    assert.match(light, /--surface:#fff;/);
    assert.match(dark, /--surface:#161b22;/);
    assert.match(dark, /--foreground:#f0f6fc;/);
    for (const label of ["Supply chain", "Compliance", "Security", "Governance"]) {
      assert.match(light, new RegExp(label.replace(" ", "\\s+")));
      assert.match(dark, new RegExp(label.replace(" ", "\\s+")));
    }
    assert.equal(withoutRootPalette(light), withoutRootPalette(dark));
  }

  assert.equal((hero.match(/class="[^"]*theme-light/g) ?? []).length, 2);
  assert.equal((hero.match(/class="[^"]*theme-dark/g) ?? []).length, 2);
  assert.match(hero, /:global\(:root\[data-theme="light"\]\) \.theme-dark/);
});

test("landing animations use SVG and CSS without a JavaScript player", () => {
  assert.doesNotMatch(hero, /<script>|lottie/i);
  assert.doesNotMatch(packageManifest, /lottie-web/);
  assert.match(hero, /control-plane-dispatch-motion\.svg/);
  assert.match(hero, /control-plane-dispatch-mobile-motion\.svg/);
  assert.match(hero, /@media \(prefers-reduced-motion: reduce\) \{\s+\.dispatch-motion \{\s+display: none;/);

  for (const layout of ["", "-mobile"]) {
    const motion = readFileSync(`docs/assets/control-plane-dispatch${layout}-motion.svg`, "utf8");

    assert.match(motion, /@keyframes dispatch/);
    assert.match(motion, /offset-path: var\(--path\)/);
    assert.match(motion, /prefers-color-scheme: dark/);
    assert.match(motion, /prefers-reduced-motion: reduce/);
    assert.match(motion, /\.report-update \{\s+display: none;/);
    assert.equal((motion.match(/class="sparkle"/g) ?? []).length, 28);
    assert.equal(motion.split(`d="${sparklePathData}"`).length - 1, 28);
    assert.equal((motion.match(/class="package-status"/g) ?? []).length, 4);
    assert.match(motion, /class="report-update"/);
  }
});

test("landing wizard prompt references the raw setup skill", () => {
  assert.match(
    wizard,
    /https:\/\/raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/\.github\/skills\/setup-central-agentic-ops\/SKILL\.md/,
  );
});

test("landing wizard client imports its prompt generation dependencies", () => {
  assert.equal(
    wizard.match(/import controlPolicy from "\.\.\/\.\.\/\.github\/workflows\/cao\.json";/g)?.length,
    2,
  );
  assert.equal(
    wizard.match(/import \{ buildWizardPolicy \} from "\.\.\/lib\/configured-operations\.mjs";/g)?.length,
    2,
  );
});

test("landing wizard operations come from the checked-in control policy", () => {
  assert.match(catalog, /import controlPolicy from "\.\.\/\.\.\/\.github\/workflows\/cao\.json"/);
  assert.match(catalog, /selectConfiguredOperations\(controlPolicy, catalogEntries\)/);
  assert.match(wizard, /configuredOperationEntries as operations/);
  assert.doesNotMatch(wizard, /operation\.slug === "dependabot"/);
});

test("configured wizard operations follow policy package order", () => {
  const first = { slug: "first" };
  const second = { slug: "second" };
  const policy = { "control-plane": { packages: { second: {}, first: {} } } };

  assert.deepEqual(selectConfiguredOperations(policy, [first, second]), [second, first]);
});

test("configured wizard operations hide experimental packages by default", () => {
  const stable = { slug: "stable", experimental: false };
  const experimental = { slug: "preview", experimental: true };
  const disabledPolicy = { "control-plane": { packages: { stable: {}, preview: {} } } };
  const enabledPolicy = { ...disabledPolicy, experimental: true };

  assert.deepEqual(selectConfiguredOperations(disabledPolicy, [stable, experimental]), [stable]);
  assert.deepEqual(selectConfiguredOperations(enabledPolicy, [stable, experimental]), [stable, experimental]);
});

test("configured wizard operations require a package map", () => {
  assert.throws(
    () => selectConfiguredOperations({}, []),
    /must define control-plane\.packages as an object/,
  );
});

test("configured wizard operations require a matching catalog manifest", () => {
  const policy = { "control-plane": { packages: { missing: {} } } };

  assert.throws(
    () => selectConfiguredOperations(policy, []),
    /Configured package missing must have a catalog manifest/,
  );
});

test("configured wizard operations exclude the repository-local self-care package", () => {
  const first = { slug: "first" };
  const selfCare = { slug: "self-care" };
  const policy = { "control-plane": { packages: { "self-care": {}, first: {} } } };

  assert.deepEqual(selectConfiguredOperations(policy, [first, selfCare]), [first]);
});

test("wizard policy keeps the checked-in package configuration", () => {
  const policy = buildWizardPolicy(controlPolicy, "acme", "dependabot");
  const { icon, ...expectedPackage } = controlPolicy["control-plane"].packages.dependabot;

  assert.deepEqual(policy["control-plane"].scope["allowed-owners"], ["acme"]);
  assert.equal(policy.experimental, true);
  assert.deepEqual(policy["control-plane"].packages.dependabot, expectedPackage);
  assert.equal(icon, "dependabot");
});