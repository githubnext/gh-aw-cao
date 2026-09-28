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
const illustration = readFileSync("docs/components/DispatchIllustration.astro", "utf8");
const terminal = readFileSync("docs/components/TerminalDemo.astro", "utf8");
const terminalText = terminal.replaceAll(/<[^>]+>/g, "");
const wizard = readFileSync("docs/components/OpsWizard.astro", "utf8");
const setupPage = readFileSync("docs/pages/setup.astro", "utf8");
const headerLinks = readFileSync("docs/components/HeaderLinks.astro", "utf8");
const catalog = readFileSync("docs/lib/catalog.ts", "utf8");

test("landing page presents the product through real operational surfaces", () => {
  assert.match(landingPage, /text: Explore CAO[\s\S]*?link: \/gh-aw-cao\/architecture-at-a-glance\//);
  assert.match(landingPage, /text: Get started[\s\S]*?link: \/gh-aw-cao\/setup-quickstarts\//);
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
  assert.match(terminalText, /raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/install\.sh/);
  assert.match(terminalText, /\.\/cao\.sh setup/);
  assert.match(terminalText, /\.\/cao\.sh add githubnext\/gh-aw-cao\/CAMPAIGN/);
  assert.match(terminalText, /target_repo="OWNER\/TARGET_REPOSITORY"/);
  assert.match(terminalText, /--raw-field safe_output_mode="review"/);
  assert.match(hero, /See every campaign\. Focus where it diverges/);
  assert.match(hero, /Prove value before multiplying work/);
  assert.match(hero, /class="wizard-launch-button" href="\/gh-aw-cao\/setup\/"/);
  assert.match(hero, /Launch setup wizard/);
  assert.doesNotMatch(hero, /One operating picture|phone-caption/);
  assert.doesNotMatch(hero, /OpsWizard|Stand up a control plane in three steps/);
  assert.doesNotMatch(hero, /trust-section|Coordination without concentrated risk|section-actions/);
  assert.doesNotMatch(`${landingPage}\n${hero}`, /\bfactor(?:y|ies)\b/i);
  assert.doesNotMatch(`${landingPage}\n${hero}`, /\bfleets?\b/i);
});

test("landing page explains and illustrates campaign dispatch", () => {
  assert.match(hero, /One goal, many repositories/);
  assert.match(hero, /Agentic Campaigns dispatch work at scale\./);
  assert.match(hero, /\.dispatch-story \{[\s\S]*?width: min\(calc\(100% - 2rem\), 86rem\)/);
  assert.match(hero, /\.dispatch-story > \.section-eyebrow \{[\s\S]*?justify-self: center/);
  assert.match(hero, /\.dispatch-story > p:not\(\.section-eyebrow\) \{[\s\S]*?max-width: 64rem/);
  assert.match(hero, /@media \(min-width: 64rem\) \{[\s\S]*?\.dispatch-story h2 \{[\s\S]*?white-space: nowrap/);
  assert.match(
    hero,
    /Each campaign turns a defined operation into bounded work across an explicitly enrolled set of repositories\./,
  );
  assert.match(hero, /A\s+dispatcher resolves reviewed rollout policy/);
  assert.match(hero, /namespaced workers in parallel—one authorized target\s+per worker, across organizations/);
  assert.match(hero, /centralized scale and a shared operating rhythm without giving any\s+worker open-ended repository reach/);
  assert.match(hero, /<DispatchIllustration \/>/);
  assert.match(hero, /aria-describedby="dispatch-description"/);
  assert.doesNotMatch(illustration, /cao-dashboard-campaign/);
  assert.match(illustration, /Central Agentic Ops \(CAO\)/);
  assert.match(illustration, /<small>Control plane<\/small>/);
  assert.match(illustration, /class="campaign-cue"/);
  assert.match(illustration, /Configured campaigns/);
  assert.match(illustration, /<strong>Dependabot<\/strong>/);
  assert.match(illustration, /<strong>Repo Assist<\/strong>/);
  assert.match(illustration, /const goalPaths = \[/);
  assert.match(illustration, /M13\.637 2\.363h-\.001l1\.676\.335/);
  assert.match(illustration, /\{goalPaths\.map\(\(path\) => <path d=\{path\}><\/path>\)\}/);
  assert.match(illustration, /GitHub Actions/);
  assert.ok(
    illustration.indexOf("<h3>GitHub Actions</h3>") < illustration.indexOf("<h3>Organizations</h3>") &&
      illustration.indexOf("<h3>Organizations</h3>") <
        illustration.indexOf("<h3>Target Repositories</h3>"),
  );
  assert.match(illustration, /const organizationNodes = \[/);
  assert.match(illustration, /const successfulJobs = jobs\.filter\(\(job\) => !job\.failed\)/);
  assert.match(illustration, /const controlRepository = successfulJobs\.find/);
  assert.match(illustration, /const targetJobs = \[\.\.\.successfulJobs\]\.sort\(\(left, right\) => left\.targetRow - right\.targetRow\)/);
  assert.doesNotMatch(illustration, /organizationJobs|node\.campaigns|node\.repositories/);
  assert.match(illustration, /class="organization-node" style={`top: \$\{node\.top\}px`}/);
  assert.match(illustration, /<svg class="graph-routes" viewBox="0 0 82 488"/);
  assert.match(illustration, /<animateMotion/);
  assert.match(illustration, /keyPoints="0;0;0;1;1;1"/);
  assert.match(illustration, /class="node-continuation"/);
  assert.match(illustration, /class="node-continuation node-continuation-no-icon">\s*<b>•••<\/b>\s*<small>more organizations<\/small>/);
  assert.match(illustration, /<small>more organizations<\/small>/);
  assert.match(illustration, /<small>more repositories<\/small>/);
  assert.match(illustration, /path=\{job\.organizationPath\}/);
  assert.match(illustration, /path=\{job\.repositoryPath\}/);
  assert.match(illustration, /\{ organization: "githubnext", top: 146 \}/);
  assert.match(illustration, /\{ organization: "github", top: 318 \}/);
  assert.match(illustration, /organizationPath: "M0 100 H41 V344 H82"/);
  assert.match(illustration, /organizationPath: "M0 308 H41 V344 H82"/);
  assert.match(illustration, /organizationPath: "M0 172 H82"/);
  assert.match(illustration, /repositoryPath: "M0 172 H41 V100 H82"/);
  assert.match(illustration, /repositoryPath: "M0 172 H82"/);
  assert.match(illustration, /repositoryPath: "M0 344 H41 V308 H82"/);
  assert.match(illustration, /repositoryPath: "M0 344 H41 V380 H82"/);
  assert.match(illustration, /class="graph-junction" cx="41" cy="172"/);
  assert.match(illustration, /class="graph-junction" cx="41" cy="344"/);
  assert.doesNotMatch(illustration, /CAO review queue/);
  assert.match(illustration, /graph-route-dot review/);
  assert.doesNotMatch(illustration, /class="control-repository-card"/);
  assert.match(illustration, /<small>CAO control plane<\/small>/);
  assert.doesNotMatch(illustration, /review output · CAO control repository|<small>live rollout/);
  assert.match(illustration, /targetRow: 2,[\s\S]*?repository: "githubnext\/gh-aw-cao"|repository: "githubnext\/gh-aw-cao"[\s\S]*?targetRow: 2/);
  assert.match(illustration, /\{jobs\.map\(\(job\) => \(/);
  assert.match(illustration, /\{targetJobs\.map\(\(job\) => \(/);
  assert.match(illustration, /class={`repository-card \$\{job\.timing\} \$\{job\.mode\}`}/);
  assert.match(illustration, /style={`grid-row: \$\{job\.targetRow\}`}/);
  assert.match(illustration, /--review: #0969da/);
  assert.match(illustration, /--review: #58a6ff/);
  assert.match(illustration, /class={`mobile-pair-route \$\{job\.timing\} \$\{job\.mode\} \$\{job\.failed \? "failed" : ""\}`}/);
  assert.match(illustration, /class={`mobile-repository-card \$\{job\.mode\}`}/);
  assert.match(illustration, /\{!job\.failed && <i><\/i>\}/);
  assert.match(illustration, /<strong>No output dispatched<\/strong>/);
  assert.match(illustration, /\.organization-icon,[\s\S]*?\.repository-icon \{[\s\S]*?width: 16px;[\s\S]*?height: 16px/);
  assert.match(illustration, /class="organization-icon"/);
  assert.match(illustration, /\.organization-icon \{[\s\S]*?fill: var\(--muted\)/);
  assert.match(illustration, /class="repo-icon repository-icon"/);
  assert.match(illustration, /\.repository-card \{[\s\S]*?border-top: 1px solid var\(--line\)/);
  assert.match(illustration, /\.repository-card\.review \{[\s\S]*?border-color: color-mix[\s\S]*?background: color-mix/);
  assert.match(illustration, /\.repository-card\.review \.repository-icon \{[\s\S]*?fill: var\(--review\)/);
  assert.match(illustration, /class="mobile-scale-cue"/);
  assert.match(illustration, /More organizations and repositories/);
  assert.match(illustration, /The bounded dispatch pattern continues\./);
  assert.match(
    illustration,
    /grid-template-columns: minmax\(520px, 740px\) 72px 150px 72px 220px/,
  );
  assert.match(illustration, /width: min\(100%, 1270px\)/);
  assert.match(illustration, /text-align: left/);
  assert.match(illustration, /class="actions-column cao-surface"/);
  assert.match(illustration, /class="organizations-column"/);
  assert.match(illustration, /class="repositories-column"/);
  assert.doesNotMatch(illustration, /class="(?:organizations|repositories)-column cao-surface"/);
  assert.doesNotMatch(illustration, /dashboard-column|dashboard-route|route-dashboard/);
  assert.match(illustration, /\.cao-surface \{[\s\S]*?border: 1px solid var\(--line\)/);
  assert.match(illustration, /\.control-plane \{\s*overflow: visible;/);
  assert.match(illustration, /const campaigns = \[/);
  assert.match(illustration, /organizations: \["githubnext", "github"\]/);
  assert.match(illustration, /jobs: \[jobs\[1\], jobs\[0\]\]/);
  assert.match(illustration, /jobs: \[jobs\[3\], jobs\[4\], jobs\[2\]\]/);
  assert.match(illustration, /class="mobile-flow"/);
  assert.match(illustration, /class="mobile-campaign"/);
  assert.match(illustration, /class="mobile-workers"/);
  assert.match(illustration, /Parallel workers/);
  assert.match(illustration, /class="mobile-dispatch-pair"/);
  assert.match(illustration, /class={`mobile-pair-route \$\{job\.timing\} \$\{job\.mode\} \$\{job\.failed \? "failed" : ""\}`}/);
  assert.match(illustration, /@keyframes mobile-route-job-1/);
  assert.match(illustration, /@keyframes mobile-route-job-5/);
  assert.match(
    illustration,
    /@media \(max-width: 1180px\) \{[\s\S]*?\.flow-layout \{[\s\S]*?display: none[\s\S]*?\.mobile-flow \{[\s\S]*?display: block/,
  );
  assert.match(hero, /width: min\(100%, 80rem\)/);
  assert.match(illustration, /operation: "Dependabot update planner"/);
  assert.match(illustration, /workflow: "Dependabot \/ Update Planner"/);
  assert.match(illustration, /repository: "github\/gh-aw"/);
  assert.match(illustration, /operation: "Repo Assist issue triage"/);
  assert.match(illustration, /workflow: "Repo Assist \/ Issue Triage"/);
  assert.match(illustration, /operation: "Repo Assist issue fix"/);
  assert.match(illustration, /workflow: "Repo Assist \/ Issue Fix"/);
  assert.match(illustration, /operation: "Repo Assist maintenance"/);
  assert.match(illustration, /workflow: "Repo Assist \/ Maintenance"/);
  assert.match(illustration, /\{job\.operation\} · \{job\.repository\} · \{job\.mode\}/);
  assert.match(illustration, /class="run-card dispatcher dispatcher-dependabot"/);
  assert.match(illustration, /class="run-card dispatcher dispatcher-repo-assist"/);
  assert.match(illustration, /Campaign dispatcher/);
  assert.match(illustration, /class={`run-card worker \$\{job\.timing\}`}/);
  assert.match(illustration, /animation: spin/);
  assert.match(illustration, /class="status running action-progress"/);
  assert.match(illustration, /class="progress-track"/);
  assert.match(illustration, /class="progress-ring"/);
  assert.match(illustration, /class="progress-dot"/);
  assert.match(illustration, /stroke-dasharray: 22 18/);
  assert.match(illustration, /M8 0a8 8 0 1 1 0 16/);
  assert.match(illustration, /repository: "github\/gh-aw-firewall"/);
  assert.match(illustration, /repository: "githubnext\/gh-aw-cao"/);
  assert.match(illustration, /repository: "githubnext\/agentics"/);
  assert.match(illustration, /failed: true/);
  assert.match(illustration, /repository: "githubnext\/gh-aw"/);
  assert.match(illustration, /organizations: \["githubnext", "github"\]/);
  assert.match(illustration, /class="mobile-campaign-organizations"/);
  assert.match(illustration, /<em>\+ others<\/em>/);
  assert.match(illustration, /class="branch">main<\/span>/);
  assert.match(illustration, /class="run-age"/);
  assert.match(illustration, /class="run-meta"/);
  assert.doesNotMatch(illustration, /class="run-menu"/);
  assert.match(illustration, /In progress/);
  assert.match(illustration, /\{job\.failed \? "Failed" : "Done"\} · \{job\.duration\}/);
  assert.match(illustration, /M2\.343 13\.657A8 8 0 1 1/);
  assert.match(illustration, /@keyframes dep-dispatch-running/);
  assert.match(illustration, /@keyframes repo-dispatch-running/);
  assert.match(illustration, /@keyframes job-1-running/);
  assert.match(illustration, /@keyframes job-5-running/);
  assert.match(illustration, /grid-template-rows: 64px 72px 72px 0 64px 72px 72px 72px/);
  assert.match(illustration, /\.execution-grid \.dispatcher-repo-assist \{\s*transform: translateY\(-4px\)/);
  assert.doesNotMatch(illustration, /\.execution-grid \.dispatcher-repo-assist \{[\s\S]*?border-bottom-color:/);
  assert.match(illustration, /\.run-card\.job-5 \{[\s\S]*?translateY\(4px\)/);
  assert.doesNotMatch(illustration, /\.repository-card\.job-5 \{[\s\S]*?translateY\(4px\)/);
  assert.match(illustration, /\.actions-column \{[\s\S]*?align-self: start/);
  assert.match(illustration, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(
    illustration,
    /\.dispatch-illustration \*,[\s\S]*?\.dispatch-illustration \*::before,[\s\S]*?\.dispatch-illustration \*::after \{[\s\S]*?animation: none/,
  );
  assert.match(illustration, /\.status\.complete \{[\s\S]*?opacity: 1 !important/);
});

test("setup wizard remains available alongside the command quickstart", () => {
  assert.match(headerLinks, /\{ label: "Setup", href: "\/gh-aw-cao\/setup\/" \}/);
  assert.match(setupPage, /<OpsWizard \/>/);
  assert.match(wizard, /Plan a control plane and first campaign in four steps/);
  assert.match(wizard, /skills\/setup-cao\/SKILL\.md/);
  assert.match(wizard, /skills\/add-cao-campaign\/SKILL\.md/);
  assert.match(wizard, /bare control plane/);
  assert.doesNotMatch(wizard, /<select/);
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
  assert.match(terminal, /class="syntax-command"/);
  assert.match(terminal, /class="syntax-option"/);
  assert.match(terminal, /class="syntax-string"/);
  assert.match(terminal, /class="syntax-placeholder"/);
  assert.match(terminal, /--terminal-syntax-placeholder: #953800/);
  assert.match(terminal, /--terminal-syntax-placeholder: #ffa657/);
});

test("landing wizard operations come from the checked-in control policy", () => {
  assert.match(catalog, /import controlPolicy from "\.\.\/\.\.\/\.github\/workflows\/cao\.json"/);
  assert.match(catalog, /\.experimental\/\*\/aw\.\{yml,yaml\}/);
  assert.match(catalog, /export const catalogEntries = campaignEntries\s+\.filter\(\(entry\) => !entry\.private\)/);
  assert.match(catalog, /selectConfiguredOperations\(controlPolicy, campaignEntries\)/);
  assert.match(wizard, /configuredOperationEntries as operations/);
});