export const profiles = [
  {
    id: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    lighthouse: ['--preset=desktop']
  },
  {
    id: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    lighthouse: [
      '--screenEmulation.mobile=true',
      '--screenEmulation.width=390',
      '--screenEmulation.height=844',
      '--screenEmulation.deviceScaleFactor=3'
    ]
  },
  {
    id: 'low-bandwidth',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    network: {
      latency: 400,
      downloadThroughput: 400 * 1024 / 8,
      uploadThroughput: 100 * 1024 / 8
    },
    cpuSlowdownMultiplier: 4,
    lighthouse: [
      '--screenEmulation.mobile=true',
      '--screenEmulation.width=390',
      '--screenEmulation.height=844',
      '--screenEmulation.deviceScaleFactor=3',
      '--throttling-method=simulate',
      '--throttling.rttMs=400',
      '--throttling.throughputKbps=400',
      '--throttling.cpuSlowdownMultiplier=4'
    ]
  }
];

/**
 * @param {unknown} dashboard
 * @returns {string[]}
 */
export function dashboardPageIds(dashboard) {
  const pages = /** @type {{ dashboard?: { pages?: Array<{ id?: unknown }> } }} */ (dashboard)?.dashboard?.pages;
  if (!Array.isArray(pages)) throw new Error('dashboard.json does not declare dashboard.pages');
  /** @type {string[]} */
  const ids = [];
  for (const page of pages) {
    if (typeof page.id !== 'string' || page.id.length === 0) {
      throw new Error('dashboard.json contains missing or duplicate page ids');
    }
    ids.push(page.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('dashboard.json contains missing or duplicate page ids');
  }
  return ids;
}

/**
 * @param {string} siteUrl
 * @param {string} pageId
 */
export function routeUrl(siteUrl, pageId) {
  const url = new URL(siteUrl);
  url.hash = `page-${encodeURIComponent(pageId)}`;
  return url.href;
}

/**
 * @param {string} lighthouseCli
 * @param {string} url
 * @param {string} outputPath
 * @param {{ lighthouse: string[] }} profile
 */
export function lighthouseArguments(lighthouseCli, url, outputPath, profile) {
  return [
    lighthouseCli,
    url,
    '--quiet',
    '--only-categories=performance',
    '--output=json',
    `--output-path=${outputPath}`,
    '--disable-full-page-screenshot',
    '--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage',
    ...profile.lighthouse
  ];
}
