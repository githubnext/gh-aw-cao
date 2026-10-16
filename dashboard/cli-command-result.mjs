import { stripVTControlCharacters } from "node:util";

/** Extract links without trusting terminal escapes, credentials, or a public GitHub hostname. */
export function lastPullRequestUrl(output) {
  let last;
  for (const match of stripVTControlCharacters(output).matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const candidate = match[0].replace(/[),.;!?\]}]+$/, "");
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.username || url.password
      || !/\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)) continue;
    last = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  }
  return last;
}
