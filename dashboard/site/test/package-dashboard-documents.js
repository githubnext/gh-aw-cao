import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageDashboardNames = ['uk-ai-advisory', 'aw-doctor', 'dependabot', 'eu-cra-compliance', 'optimization']

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export const packageDashboardSources = packageDashboardNames.map((packageName) => readFileSync(resolve(repositoryRoot, packageName, 'dashboard.json'), 'utf8'))
