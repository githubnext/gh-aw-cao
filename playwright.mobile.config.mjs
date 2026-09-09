import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const browserName = process.env.MOBILE_BROWSER
const deviceName = process.env.MOBILE_DEVICE
const profileName = process.env.MOBILE_PROFILE ?? 'baseline'
const memoryMb = Number(process.env.MOBILE_MEMORY_MB ?? 0)

if (!browserName || !deviceName || !devices[deviceName]) {
  throw new Error('MOBILE_BROWSER and a valid MOBILE_DEVICE are required.')
}

const chromiumExecutable = existsSync('/usr/bin/chromium')
  ? '/usr/bin/chromium'
  : undefined
const chromiumArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-precise-memory-info',
]
if (memoryMb > 0)
  chromiumArgs.push(`--js-flags=--max-old-space-size=${memoryMb}`)

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/dashboard-mobile-live.spec.mjs'],
  outputDir: `test-results/${browserName}-${profileName}`,
  timeout: 120_000,
  workers: 1,
  preserveOutput: 'always',
  use: {
    ...devices[deviceName],
    browserName,
    headless: true,
    launchOptions:
      browserName === 'chromium'
        ? {
            args: chromiumArgs,
            ...(chromiumExecutable
              ? { executablePath: chromiumExecutable }
              : {}),
          }
        : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
