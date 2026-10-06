export function runUpdate({ arguments_, updateCaoCampaigns }) {
  return updateCaoCampaigns(arguments_);
}

export function parseUpdateArguments(ghAwOptions, UsageError) {
  const arguments_ = [...ghAwOptions];
  const ref = arguments_[0] && !arguments_[0].startsWith('-') ? arguments_.shift() : undefined;
  if (ref !== undefined && ref !== 'main' && !/^[0-9a-f]{7,40}$/i.test(ref)) {
    throw new UsageError('cao update requires main or a commit SHA (7-40 hexadecimal characters)');
  }
  if (ref !== undefined) {
    const flags = new Set(['--force', '-f', '--no-security-scanner', '--no-stop-after', '--no-gitattributes', '--verbose', '-v', '--banner']);
    const valueFlags = new Set(['--dir', '-d', '--engine', '-e', '--stop-after', '--append', '--gh-aw-ref']);
    for (let index = 0; index < arguments_.length; index += 1) {
      const argument = arguments_[index];
      const [flag, ...inlineValue] = argument.split('=');
      if (flags.has(flag) && inlineValue.length === 0) continue;
      if (valueFlags.has(flag)) {
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

export function resolveUpdateCommit(ref, execute, failureMessage) {
  if (ref === undefined) return undefined;
  const result = execute('gh', [
    'api', '--hostname', 'github.com',
    `/repos/githubnext/gh-aw-cao/commits/${ref}`, '--jq', '.sha'
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to resolve CAO ref ${ref}: ${failureMessage(result, 'gh api failed')}`);
  }
  const commit = String(result.stdout || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)
    || (ref !== 'main' && !commit.startsWith(ref.toLowerCase()))) {
    throw new Error(`Unable to resolve CAO ref ${ref}: expected a matching full commit SHA`);
  }
  return commit;
}
