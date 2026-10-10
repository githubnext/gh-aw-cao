import { Worker } from "node:worker_threads";

export async function startLocalSqliteBackend(options) {
  const worker = new Worker(new URL("./local-sqlite-worker.mjs", import.meta.url), {
    workerData: options,
  });
  const requests = new Map();
  let nextId = 0;
  let stopped = false;
  let failure;
  const ready = new Promise((resolve, reject) => {
    const fail = (error) => {
      failure = error;
      reject(error);
      for (const request of requests.values()) request.reject(error);
      requests.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!stopped) fail(new Error(`SQLite dashboard worker exited (${code}).`));
    });
    worker.on("message", (message) => {
      if (message.ready) resolve(message.ready);
      else if (message.failed) fail(new Error(message.failed));
      else {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        if (message.error) {
          request.reject(Object.assign(new Error(message.error.error), message.error));
        } else request.resolve(message.result);
      }
    });
  });
  try {
    const status = await ready;
    return {
      status,
      request(operation, payload) {
        if (failure) return Promise.reject(failure);
        if (stopped) return Promise.reject(new Error("SQLite dashboard backend is closed."));
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          requests.set(id, { resolve, reject });
          worker.postMessage({ id, operation, payload });
        });
      },
      async close() {
        if (stopped) return;
        stopped = true;
        for (const request of requests.values()) {
          request.reject(new Error("SQLite dashboard backend is closed."));
        }
        requests.clear();
        await worker.terminate();
      },
    };
  } catch (error) {
    stopped = true;
    await worker.terminate();
    throw error;
  }
}
