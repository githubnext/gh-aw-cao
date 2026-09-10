const transientGitHubErrors = [
  "context deadline exceeded",
  "connection reset by peer",
  "i/o timeout",
  "tls handshake timeout",
  "unexpected eof",
  "http 502",
  "http 503",
  "http 504",
];

export function isTransientPackageInstallError(error) {
  const output = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  return transientGitHubErrors.some((message) => output.includes(message));
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function retryTransientPackageInstall(install, maxAttempts = 2, wait = sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return install();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientPackageInstallError(error)) throw error;
      wait(attempt * 1_000);
    }
  }
}
