export function runQuickstart({
  arguments_,
  runCaoQuickstart,
  UsageError,
}) {
  let campaignSpec;
  let targetRepository;
  let json = false;
  let step;
  let wait = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--wait') {
      if (wait) throw new UsageError('Duplicate --wait');
      wait = true;
    } else if (argument === '--step') {
      if (step) throw new UsageError('Duplicate --step');
      step = arguments_[++index];
      if (!['install', 'run', 'collect', 'dashboard'].includes(step)) {
        throw new UsageError('--step requires install, run, collect, or dashboard');
      }
    } else if (argument === '--campaign') {
      campaignSpec = arguments_[index + 1];
      if (!campaignSpec || campaignSpec.startsWith('-')) {
        throw new UsageError('--campaign requires a CAO campaign package');
      }
      index += 1;
    } else if (argument === '--target') {
      targetRepository = arguments_[index + 1];
      if (!targetRepository || targetRepository.startsWith('-')) {
        throw new UsageError('--target requires an OWNER/REPOSITORY coordinate');
      }
      index += 1;
    } else {
      throw new UsageError(`Unexpected argument: ${argument}`);
    }
  }
  if (wait && step) throw new UsageError('--wait cannot be combined with --step');
  if (step && step !== 'install' && (campaignSpec || targetRepository)) {
    throw new UsageError('--target and --campaign are only valid for install or --wait');
  }
  if ((!step || step === 'install') && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(targetRepository || '')) {
    throw new UsageError('Quickstart install and --wait require explicit --target OWNER/REPO');
  }
  return runCaoQuickstart({
    ...(step ? { step } : {}),
    ...(wait ? { wait } : {}),
    ...(campaignSpec ? { campaignSpec } : {}),
    ...(targetRepository ? { targetRepository } : {}),
    ...(json ? { progress: {} } : {}),
  });
}
