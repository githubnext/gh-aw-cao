export function runSetupAuth({ arguments_, setupCaoAuthentication }) {
  return setupCaoAuthentication(arguments_[0], arguments_.slice(1));
}
