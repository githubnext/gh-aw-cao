import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { buildDashboardSite } from '../../dashboard/site/scripts/build.mjs'

function localDependencies(source) {
  const dependencies = []
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+)["'](\.{1,2}\/[^"']+)["']|new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g
  for (const match of source.matchAll(pattern))
    dependencies.push(match[1] ?? match[2])
  return dependencies
}

test('docs dashboard installs renderer assets and configured package pages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dashboard-site-build-'))
  const destination = pathToFileURL(`${root}/cao/`)
  const controlSettings = {
    web: { favicon: 'https://example.com/dashboard.svg' },
    packages: { 'uk-ai-advisory': {}, dependabot: {} },
  }

  try {
    await buildDashboardSite({ destination, controlSettings })
    const dashboard = JSON.parse(
      await readFile(new URL('dashboard.json', destination), 'utf8'),
    )
    const pageIds = dashboard.dashboard.pages.map(({ id }) => id)
    assert.ok(pageIds.includes('uk-ai-advisory-dashboard'))
    assert.ok(pageIds.includes('dependabot-dashboard'))
    assert.ok(!pageIds.includes('ambient-context-dashboard'))
    assert.match(
      await readFile(new URL('index.html', destination), 'utf8'),
      /<link rel="icon" href="https:\/\/example\.com\/dashboard\.svg">/,
    )
    for (const pageId of ['uk-ai-advisory-dashboard', 'dependabot-dashboard']) {
      assert.match(
        await readFile(new URL(`${pageId}/index.html`, destination), 'utf8'),
        new RegExp(`#page-${pageId}`),
      )
    }

    const manifest = parse(
      await readFile(
        new URL('../../dashboard/aw.yml', import.meta.url),
        'utf8',
      ),
    )
    const installedSitePrefix = '.github/aw/dashboard/site/'
    for (const resource of manifest.resources.filter(
      ({ destination: resourcePath }) =>
        resourcePath.startsWith(installedSitePrefix),
    )) {
      await access(
        new URL(
          resource.destination.slice(installedSitePrefix.length),
          destination,
        ),
      )
    }
    await assert.rejects(
      readFile(new URL('README.md', destination), 'utf8'),
      (error) => error?.code === 'ENOENT',
      'build copied a dashboard source that gh aw add would not install',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dashboard package includes every transitive site module and asset', async () => {
  const dashboardRoot = new URL('../../dashboard/', import.meta.url)
  const manifest = parse(
    await readFile(new URL('aw.yml', dashboardRoot), 'utf8'),
  )
  const packaged = new Set(manifest.resources.map(({ source }) => source))
  const pending = [...packaged].filter(
    (source) => source.startsWith('site/') && source.endsWith('.js'),
  )
  const visited = new Set()

  while (pending.length > 0) {
    const source = pending.pop()
    if (visited.has(source)) continue
    visited.add(source)
    const contents = await readFile(new URL(source, dashboardRoot), 'utf8')
    for (const dependency of localDependencies(contents)) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(source), dependency),
      )
      assert.ok(
        packaged.has(resolved),
        `${source} depends on unpackaged dashboard resource ${resolved}`,
      )
      if (resolved.endsWith('.js')) pending.push(resolved)
    }
  }
})
