const transientGitHubErrors = [
  "context deadline exceeded",
  "connection reset by peer",
  "i/o timeout",
  "tls handshake timeout",
  "unexpected eof",
  "http 502",
  "http 503",
  "http 504",
  // gh aw reports a remote file read that failed mid-download generically; the
  // catalog file always exists at the resolved ref, so retry instead of
  // failing the lifecycle test on a dropped GitHub response.
  "unable to download new package",
];
export const campaignInstallRetryDelayMilliseconds = 1_000;
// A clean-room campaign install walks the whole catalog through the contents
// API, so a single gateway error fails it. api.github.com gateway errors arrive
// in clusters, so one immediate retry is not enough; back off instead.
export const campaignInstallRetryAttempts = 4;

export function isTransientCampaignInstallError(error) {
  const output = `${error?.message ?? ""}\n${error?.stderr ?? ""}`.toLowerCase();
  return transientGitHubErrors.some((message) => output.includes(message));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function campaignInstallRetryDelay(attempt) {
  return campaignInstallRetryDelayMilliseconds * 2 ** (attempt - 1);
}

export async function retryTransientCampaignInstall(install, wait = sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await install();
    } catch (error) {
      if (attempt >= campaignInstallRetryAttempts || !isTransientCampaignInstallError(error)) throw error;
      await wait(campaignInstallRetryDelay(attempt));
    }
  }
}
