import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import {
  dashboardPageIds,
  lighthouseArguments,
  profiles,
  routeUrl
} from './pages-health-config.js';

const siteRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lighthouseCli = join(siteRoot, 'node_modules', 'lighthouse', 'cli', 'index.js');
const defaultSiteUrl = 'https://githubnext.github.io/gh-aw-cao/cao/';
const defaultOutputRoot = resolve(siteRoot, 'test-results', 'pages-health');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function configureProfile(context, page, profile) {
  if (!profile.network && !profile.cpuSlowdownMultiplier) return;
  const session = await context.newCDPSession(page);
  if (profile.network) {
    await session.send('Network.enable');
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      ...profile.network,
      connectionType: 'cellular3g'
    });
  }
  if (profile.cpuSlowdownMultiplier) {
    await session.send('Emulation.setCPUThrottlingRate', {
      rate: profile.cpuSlowdownMultiplier
    });
  }
}

async function visitPage(browser, siteUrl, pageId, expectedViews, profile) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor
  });
  const page = await context.newPage();
  const errors = [];
  const visitedViews = [];

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ type: 'console', message: message.text() });
  });
  page.on('pageerror', (error) => errors.push({ type: 'page', message: error.message }));
  page.on('requestfailed', (request) => {
    errors.push({
      type: 'request',
      message: `${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push({ type: 'response', message: `${response.status()} ${response.url()}` });
    }
  });

  try {
    await configureProfile(context, page, profile);
    const url = routeUrl(siteUrl, pageId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const activePage = page.locator(`[data-page-id="${pageId}"]`);
    await activePage.waitFor({ state: 'visible', timeout: 30_000 });
    const sections = activePage.locator('.page-section');
    const sectionCount = await sections.count();
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sections.nth(index);
      await section.scrollIntoViewIfNeeded();
      visitedViews.push(await section.getAttribute('id') || `section-${index + 1}`);
      await page.waitForTimeout(50);
    }
    if (visitedViews.length < expectedViews.length) {
      throw new Error(`rendered ${visitedViews.length} sections for ${expectedViews.length} declared views`);
    }
    await page.evaluate(async () => {
      const root = document.scrollingElement;
      if (!root) return;
      const step = Math.max(window.innerHeight, 1);
      for (let top = 0; top < root.scrollHeight; top += step) {
        window.scrollTo(0, top);
        await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
      }
      window.scrollTo(0, root.scrollHeight);
    });
    return { pageId, url, visitedViews, errors, status: 'complete' };
  } catch (error) {
    return {
      pageId,
      url: routeUrl(siteUrl, pageId),
      visitedViews,
      errors,
      status: 'incomplete',
      blocker: errorText(error)
    };
  } finally {
    await context.close();
  }
}

function auditMetric(lhr, id) {
  const value = lhr.audits?.[id]?.numericValue;
  return typeof value === 'number' ? value : null;
}

async function auditPage(siteUrl, pageId, profile, directory, chromePath) {
  const outputPath = join(directory, 'lighthouse.report.json');
  const url = routeUrl(siteUrl, pageId);
  try {
    await run(process.execPath, lighthouseArguments(lighthouseCli, url, outputPath, profile), {
      env: { ...process.env, CHROME_PATH: chromePath }
    });
    const lhr = JSON.parse(await readFile(outputPath, 'utf8'));
    return {
      pageId,
      url,
      status: 'complete',
      score: lhr.categories?.performance?.score ?? null,
      metrics: {
        firstContentfulPaint: auditMetric(lhr, 'first-contentful-paint'),
        largestContentfulPaint: auditMetric(lhr, 'largest-contentful-paint'),
        cumulativeLayoutShift: auditMetric(lhr, 'cumulative-layout-shift'),
        speedIndex: auditMetric(lhr, 'speed-index'),
        totalBlockingTime: auditMetric(lhr, 'total-blocking-time')
      }
    };
  } catch (error) {
    return { pageId, url, status: 'incomplete', blocker: errorText(error) };
  }
}

async function loadDashboard(siteUrl) {
  const response = await fetch(new URL('dashboard.json', siteUrl));
  if (!response.ok) throw new Error(`dashboard.json returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const siteUrl = new URL(process.env.PAGES_HEALTH_URL || defaultSiteUrl).href;
  const outputRoot = resolve(process.env.PAGES_HEALTH_OUTPUT_DIR || defaultOutputRoot);
  await access(lighthouseCli);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });

  const dashboard = await loadDashboard(siteUrl);
  const pageIds = dashboardPageIds(dashboard);
  const declaredViews = Object.fromEntries(dashboard.dashboard.pages.map((page) => [
    page.id,
    Array.isArray(page.views)
      ? page.views.map((view, index) => view?.id || `view-${index + 1}`)
      : []
  ]));
  const chromePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  await access(chromePath);
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const results = [];

  try {
    for (const profile of profiles) {
      const profileResult = { id: profile.id, pages: [] };
      for (const pageId of pageIds) {
        const directory = join(outputRoot, profile.id, pageId);
        await mkdir(directory, { recursive: true });
        const navigation = await visitPage(
          browser,
          siteUrl,
          pageId,
          declaredViews[pageId],
          profile
        );
        const lighthouse = await auditPage(siteUrl, pageId, profile, directory, chromePath);
        profileResult.pages.push({ pageId, navigation, lighthouse });
      }
      results.push(profileResult);
    }
  } finally {
    await browser.close();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    siteUrl,
    declaredPages: pageIds,
    declaredViews,
    methodology: 'Every declared page and rendered view scrolled with Playwright; cold Lighthouse performance audit per page and profile',
    profiles: results
  };
  await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Pages health evidence: ${outputRoot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
