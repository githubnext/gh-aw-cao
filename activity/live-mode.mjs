import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CrossRepoAuthStatus, discoverCrossRepoAuth } from './authentication.mjs';
import { createTerminalPrompt } from './setup.mjs';

export async function assistLiveMode({
  repository,
  policyPath,
  allowedRepositories = [],
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
      const arguments_ = ['--repo', repository, '--policy', policyPath];
      if (profile === 'token') {
        const destinations = [...new Set([repository, ...allowedRepositories])];
        const answer = await interactive.text(
          `Write repositories (comma-separated, choose only approved destinations from ${destinations.join(', ')})`,
        );
        const selected = [...new Set(answer.split(',').map((value) => value.trim()).filter(Boolean))];
        if (selected.length === 0) {
          output.write('Live mode enabled without PAT setup; admission will reject live runs until target write credentials are configured.\n');
          return;
        }
        for (const target of selected) {
          if (!destinations.some((candidate) => candidate.toLowerCase() === target.toLowerCase())) {
            throw new UsageError(`Write repository must be in the control policy scope: ${target}`);
          }
          arguments_.push('--write-repository', target);
        }
      }
      setupAuthentication(profile, arguments_, { execute });
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
    await assistLiveMode({
      repository, policyPath, allowedRepositories: policy['control-plane']?.scope?.['allowed-repositories'] ?? [],
      execute, input, output, prompt, discoverAuth, setupAuthentication, UsageError,
    });
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
