import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { base, contract, gitId, sha256 } from "../docs/operational-value/proof/doc-accuracy/objects.mjs";
import { references } from "../docs/operational-value/proof/doc-accuracy/checker.mjs";

export function preserveNative(cache, plan, output = base) {
  const originals = new Map();
  const publicManifest = JSON.parse(readFileSync(path.join(output, "public", "manifest.json")));
  const publicBlobs = new Map(publicManifest.groups.flatMap(group => group.requests)
    .filter(receipt => receipt.blob).map(receipt => [receipt.sha, receipt]));
  const git = (...args) => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 64 * 1024 * 1024 });
  const object = (oid, type) => {
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("Explicit object ID required");
    if (originals.has(oid)) return originals.get(oid).bytes;
    const receipt = type === "blob" ? publicBlobs.get(oid) : null;
    const bytes = receipt ? receipt.blobParts ? Buffer.concat(receipt.blobParts.map(part => {
      const raw = readFileSync(path.join(output, "public", part.file));
      if (sha256(raw) !== part.sha256 || raw.length !== part.bytes) throw new Error("Public original chunk mismatch");
      return gunzipSync(raw);
    })) : readFileSync(path.join(output, "public", receipt.blob)) : git("cat-file", type, oid);
    if (receipt && (bytes.length !== receipt.blobBytes || sha256(bytes) !== receipt.blobSha256)) {
      throw new Error("Public source original mismatch");
    }
    if (gitId(type, bytes) !== oid) throw new Error("Native original mismatch");
    originals.set(oid, { oid, type, bytes });
    return bytes;
  };
  const commit = oid => {
    const raw = object(oid, "commit").toString();
    const tree = /^tree ([0-9a-f]{40})$/m.exec(raw)?.[1];
    const parents = [...raw.split("\n\n")[0].matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]);
    return { tree, parents };
  };
  const resolve = (revision, file, copyBlob = false) => {
    const components = file.split("/");
    let oid = commit(revision).tree;
    for (let i = 0; i < components.length; i++) {
      const bytes = object(oid, "tree");
      let offset = 0, found;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), end = bytes.indexOf(0, space);
        const entry = { mode: bytes.subarray(offset, space).toString(), name: bytes.subarray(space + 1, end).toString(),
          oid: bytes.subarray(end + 1, end + 21).toString("hex") };
        offset = end + 21;
        if (entry.name === components[i]) found = entry;
      }
      if (!found) return null;
      if (i === components.length - 1) {
        if (copyBlob && ["100644", "100755"].includes(found.mode)) object(found.oid, "blob");
        return found;
      }
      if (found.mode !== "40000") return null;
      oid = found.oid;
    }
    return null;
  };
  const capture = (revision, file) => {
    const entry = resolve(revision, file, true);
    return entry ? object(entry.oid, "blob").toString() : "";
  };
  for (const slug of Object.keys(contract.sources)) {
    const entry = resolve(contract.frozenRevision, `.github/workflows/${slug}.md`, true);
    if (entry?.oid !== contract.sources[slug].blob) throw new Error("Frozen workflow source mismatch");
  }
  for (const file of plan.imports ?? []) resolve(contract.frozenRevision, file, true);
  for (const addition of plan.additions ?? []) {
    if (commit(addition.commit).parents[0] !== addition.parent) throw new Error("Adoption parent mismatch");
    for (const extension of ["md", "lock.yml"]) {
      const file = `.github/workflows/${addition.slug}.${extension}`;
      if (resolve(addition.parent, file) || !resolve(addition.commit, file, extension === "md")) {
        throw new Error(`Not a real source/compiled addition: ${file}`);
      }
    }
  }
  for (const change of plan.changes ?? []) {
    if (commit(change.commit).parents[0] !== change.parent) throw new Error("Change is not native first-parent transition");
    for (const revision of [change.parent, change.commit]) {
      for (const slug of change.workflows) capture(revision, `.github/workflows/${slug}.md`);
      for (const file of change.supportFiles ?? []) capture(revision, file);
      for (const file of change.files) {
        const text = capture(revision, file);
        for (const reference of references(file, text)) resolve(revision, reference.target);
      }
    }
  }
  mkdirSync(path.join(output, "originals"), { recursive: true });
  const manifest = { schemaVersion: 1, repository: contract.repository, revision: contract.frozenRevision, objects: [] };
  for (const original of [...originals.values()].sort((a, b) => a.oid.localeCompare(b.oid))) {
    const parts = [];
    for (let start = 0, index = 0; start < original.bytes.length || index === 0; start += 180000, index++) {
      const bytes = gzipSync(original.bytes.subarray(start, start + 180000), { level: 9 });
      const file = `${original.oid}.${index}.gz`;
      writeFileSync(path.join(output, "originals", file), bytes);
      parts.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
    }
    manifest.objects.push({ oid: original.oid, type: original.type, bytes: original.bytes.length,
      sha256: sha256(original.bytes), parts });
  }
  writeFileSync(path.join(output, "originals.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cache, file] = process.argv.slice(2);
  if (!cache || !file) throw new Error("usage: native-doc-accuracy.mjs CACHE PLAN.json");
  const manifest = preserveNative(cache, JSON.parse(readFileSync(file)));
  console.log(`Preserved ${manifest.objects.length} lossless original Git objects`);
}
