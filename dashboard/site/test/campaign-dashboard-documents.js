import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const campaignDashboardNames = [
  'uk-ai-advisory',
  'cao-evolution',
  'dependabot',
  'eu-cra-compliance',
  'optimization'
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const campaignDashboardSources = campaignDashboardNames.map((campaignName) => (
  readFileSync(resolve(repositoryRoot, campaignName, 'dashboard.json'), 'utf8')
));
