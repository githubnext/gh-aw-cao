import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactNames = ["llms.txt", "llms-small.txt", "llms-full.txt"];
const requiredRoutes = [
  "/architecture/",
  "/cao-cli/",
  "/author-your-first-operation/",
  "/control-policy-specification/",
  "/activity/",
  "/dashboard/",
];
const requiredSkills = [
  "setup-cao",
  "debug-cao",
  "add-cao-campaign",
  "create-cao-campaign",
  "analyze-cao",
  "cao-cli",
];
const demotedHeadings = [
  "Activity cache compression analysis",
  "Campaign rhythm",
  "Dashboard view catalog",
];
const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
];
const developmentPathPatterns = [
  /\bfile:\/\//i,
  /\/home\/runner\/work\//,
  /\/Users\/[^/\s]+/,
  /\b[A-Za-z]:\\(?:Users|Windows|Temp)\\/,
  /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i,
  /\/tmp\/(?:astro|npm|runner|vite)[^)\s]*/i,
];

function markdownLinks(text) {
  return [...text.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1]);
}

function builtPathForUrl(distDirectory, url) {
  const relativePath = url.pathname.slice("/gh-aw-cao/".length);
  if (!relativePath || relativePath.endsWith("/")) {
    return path.join(distDirectory, relativePath, "index.html");
  }
  return path.join(distDirectory, relativePath);
}

async function isRegularNonemptyFile(filePath) {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0) return false;
    return Boolean((await readFile(filePath, "utf8")).trim());
  } catch {
    return false;
  }
}

export async function validateAgentDocs({
  root,
  trackedFiles = [],
  injectedSecretValues = [],
}) {
  const errors = [];
  const distDirectory = path.join(root, "dist");
  const artifacts = {};

  for (const artifactName of artifactNames) {
    const artifactPath = path.join(distDirectory, artifactName);
    if (!await isRegularNonemptyFile(artifactPath)) {
      errors.push(`${artifactName} must exist as a non-empty regular file`);
      continue;
    }
    artifacts[artifactName] = await readFile(artifactPath, "utf8");
  }

  const index = artifacts["llms.txt"];
  const small = artifacts["llms-small.txt"];
  const full = artifacts["llms-full.txt"];

  if (index) {
    const links = markdownLinks(index);
    for (const route of requiredRoutes) {
      if (!links.some((link) => link === `https://githubnext.github.io/gh-aw-cao${route}`)) {
        errors.push(`llms.txt must route directly to ${route}`);
      }
    }
    for (const skill of requiredSkills) {
      const expected = `https://github.com/githubnext/gh-aw-cao/blob/main/skills/${skill}/SKILL.md`;
      if (!links.includes(expected)) {
        errors.push(`llms.txt must route directly to the ${skill} skill`);
      }
    }

    for (const link of links) {
      let url;
      try {
        url = new URL(link);
      } catch {
        errors.push(`llms.txt contains a non-absolute link: ${link}`);
        continue;
      }
      if (url.hostname !== "githubnext.github.io") continue;
      if (url.origin !== "https://githubnext.github.io" || !url.pathname.startsWith("/gh-aw-cao/")) {
        errors.push(`llms.txt contains a non-canonical Pages URL: ${link}`);
        continue;
      }
      if (!await isRegularNonemptyFile(builtPathForUrl(distDirectory, url))) {
        errors.push(`llms.txt contains an unresolved internal link: ${link}`);
      }
    }
  }

  if (small && full && Buffer.byteLength(small) >= Buffer.byteLength(full)) {
    errors.push("llms-small.txt must be smaller than llms-full.txt");
  }
  if (full) {
    for (const heading of demotedHeadings) {
      if (!full.includes(`# ${heading}`)) {
        errors.push(`llms-full.txt must retain demoted content: ${heading}`);
      }
    }
  }

  for (const [artifactName, content] of Object.entries(artifacts)) {
    for (const pattern of credentialPatterns) {
      if (pattern.test(content)) {
        errors.push(`${artifactName} contains credential-like content`);
        break;
      }
    }
    for (const secretValue of injectedSecretValues) {
      if (secretValue.length >= 12 && content.includes(secretValue)) {
        errors.push(`${artifactName} contains an injected secret value`);
        break;
      }
    }
    for (const link of markdownLinks(content)) {
      if (developmentPathPatterns.some((pattern) => pattern.test(link))) {
        errors.push(`${artifactName} contains a development-machine URL or path`);
        break;
      }
    }
  }

  for (const file of trackedFiles) {
    const normalized = file.replaceAll("\\", "/");
    if (
      /(^|\/)agent-index\.json$/.test(normalized)
      || /(^|\/)llms(?:-small|-full)?\.txt$/.test(normalized)
    ) {
      errors.push(`generated agent documentation must not be committed: ${normalized}`);
    }
  }

  return errors;
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const injectedSecretValues = Object.entries(process.env)
    .filter(([name]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/i.test(name))
    .map(([, value]) => value)
    .filter(Boolean);
  const errors = await validateAgentDocs({ root, trackedFiles, injectedSecretValues });
  if (errors.length > 0) {
    console.error(`Agent documentation validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Agent documentation validation passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
