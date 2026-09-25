export function runInit({ arguments_, initializeCaoPolicy, UsageError }) {
  if (arguments_.length > 0) throw new UsageError(`Unexpected argument: ${arguments_[0]}`);
  return initializeCaoPolicy();
}
