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
export const packageInstallRetryDelayMilliseconds = 1_000;

export function isTransientPackageInstallError(error) {
  const output = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  return transientGitHubErrors.some((message) => output.includes(message));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function retryTransientPackageInstall(install, wait = sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await install();
    } catch (error) {
      if (attempt >= 2 || !isTransientPackageInstallError(error)) throw error;
      await wait(packageInstallRetryDelayMilliseconds);
    }
  }
}
