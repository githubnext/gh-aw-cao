export function runSetup({
  arguments_,
  setupCaoControlPlane,
  setupCaoAuthentication,
  UsageError,
  input,
}) {
  if (arguments_.length > 0) throw new UsageError(`Unexpected argument: ${arguments_[0]}`);
  return setupCaoControlPlane({
    input,
    UsageError,
    setupAuthentication: setupCaoAuthentication,
  });
}
