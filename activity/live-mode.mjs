import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CrossRepoAuthStatus, discoverCrossRepoAuth } from './authentication.mjs';
import { createTerminalPrompt } from './setup.mjs';

export async function assistLiveMode({
  repository,
  policyPath,
  execute = spawnSync,
  input = process.stdin,
  output = process.stderr,
  prompt,
  discoverAuth = discoverCrossRepoAuth,
  setupAuthentication,
  UsageError = Error,
}) {
  const status = repository
    ? await discoverAuth(repository, { execute })
    : CrossRepoAuthStatus.UNKNOWN;
  if (status !== CrossRepoAuthStatus.ABSENT || !(prompt || (input.isTTY && output.isTTY))) return;

  const interactive = prompt || createTerminalPrompt({ input, output, UsageError });
  try {
    if (await interactive.confirm('No cross-repository App or PAT was found. Configure authentication now?')) {
      const profile = await interactive.select('Choose the existing authentication setup', [
        { label: 'Organization GitHub Apps', value: 'github-app' },
        { label: 'Fine-grained PATs', value: 'token' },
      ]);
      if (!['github-app', 'token'].includes(profile)) throw new UsageError('Invalid authentication setup choice');
      setupAuthentication(profile, ['--repo', repository, '--policy', policyPath], { execute });
    } else {
      output.write('Live mode enabled without cross-repository credentials; admission will reject live runs until a GitHub App or PAT is configured.\n');
    }

  } finally {
    if (!prompt) interactive.close();
  }
}

export async function changeCampaignMode(mode, campaignNames, {
  policyPath,
  execute = spawnSync,
  input = process.stdin,
  output = process.stderr,
  prompt,
  discoverAuth,
  setupAuthentication,
  readCaoPolicy,
  writeJsonAtomically,
  resolveControlRepository,
  UsageError,
}) {
  if (mode !== 'live' && mode !== 'preview') {
    throw new UsageError('cao mode requires live or preview');
  }
  if (!Array.isArray(campaignNames) || campaignNames.length === 0) {
    throw new UsageError(`cao mode ${mode} requires at least one campaign`);
  }

  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const invalidCampaign = campaignNames.find((campaignName) => typeof campaignName !== 'string' || !slug.test(campaignName));
  if (invalidCampaign !== undefined) {
    throw new UsageError(`Invalid CAO campaign name: ${invalidCampaign}`);
  }

  const policy = await readCaoPolicy(policyPath, 'mode');
  const campaigns = policy['control-plane']?.campaigns ?? {};
  const unknownCampaigns = [...new Set(campaignNames)].filter((campaignName) => !Object.hasOwn(campaigns, campaignName));
  if (unknownCampaigns.length > 0) {
    throw new UsageError(`Unknown CAO campaign${unknownCampaigns.length === 1 ? '' : 's'}: ${unknownCampaigns.join(', ')}`);
  }
  for (const campaignName of campaignNames) {
    if (campaigns[campaignName] === null || typeof campaigns[campaignName] !== 'object' || Array.isArray(campaigns[campaignName])) {
      throw new Error(`${policyPath} control-plane campaign ${campaignName} must be an object`);
    }
  }

  if (mode === 'live') {
    let repository;
    try {
      repository = resolveControlRepository(execute);
    } catch {
      // Repository discovery is opportunistic; admission checks the run itself.
    }
    await assistLiveMode({ repository, policyPath, execute, input, output, prompt, discoverAuth, setupAuthentication, UsageError });
  }
  const policyMode = mode === 'preview' ? 'review' : 'live';
  for (const campaignName of new Set(campaignNames)) {
    campaigns[campaignName] = { ...campaigns[campaignName], mode: policyMode };
  }
  await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'mode',
    mode,
    campaigns: [...new Set(campaignNames)],
    policy: policyPath,
  };
}
