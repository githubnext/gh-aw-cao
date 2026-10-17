export function createDashboardServerQueryBudget({
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  let remaining = 30;
  let capacity = 30;
  let resetAt = 0;
  let queued = Promise.resolve();

  async function wait(minimum) {
    if (remaining >= minimum) return;
    // RateLimit-Reset counts down to a full bucket, not the next token.
    const refillFraction = (minimum - remaining) / (capacity - remaining);
    await sleep(Math.ceil(Math.max(0, resetAt - now()) * refillFraction) + 1000);
    remaining = minimum;
  }

  function enqueue(operation) {
    queued = queued.then(operation, operation);
    return queued;
  }

  return {
    waitForBudget() {
      return enqueue(() => wait(Math.min(20, capacity)));
    },
    run(request) {
      return enqueue(async () => {
        await wait(1);
        const response = await request();
        const headers = response.headers();
        capacity = Number(headers["ratelimit-limit"]);
        remaining = Number(headers["ratelimit-remaining"]);
        const resetSeconds = Number(headers["ratelimit-reset"]);
        if (!Number.isFinite(capacity) || capacity < 1
            || !Number.isFinite(remaining) || remaining < 0 || remaining > capacity
            || !Number.isFinite(resetSeconds) || resetSeconds < 0) {
          throw new Error("Dashboard query response has invalid rate-limit headers.");
        }
        resetAt = now() + resetSeconds * 1000;
        return response;
      });
    },
  };
}
