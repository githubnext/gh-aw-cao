export function runSetup({
  arguments_,
  setupCaoControlPlane,
  setupCaoAuthentication,
  UsageError,
  input,
}) {
  for (const argument of arguments_) {
    if (argument !== '--json') throw new UsageError(`Unexpected argument: ${argument}`);
  }
  return setupCaoControlPlane({
    input,
    UsageError,
    setupAuthentication: setupCaoAuthentication,
  });
}
