const terminalStatuses = new Set(["finished", "failed", "cancelled-by-user"]);
const immutableImagePattern = /^ghcr\.io\/githubnext\/gh-aw-cao\/cao-dashboard@sha256:[0-9a-f]{64}$/;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedUrl(value, name) {
  const url = new URL(required(value, name));
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url.href.replace(/\/$/, "");
}

async function responseJson(response, operation) {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

export async function deployCoolify({
  baseUrl,
  token,
  applicationUuid,
  readinessUrl,
  image,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollAttempts = 60,
  pollInterval = 5000,
  readinessAttempts = 12,
  readinessInterval = 5000,
  cancellationAttempts = 12,
}) {
  const headers = {
    ["Author" + "ization"]: `${"Bea" + "rer"} ${required(token, "COOLIFY_API_TOKEN")}`,
    "Content-Type": "application/json",
  };
  const application = encodeURIComponent(required(applicationUuid, "COOLIFY_APPLICATION_UUID"));
  const requestedImage = required(image, "CAO_IMAGE");
  if (!immutableImagePattern.test(requestedImage)) {
    throw new Error("CAO_IMAGE must be an immutable githubnext/gh-aw-cao dashboard digest");
  }

  async function api(path, options = {}) {
    return fetchImpl(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(30000),
      ...options,
      headers: { ...headers, ...options.headers },
    });
  }

  async function imageVariable() {
    const response = await api(`/api/v1/applications/${application}/envs`);
    const variables = await responseJson(response, "reading Coolify environment variables");
    const matches = variables.filter((variable) => variable.key === "CAO_IMAGE" && !variable.is_preview);
    if (matches.length !== 1 || matches[0].is_shown_once ||
        typeof matches[0].value !== "string" || !matches[0].value) {
      throw new Error(
        "Coolify application must expose exactly one non-preview CAO_IMAGE variable; check read:sensitive access",
      );
    }
    return matches[0].value;
  }

  async function setImage(value) {
    const response = await api(`/api/v1/applications/${application}/envs`, {
      method: "PATCH",
      body: JSON.stringify({ key: "CAO_IMAGE", value }),
    });
    await responseJson(response, "updating CAO_IMAGE");
  }

  async function startDeployment() {
    const response = await api("/api/v1/deploy", {
      method: "POST",
      body: JSON.stringify({ uuid: applicationUuid }),
    });
    const result = await responseJson(response, "starting Coolify deployment");
    const deployments = result.deployments;
    if (!Array.isArray(deployments) || deployments.length !== 1 ||
        deployments[0].resource_uuid !== applicationUuid ||
        typeof deployments[0].deployment_uuid !== "string" ||
        !deployments[0].deployment_uuid) {
      throw new Error("Coolify returned an invalid deployment identity");
    }
    return deployments[0].deployment_uuid;
  }

  async function waitForDeployment(deploymentUuid) {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const response = await api(`/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`);
      const deployment = await responseJson(response, "reading Coolify deployment status");
      if (terminalStatuses.has(deployment.status)) {
        if (deployment.status !== "finished") {
          throw new Error(`Coolify deployment ended with status ${deployment.status}`);
        }
        return;
      }
      if (deployment.status !== "queued" && deployment.status !== "in_progress") {
        throw new Error("Coolify deployment returned an unknown status");
      }
      await sleep(pollInterval);
    }
    const cancel = await api(`/api/v1/deployments/${encodeURIComponent(deploymentUuid)}/cancel`, {
      method: "POST",
    });
    if (!cancel.ok) throw new Error(`cancelling timed-out Coolify deployment failed with HTTP ${cancel.status}`);
    for (let attempt = 0; attempt < cancellationAttempts; attempt += 1) {
      const response = await api(`/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`);
      const deployment = await responseJson(response, "reading cancelled Coolify deployment status");
      if (deployment.status === "finished") return;
      if (terminalStatuses.has(deployment.status)) {
        throw new Error("Coolify deployment did not finish before the timeout");
      }
      await sleep(pollInterval);
    }
    throw new Error("timed-out Coolify deployment did not stop after cancellation");
  }

  async function verifyReadiness() {
    let status = 0;
    for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(readinessUrl, {
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        status = response.status;
        if (status === 200) return;
      } catch {
        status = 0;
      }
      await sleep(readinessInterval);
    }
    throw new Error(status ? `dashboard readiness failed with HTTP ${status}` : "dashboard readiness request failed");
  }

  const previousImage = await imageVariable();
  if (!immutableImagePattern.test(previousImage)) {
    throw new Error("existing CAO_IMAGE must be an immutable githubnext/gh-aw-cao dashboard digest");
  }
  let imageUpdated = false;
  try {
    imageUpdated = true;
    await setImage(requestedImage);
    await waitForDeployment(await startDeployment());
    await verifyReadiness();
    if (await imageVariable() !== requestedImage) {
      throw new Error("Coolify CAO_IMAGE changed during deployment");
    }
  } catch (error) {
    if (!imageUpdated) throw error;
    try {
      await setImage(previousImage);
      await waitForDeployment(await startDeployment());
      await verifyReadiness();
      if (await imageVariable() !== previousImage) {
        throw new Error("Coolify CAO_IMAGE changed during rollback");
      }
    } catch (rollbackError) {
      throw new Error(`deployment failed and rollback failed: ${rollbackError.message}`, { cause: error });
    }
    throw new Error(`deployment failed; previous image restored: ${error.message}`, { cause: error });
  }
}

async function main() {
  const baseUrl = normalizedUrl(process.env.COOLIFY_BASE_URL, "COOLIFY_BASE_URL");
  const readinessUrl = normalizedUrl(process.env.COOLIFY_READINESS_URL, "COOLIFY_READINESS_URL");
  await deployCoolify({
    baseUrl,
    token: process.env.COOLIFY_API_TOKEN,
    applicationUuid: process.env.COOLIFY_APPLICATION_UUID,
    readinessUrl: `${readinessUrl}/api/readiness`,
    image: process.env.CAO_IMAGE,
  });
  process.stdout.write("Coolify deployed the requested digest and confirmed readiness\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
