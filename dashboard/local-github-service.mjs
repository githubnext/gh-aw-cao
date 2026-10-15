import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const freshMs = 300_000;
const staleMs = 86_400_000;
const maxEntries = 128;
const maxBytes = 512 * 1024;
const cacheControl = "private, max-age=300, stale-while-revalidate=86400";
const fields = {
  repository: ["full_name", "description", "html_url", "default_branch", "stargazers_count", "forks_count", "open_issues_count", "archived", "visibility"],
  release: ["tag_name", "name", "html_url", "published_at", "draft", "prerelease"],
};

function unavailable(status = 503, retry = 60) {
  return {
    status,
    headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, Math.ceil(retry))) },
    body: { error: status === 429 ? "GitHub rate limit reached." : "Live GitHub data is unavailable." },
  };
}

function secondsUntil(value, now) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, (date - now) / 1000) : 60;
}

/** Read-only local-preview adapter. Credentials remain in this server process. */
export function createLocalGitHubService({
  fetchImpl = globalThis.fetch,
  token = async () => (await executeFile("gh", ["auth", "token", "--hostname", "github.com"], {
    timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true,
  })).stdout.trim(),
  now = Date.now,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let blockedUntil = 0;
  let credentialsBlockedUntil = 0;
  let tokenPromise;

  function cachedResponse(entry, stale = false) {
    return {
      status: 200,
      headers: {
        ETag: entry.etag,
        "Cache-Control": stale ? "private, max-age=0, stale-while-revalidate=86400" : cacheControl,
        Age: String(Math.max(0, Math.floor((now() - entry.checkedAt) / 1000))),
        ...(stale ? { Warning: '110 - "Response is stale"' } : {}),
        ...(stale && blockedUntil > now() ? { "Retry-After": String(Math.max(1, Math.ceil((blockedUntil - now()) / 1000))) } : {}),
      },
      body: entry.body,
    };
  }

  async function refresh(path, kind, credential, key, entry) {
    if (blockedUntil > now()) {
      return entry ? cachedResponse(entry, true) : unavailable(429, (blockedUntil - now()) / 1000);
    }
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        headers: {
          Authorization: ["Bearer", credential].join(" "),
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(entry?.upstreamEtag ? { "If-None-Match": entry.upstreamEtag } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        blockedUntil = Math.max(blockedUntil, Number.isFinite(reset) && reset > now() ? reset : now() + 60_000);
      }
      if (response.status === 304 && entry) {
        entry.checkedAt = now();
        return cachedResponse(entry);
      }
      if (response.status === 429 || (response.status === 403
          && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"))) {
        const delay = secondsUntil(response.headers.get("retry-after"), now()) * 1000;
        blockedUntil = Math.max(blockedUntil, now() + delay);
        return entry ? cachedResponse(entry, true) : unavailable(429, (blockedUntil - now()) / 1000);
      }
      if (!response.ok) {
        if (response.status === 404 || response.status === 401 || response.status === 403) cache.delete(key);
        if (response.status === 404) return { status: 404, headers: { "Cache-Control": "no-store" }, body: { error: "GitHub resource not found." } };
        if (response.status === 401 || response.status === 403) blockedUntil = Math.max(blockedUntil, now() + 60_000);
        return entry && response.status >= 500 ? cachedResponse(entry, true) : unavailable();
      }
      if (Number(response.headers.get("content-length")) > maxBytes || !response.body) throw new Error("Invalid GitHub response.");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error("GitHub response exceeds limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid GitHub resource.");
      const body = Object.fromEntries(fields[kind].map((field) => [field, raw[field] ?? null]));
      for (const [field, value] of Object.entries(body)) {
        if (value === null && ["description", "name", "published_at"].includes(field)) continue;
        const type = ["archived", "draft", "prerelease"].includes(field) ? "boolean"
          : ["stargazers_count", "forks_count", "open_issues_count"].includes(field) ? "number" : "string";
        if (typeof value !== type || (type === "number" && (!Number.isSafeInteger(value) || value < 0))) {
          throw new Error("Invalid GitHub resource field.");
        }
      }
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("GitHub resource exceeds cache limit.");
      const updated = {
        body,
        etag: `"${createHash("sha256").update(encoded).digest("hex")}"`,
        upstreamEtag: response.headers.get("etag"),
        checkedAt: now(),
      };
      cache.delete(key);
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, updated);
      return cachedResponse(updated);
    } catch {
      blockedUntil = Math.max(blockedUntil, now() + 30_000);
      return entry ? cachedResponse(entry, true) : unavailable();
    }
  }

  return {
    async request(pathname, ifNoneMatch) {
      const match = /^\/api\/v1\/github\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})(\/releases\/latest)?$/.exec(pathname);
      if (!match || [".", ".."].includes(match?.[2])) {
        return { status: 400, headers: { "Cache-Control": "no-store" }, body: { error: "Invalid GitHub resource." } };
      }
      if (credentialsBlockedUntil > now()) return unavailable();
      let credential;
      try {
        tokenPromise ??= Promise.resolve().then(token).finally(() => { tokenPromise = undefined; });
        credential = await tokenPromise;
        if (!credential) throw new Error("No credential.");
      } catch {
        credentialsBlockedUntil = now() + 60_000;
        return unavailable();
      }
      const path = `/repos/${match[1].toLowerCase()}/${match[2].toLowerCase()}${match[3] ?? ""}`;
      const key = `${createHash("sha256").update(credential).digest("hex")}:${path}`;
      let entry = cache.get(key);
      if (entry && now() - entry.checkedAt > freshMs + staleMs) {
        cache.delete(key);
        entry = undefined;
      }
      let result;
      if (entry && now() - entry.checkedAt < freshMs) {
        result = cachedResponse(entry);
      } else {
        if (!inFlight.has(key)) {
          if (inFlight.size >= 16) return entry ? cachedResponse(entry, true) : unavailable(429);
          const pending = refresh(path, match[3] ? "release" : "repository", credential, key, entry)
            .finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        result = await inFlight.get(key);
      }
      if (result.status === 200 && !result.headers.Warning && typeof ifNoneMatch === "string"
          && ifNoneMatch.split(",").some((value) => value.trim() === "*" || value.trim().replace(/^W\//, "") === result.headers.ETag)) {
        return { status: 304, headers: result.headers };
      }
      return result;
    },
  };
}
