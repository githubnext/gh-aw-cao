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

export function retryTransientPackageInstall(install, maxAttempts = 2) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return install();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientPackageInstallError(error)) throw error;
    }
  }
}
