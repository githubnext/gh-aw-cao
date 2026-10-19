import path from "node:path";
import { boundedPublicGitArchive } from "./bounded-public-git-archive.mjs";

export function credoSourceArchive(cache, repository, directory) {
  const parts = [], retained = new Map();
  let current, currentDirectory, bytes = 0;
  const rotate = () => {
    if (current) parts.push(...current.sources().map(row => ({
      ...row, file: path.join(currentDirectory, `${row.gitBlob}.json.gz`),
    })));
    currentDirectory = `${path.basename(directory)}/part-${String(parts.length + 1).padStart(5, "0")}`;
    current = boundedPublicGitArchive(cache, repository, path.join(path.dirname(directory), currentDirectory));
    bytes = 0;
  };
  rotate();
  return { metadata: current.metadata, read(commit, file) {
    const entry = current.metadata(["ls-tree", "-r", commit, "--", file]);
    const id = entry.match(/^100644 blob ([a-f0-9]{40})\t/)?.[1];
    if (id && retained.has(id)) return { ...retained.get(id), path: file };
    // Partition retained inputs without changing either frozen reader's limits.
    if (bytes >= 24 * 1024 * 1024) rotate();
    const row = current.read(commit, file);
    if (row) {
      if (retained.size >= 10000) throw new Error("Credo source population exceeds the frozen acquisition budget");
      retained.set(row.id, row);
      bytes += row.bytes.length;
    }
    return row;
  }, sources() {
    return [...parts, ...current.sources().map(row => ({
      ...row, file: path.join(currentDirectory, `${row.gitBlob}.json.gz`),
    }))];
  } };
}
