export function runQuickstart({
  arguments_,
  runCaoQuickstart,
  UsageError,
}) {
  let campaignSpec;
  let targetRepository;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
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
  return runCaoQuickstart({
    ...(campaignSpec ? { campaignSpec } : {}),
    ...(targetRepository ? { targetRepository } : {}),
    ...(json ? { progress: {} } : {}),
  });
}
