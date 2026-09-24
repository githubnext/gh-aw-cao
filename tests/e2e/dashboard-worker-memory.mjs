/**
 * Chromium dedicated workers do not expose `performance.memory`, so worker heap
 * pressure is measured through the browser's own CDP endpoint.
 */

export function remoteDebuggingPort() {
  const port = Number(process.env.DASHBOARD_MEMORY_CDP_PORT);
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new Error("DASHBOARD_MEMORY_CDP_PORT must be set by the Playwright configuration.");
  }
  return port;
}

async function workerTarget(port, urlSuffix) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Unable to list CDP targets: HTTP ${response.status}.`);
  const targets = await response.json();
  return targets.find((target) => {
    if (target.type !== "worker" || typeof target.url !== "string") return false;
    // The worker script URL carries forwarded debug parameters, so only the
    // path may be matched against the expected suffix.
    const path = target.url.split(/[?#]/, 1)[0];
    return path.endsWith(urlSuffix);
  }) ?? null;
}

/**
 * Attaches to the data worker and samples its isolated JavaScript heap.
 */
export class WorkerHeapProbe {
  #port;
  #urlSuffix;
  #socket = null;
  #targetUrl = null;
  #nextId = 1;
  #pending = new Map();
  samples = [];

  constructor({ port, urlSuffix = "/data-worker.js" }) {
    this.#port = port;
    this.#urlSuffix = urlSuffix;
  }

  get attached() {
    return this.#socket !== null;
  }

  get targetUrl() {
    return this.#targetUrl;
  }

  async attach({ timeoutMs = 30_000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = await workerTarget(this.#port, this.#urlSuffix).catch(() => null);
      if (target) {
        this.#targetUrl = target.url;
        this.#socket = await this.#connect(target.webSocketDebuggerUrl);
        return true;
      }
      await new Promise((ready) => setTimeout(ready, intervalMs));
    }
    return false;
  }

  #connect(endpoint) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const settle = this.#pending.get(message.id);
        if (!settle) return;
        this.#pending.delete(message.id);
        if (message.error) settle.reject(new Error(message.error.message));
        else settle.resolve(message.result);
      });
      // A worker that exhausts its heap simply disappears, so every in-flight
      // request has to be failed rather than left pending forever.
      socket.addEventListener("close", () => {
        if (this.#socket === socket) this.#socket = null;
        for (const [id, settle] of this.#pending) {
          this.#pending.delete(id);
          settle.reject(new Error("The data worker target closed before the request completed."));
        }
      });
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error("Unable to attach to the data worker.")));
    });
  }

  send(method, params = {}, { timeoutMs = 15_000 } = {}) {
    if (!this.#socket) throw new Error("The worker heap probe is not attached.");
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      // A measurement probe must never outlive its answer: an unanswered CDP
      // command would otherwise stall the whole run instead of failing it.
      const expiry = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The data worker did not answer ${method} within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(expiry); resolve(value); },
        reject: (error) => { clearTimeout(expiry); reject(error); },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Records one heap sample, returning null when the worker is gone. */
  async sample(phase, elapsedMs) {
    // A reload replaces the worker, so a probe that keeps sampling across one
    // must re-attach instead of silently recording nothing.
    if (!this.#socket) await this.attach({ timeoutMs: 250, intervalMs: 50 }).catch(() => false);
    if (!this.#socket) return null;
    const usage = await this.send("Runtime.getHeapUsage").catch(() => null);
    if (!usage) return null;
    const sample = {
      phase,
      elapsedMs,
      usedBytes: usage.usedSize ?? 0,
      totalBytes: usage.totalSize ?? 0,
    };
    this.samples.push(sample);
    return sample;
  }

  async collectGarbage() {
    if (!this.#socket) return;
    // `collectGarbage` only answers once its domain is enabled.
    await this.send("HeapProfiler.enable").catch(() => null);
    await this.send("HeapProfiler.collectGarbage").catch(() => null);
  }

  peakUsedBytes(phases = null) {
    const selected = this.samples.filter(({ phase }) => !phases || phases.includes(phase));
    return Math.max(0, ...selected.map(({ usedBytes }) => usedBytes));
  }

  lastUsedBytes() {
    return this.samples.at(-1)?.usedBytes ?? 0;
  }

  close() {
    this.#socket?.close();
    this.#socket = null;
  }
}
