import { mkdirSync } from "node:fs";
import { publicGitSourceReader } from "./immutable-public-git-source.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";

export function boundedPublicGitArchive(cache, repository, directory) {
  let reader = publicGitSourceReader(cache, repository), reads = 0, bytes = 0, retainedBytes = 0;
  const metadata = reader.metadata, sources = new Map();
  mkdirSync(directory, { recursive: true });
  const flush = () => {
    for (const source of reader.sources()) {
      const sha256 = censusDigest(source), prior = sources.get(source.id);
      if (prior && prior.sha256 !== sha256) throw new Error("Conflicting immutable archive source");
      if (prior) continue;
      retainedBytes += Buffer.byteLength(JSON.stringify(source));
      if (sources.size >= 10000 || retainedBytes > 128 * 1024 * 1024) throw new Error("Bounded immutable archive budget exhausted");
      writeCensusJson(`${directory}/${source.id}.json.gz`, source);
      sources.set(source.id, { gitBlob: source.id, sha256 });
    }
  };
  return { metadata, read(commit, file) {
    if (reads >= 200 || bytes >= 60 * 1024 * 1024) {
      flush();
      reader = publicGitSourceReader(cache, repository);
      reads = 0;
      bytes = 0;
    }
    reads++;
    const result = reader.read(commit, file);
    bytes += result?.bytes.length ?? 0;
    return result;
  }, sources() { flush(); return [...sources.values()]; } };
}
