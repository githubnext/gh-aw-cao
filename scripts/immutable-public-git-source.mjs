import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const LIMIT = 4 * 1024 * 1024;
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest("hex");

export function parsePublicLfsPointer(bytes) {
  const text = bytes.toString("utf8");
  if (!text.startsWith("version https://git-lfs.github.com/spec/")) return null;
  const match = text.match(/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([1-9]\d*)\n?$/);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > LIMIT) {
    throw new Error("Malformed or over-budget immutable LFS pointer");
  }
  return { oid: match[1], size: Number(match[2]) };
}

export function verifyPublicGitBlob(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT || !/^[a-f0-9]{40}$/.test(expected)
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== expected) {
    throw new Error("Immutable public Git blob identity mismatch");
  }
  return bytes;
}

export function publicGitSourceReader(cache, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid public source repository");
  const execute = (command, args, options = {}) => execFileSync(command, args, {
    timeout: 45000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
  const git = (args, options = {}) => execute("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, ...options,
  });
  const metadata = args => git(args).toString("utf8").trim();
  if (metadata(["remote", "get-url", "origin"]) !== `https://github.com/${repository}.git`) {
    throw new Error("Immutable public source remote mismatch");
  }
  const blobs = new Map();
  let totalBytes = 0;
  const read = (commit, file) => {
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[A-Za-z0-9_./-]+$/.test(file)
      || file.startsWith("/") || file.split("/").some(part => ["", ".", ".."].includes(part))) {
      throw new Error("Unsafe immutable public source reference");
    }
    const entry = metadata(["ls-tree", "-r", commit, "--", file]);
    if (!entry) return null;
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error("Unsupported immutable public source mode");
    const id = match[1];
    if (blobs.has(id)) return { ...blobs.get(id), path: file };
    let native;
    try {
      native = git(["cat-file", "blob", id]);
    } catch (error) {
      if (error.status !== 128 || !/Not a valid object name|could not get object info|bad file/i.test(String(error.stderr))) {
        throw new Error(`Immutable local Git read failed (${error.code ?? error.status ?? "unknown"}).`);
      }
      console.error(`${id}: retrieving an exact missing public Git blob.`);
      const response = JSON.parse(execute("gh", ["api", `repos/${repository}/git/blobs/${id}`]).toString("utf8"));
      if (response.sha !== id || response.encoding !== "base64" || typeof response.content !== "string"
        || !Number.isSafeInteger(response.size) || response.size < 0 || response.size > LIMIT) {
        throw new Error("Invalid immutable public Git response");
      }
      const encoded = response.content.replace(/\n/g, "");
      native = Buffer.from(encoded, "base64");
      if (native.length !== response.size || native.toString("base64") !== encoded) throw new Error("Invalid public Git encoding");
      verifyPublicGitBlob(native, id);
      if (git(["hash-object", "-w", "--stdin"], { input: native, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim() !== id) {
        throw new Error("Immutable public Git cache write mismatch");
      }
    }
    verifyPublicGitBlob(native, id);
    const lfs = parsePublicLfsPointer(native);
    const bytes = lfs ? execute("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "30",
      "--max-filesize", String(LIMIT), `https://media.githubusercontent.com/media/${repository}/${commit}/${file}`]) : native;
    if (lfs && (bytes.length !== lfs.size || digest("sha256", bytes) !== lfs.oid)) throw new Error("Immutable LFS content identity mismatch");
    totalBytes += bytes.length;
    if (bytes.length > LIMIT || totalBytes > 64 * 1024 * 1024 || blobs.size >= 300) throw new Error("Immutable source closure budget exhausted");
    if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|npm_[A-Za-z0-9]{30,})/.test(bytes.toString("utf8"))) {
      throw new Error("Refusing credential-shaped immutable source content");
    }
    const result = { id, native: native.toString("base64"), lfs, sha256: digest("sha256", bytes), bytes };
    blobs.set(id, result);
    return { ...result, path: file };
  };
  return { metadata, read, sources: () => [...blobs.values()].map(({ bytes, ...row }) => ({
    ...row, content: bytes.toString("base64"),
  })) };
}
