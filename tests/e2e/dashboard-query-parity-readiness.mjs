export async function waitForServer(url, {
  child,
  fetchHealth = fetch,
  timeoutMs = 60_000,
  retryIntervalMs = 100,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child?.exitCode != null || child?.signalCode != null) {
      throw new Error(`Postgres dashboard server exited with ${child.signalCode ?? `code ${child.exitCode}`}`);
    }
    try {
      const response = await fetchHealth(`${url}/api/v1/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryIntervalMs));
  }
  throw new Error(`Postgres dashboard server did not become ready: ${lastError}`);
}
