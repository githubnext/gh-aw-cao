#!/usr/bin/env node

import { createSign } from "node:crypto";

const profile = process.argv[2];
const apiUrl = process.env.GITHUB_API_URL || "https://api.contoso-aw.ghe.com";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://contoso-aw.ghe.com";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function appJwt(clientId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iat: now - 60,
    exp: now + 540,
    iss: clientId,
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

async function api(path, { method = "GET", token, body, authenticated = true } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (authenticated) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${method} ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  if (response.status === 204 || response.status === 202 || response.status === 404) return undefined;
  return response.json();
}

async function uninstallApp(role) {
  const clientId = required(`GH_AW_GITHUB_${role.toUpperCase()}_APP_ID`);
  const privateKey = required(`GH_AW_GITHUB_${role.toUpperCase()}_APP_PRIVATE_KEY`);
  const token = appJwt(clientId, privateKey);
  const app = await api("/app", { token });
  if (!app?.slug?.startsWith("cao-")) {
    throw new Error(`Refusing to teardown unexpected GitHub App slug: ${app?.slug || "(missing)"}`);
  }
  const installations = await api("/app/installations?per_page=100", { token });
  for (const installation of installations ?? []) {
    await api(`/app/installations/${installation.id}`, { method: "DELETE", token });
    console.log(`Uninstalled ${app.slug} from ${installation.account?.login || installation.id}`);
  }
  const owner = app.owner?.login;
  if (!owner) throw new Error(`Unable to resolve owner for ${app.slug}`);
  const ownerKind = app.owner.type === "Enterprise" ? "enterprises" : "organizations";
  console.log(`DELETE_APP_REGISTRATION=${serverUrl}/${ownerKind}/${owner}/settings/apps/${app.slug}`);
}

async function revokePat(name) {
  const token = required(name);
  if (!token.startsWith("github_pat_")) {
    throw new Error(`Refusing to revoke ${name}: expected a fine-grained PAT`);
  }
  await api("/credentials/revoke", {
    method: "POST",
    body: { credentials: [token] },
    authenticated: false,
  });
  console.log(`Revocation accepted for ${name}`);
}

if (profile === "app") {
  await uninstallApp("read");
  await uninstallApp("write");
} else if (profile === "pat") {
  await revokePat("GH_AW_GITHUB_READ_PAT");
  await revokePat("GH_AW_GITHUB_WRITE_PAT");
} else {
  throw new Error("Usage: contoso-auth-teardown.mjs <app|pat>");
}
