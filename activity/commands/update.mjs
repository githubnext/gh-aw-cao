export function runUpdate({ arguments_, updateCaoCampaigns }) {
  return updateCaoCampaigns(arguments_);
}

export function parseUpdateArguments(ghAwOptions, UsageError) {
  const addValueFlags = new Set(['--dir', '-d', '--engine', '-e', '--stop-after', '--append', '--gh-aw-ref']);
  const valueFlags = new Set([...addValueFlags, '--cool-down', '--repo', '-r', '--org', '--repos']);
  const arguments_ = [];
  let ref;
  let positionalsOnly = false;
  for (let index = 0; index < ghAwOptions.length; index += 1) {
    const argument = ghAwOptions[index];
    if (!positionalsOnly && argument === '--') {
      positionalsOnly = true;
      continue;
    }
    if (!positionalsOnly && argument.startsWith('-')) {
      arguments_.push(argument);
      if (valueFlags.has(argument)) {
        const value = ghAwOptions[++index];
        if (!value || value.startsWith('-')) throw new UsageError(`${argument} requires a value`);
        arguments_.push(value);
      }
      continue;
    }
    if (ref !== undefined) throw new UsageError('cao update accepts only one ref');
    ref = argument;
  }
  if (ref !== undefined && !['main', 'master', 'latest'].includes(ref) && !/^[0-9a-f]{7,40}$/i.test(ref)) {
    throw new UsageError('cao update requires main, master, latest, or a commit SHA (7-40 hexadecimal characters)');
  }
  if (ref !== undefined) {
    const flags = new Set(['--force', '-f', '--no-security-scanner', '--no-stop-after', '--no-gitattributes', '--verbose', '-v', '--banner']);
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      const [flag, ...inlineValue] = argument.split('=');
      if (flags.has(flag) && inlineValue.length === 0) continue;
      if (addValueFlags.has(flag)) {
        const value = inlineValue.length > 0 ? inlineValue.join('=') : arguments_[++index];
        if (value && !value.startsWith('-')) continue;
        throw new UsageError(`${flag} requires a value`);
      }
      throw new UsageError(`Unsupported option for cao update with a ref: ${argument}; use gh-aw add options, not release-update options`);
    }
  }
  return {
    ref,
    includePrereleases: arguments_.includes('--pre-releases'),
    updateOptions: arguments_.filter((option) => option !== '--pre-releases')
  };
}

export function resolveUpdateCommit(ref, execute, failureMessage, compareVersions) {
  if (ref === undefined) return undefined;
  let sourceRef = ref;
  if (ref === 'main' || ref === 'master') {
    const repository = execute('gh', [
      'api', '--hostname', 'github.com',
      '/repos/githubnext/gh-aw-cao', '--jq', '.default_branch'
    ], { encoding: 'utf8' });
    if (repository.error || repository.status !== 0) {
      throw new Error(`Unable to resolve CAO default branch: ${failureMessage(repository, 'gh api failed')}`);
    }
    sourceRef = String(repository.stdout || '').trim();
    if (!sourceRef || sourceRef === 'null' || /\s/.test(sourceRef)) {
      throw new Error('Unable to resolve CAO default branch: expected a branch name');
    }
  } else if (ref === 'latest') {
    const releases = execute('gh', [
      'api', '--hostname', 'github.com',
      '/repos/githubnext/gh-aw-cao/releases?per_page=100', '--paginate', '--jq',
      '.[] | select(.draft == false and .prerelease == false) | .tag_name'
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (releases.error || releases.status !== 0) {
      throw new Error(`Unable to resolve latest stable CAO release: ${failureMessage(releases, 'gh api failed')}`);
    }
    sourceRef = String(releases.stdout || '').trim().split(/\s+/)
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag))
      .sort(compareVersions).at(-1);
    if (!sourceRef) {
      throw new Error('Unable to resolve latest stable CAO release: expected a published vMAJOR.MINOR.PATCH release tag');
    }
  }
  const result = execute('gh', [
    'api', '--hostname', 'github.com',
    `/repos/githubnext/gh-aw-cao/commits/${encodeURIComponent(sourceRef)}`, '--jq', '.sha'
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to resolve CAO ref ${ref}: ${failureMessage(result, 'gh api failed')}`);
  }
  const commit = String(result.stdout || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)
    || (!['main', 'master', 'latest'].includes(ref) && !commit.startsWith(ref.toLowerCase()))) {
    throw new Error(`Unable to resolve CAO ref ${ref}: expected a matching full commit SHA`);
  }
  return commit;
}
