import { parseOptions, rejectUnknownOptions } from '../cli/options.mjs';

export function runSetup({
  arguments_,
  setupCaoControlPlane,
  setupCaoAuthentication,
  UsageError,
  input,
}) {
  const options = parseOptions(arguments_);
  rejectUnknownOptions(options, ['json', 'repository']);
  return setupCaoControlPlane({
    input,
    publicOnly: options.repository !== undefined,
    repositories: options.repository ?? [],
    UsageError,
    setupAuthentication: setupCaoAuthentication,
  });
}
