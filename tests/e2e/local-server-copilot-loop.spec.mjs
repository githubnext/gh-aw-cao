import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startDashboardServer } from '../../dashboard/local-server.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')

const packageDashboard = () =>
  JSON.stringify(
    {
      'language-version': '0.1.0',
      dashboard: {
        id: 'copilot-loop',
        title: 'Copilot loop',
        navigation: [{ label: 'Copilot loop', pages: ['copilot-loop'] }],
        pages: [
          {
            id: 'copilot-loop',
            title: 'Before Copilot',
            kind: 'custom',
            views: [
              {
                id: 'summary',
                title: 'Summary',
                mark: 'element',
                element: 'summary-grid',
                data: { sources: ['repositories'] },
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )

test('Copilot prompt saves a dashboard change, renders it, and correlates browser/server traces', async ({
  page,
}) => {
  const fixtureRoot = await mkdtemp(
    path.join(repositoryRoot, '.cao-dashboard-e2e-'),
  )
  const packageRoot = path.join(fixtureRoot, 'packages')
  const packageDirectory = path.join(packageRoot, 'copilot-loop')
  const dashboardPath = path.join(packageDirectory, 'dashboard.json')
  const tracePath = path.join(fixtureRoot, 'trace.jsonl')
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(dashboardPath, packageDashboard())
  const browserTraces = []
  page.on('console', (message) => {
    if (message.text().startsWith('[dashboard-trace]')) {
      browserTraces.push(message.text())
      console.log(message.text())
    }
  })
  page.on('pageerror', (error) =>
    console.log(`[browser-error] ${error.message}`),
  )

  let preview
  try {
    preview = await startDashboardServer({
      siteRoot: path.join(repositoryRoot, 'dashboard/site'),
      catalogRoot: packageRoot,
      installedDashboardsDirectory: path.join(fixtureRoot, 'installed'),
      downloadData: async (destination) => {
        await mkdir(destination, { recursive: true })
        await writeFile(
          path.join(destination, 'sources.json'),
          JSON.stringify({
            repositories: { source: 'repositories', rows: [] },
          }),
        )
      },
      copilot: true,
      createCopilotRuntime: async () => ({
        prompt: async ({ viewDashboardPath, onEvent }) => {
          const document = JSON.parse(await readFile(viewDashboardPath, 'utf8'))
          document.dashboard.pages[0].title = 'Updated by Copilot'
          onEvent({
            type: 'status',
            message: 'Checking the current dashboard…',
          })
          onEvent({
            type: 'tool-refused',
            message: 'Refused python3: shell command not allowed.',
            details: { tool: 'python3', reason: 'shell command not allowed' },
          })
          onEvent({
            type: 'reasoning-message',
            reasoningId: 'test-reasoning',
            content: 'The title should make the requested change easy to see.',
          })
          onEvent({
            type: 'assistant-message',
            content: 'Updated the active view title.',
          })
          await writeFile(viewDashboardPath, JSON.stringify(document, null, 2))
          return { aborted: false }
        },
        stop: async () => false,
        close: async () => {},
      }),
      traceFile: tracePath,
      workingDirectory: repositoryRoot,
      port: 0,
    })
    await page.goto(
      `${preview.url}/?local-preview=copilot&fixtures#page-copilot-loop`,
    )
    await expect(
      page.locator('[data-nav-page-id="copilot-loop"][aria-current="page"]'),
    ).toBeVisible()
    await expect(
      page.locator('.org-sidebar #dashboard-copilot-prompt'),
    ).toBeVisible()
    await expect(page.locator('#dashboard-copilot-title')).toHaveText('Copilot')
    await page
      .locator('#dashboard-copilot-request')
      .fill('Rename this active view')
    await page
      .locator('#dashboard-copilot-prompt')
      .evaluate((form) => form.requestSubmit())
    await expect(page.locator('#dashboard-copilot-request')).toHaveValue('')

    await expect(page.locator('#dashboard-copilot-status')).toHaveText(
      'Updated.',
    )
    await expect(
      page.locator('.dashboard-copilot-message-update'),
    ).toContainText('Checking the current dashboard')
    await expect(
      page.locator('.dashboard-copilot-message-refusal'),
    ).toContainText('Refused python3: shell command not allowed.')
    await expect(
      page.locator('.dashboard-copilot-message-reasoning'),
    ).toContainText('The title should make the requested change easy to see.')
    await expect(
      page.locator('.dashboard-copilot-message-response'),
    ).toContainText('Updated the active view title.')
    expect(
      await page
        .locator('.app-shell')
        .evaluate(
          (shell) => getComputedStyle(shell).gridTemplateColumns.split(' ')[0],
        ),
    ).toBe('420px')
    expect(
      await page
        .locator('.dashboard-copilot-conversation')
        .evaluate((conversation) =>
          Number.parseFloat(getComputedStyle(conversation).maxHeight),
        ),
    ).toBeGreaterThan(180)
    await expect(
      page.getByText('Updated by Copilot', { exact: true }).first(),
    ).toBeVisible()
    const nextView = page
      .locator('[data-nav-page-id]')
      .filter({ visible: true })
      .nth(1)
    await nextView.click()
    await expect(
      page.locator('.org-sidebar #dashboard-copilot-prompt'),
    ).toBeVisible()
    await expect
      .poll(async () => {
        const box = await page
          .locator('#dashboard-copilot-prompt')
          .boundingBox()
        return (
          box !== null &&
          box.y + box.height <= (await page.viewportSize()).height
        )
      })
      .toBe(true)
    expect(
      JSON.parse(await readFile(dashboardPath, 'utf8')).dashboard.pages[0]
        .title,
    ).toBe('Updated by Copilot')

    const activePageId = await page
      .locator('[data-nav-page-id][aria-current=page]')
      .getAttribute('data-nav-page-id')
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('dashboard-preview-update', {
          detail: {
            traceId: 'manual-render-failure',
            dashboard: {
              'language-version': '0.1.0',
              dashboard: null,
            },
          },
        }),
      )
    })
    await expect(
      page.locator('[data-nav-page-id][aria-current=page]'),
    ).toHaveAttribute('data-nav-page-id', activePageId)
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect
      .poll(async () => {
        const traces = (await readFile(tracePath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        return traces.find(
          ({ event, traceId }) =>
            event === 'preview.render.failed' &&
            traceId === 'manual-render-failure',
        )
      })
      .toEqual(
        expect.objectContaining({
          source: 'browser',
          details: expect.objectContaining({
            recovered: true,
            errorLog: expect.stringContaining('Error'),
          }),
        }),
      )

    await preview.close()
    preview = undefined

    const traces = (await readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const request = traces.find(
      ({ event }) => event === 'copilot.request.accepted',
    )
    expect(request?.traceId).toBeTruthy()
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'server',
          event: 'copilot.source.verified',
          traceId: request.traceId,
        }),
        expect.objectContaining({
          source: 'server',
          event: 'preview.rebuilt',
          traceId: request.traceId,
        }),
        expect.objectContaining({
          source: 'browser',
          event: 'preview.rendered',
          traceId: request.traceId,
        }),
        expect.objectContaining({
          source: 'browser',
          event: 'copilot.request.completed',
          traceId: request.traceId,
        }),
      ]),
    )
    expect(
      traces.filter(({ event }) => event === 'preview.broadcast'),
    ).toHaveLength(1)
    expect(
      traces.find(({ event }) => event === 'preview.broadcast')?.traceId,
    ).toBe(request.traceId)
    expect(
      browserTraces.some(
        (line) =>
          line.includes(request.traceId) &&
          line.includes('copilot.request.completed'),
      ),
    ).toBe(true)
  } finally {
    await preview?.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
