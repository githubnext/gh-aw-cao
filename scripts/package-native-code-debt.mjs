import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../docs/operational-value/proof/native-code-debt/native.mjs";

export function packageOwned(destination) {
  if (!destination || !path.isAbsolute(destination)) throw new Error("Supply an absolute external artifact directory");
  mkdirSync(destination, { recursive: true });
  const owned = ["docs/operational-value/proof/functions/daily-code-debt-aider.mjs",
    "docs/operational-value/proof/functions/code-simplifier.mjs", "tests/unit/native-code-debt.test.mjs",
    ...readdirSync("scripts").filter(file => /native-code-debt.*\.mjs$/.test(file)).map(file => `scripts/${file}`)];
  function walk(directory) {
    for (const entry of readdirSync(directory)) {
      const file = `${directory}/${entry}`, stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) owned.push(file);
      else throw new Error(`Nonregular owned path: ${file}`);
    }
  }
  walk("docs/operational-value/proof/native-code-debt");
  owned.sort();
  if (new Set(owned).size !== owned.length) throw new Error("Repeated owned path");
  const files = owned.map(file => {
    const bytes = readFileSync(file);
    if (!lstatSync(file).isFile() || bytes.length > 256 * 1024) throw new Error(`Invalid/oversized owned file: ${file}`);
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const list = path.join(destination, "native-code-debt.members.txt");
  writeFileSync(list, `${owned.join("\n")}\n`);
  const archive = path.join(destination, "native-code-debt.tar.gz");
  execFileSync("tar", ["-czf", archive, "-T", list], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = readFileSync(archive), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const chunk = bytes.subarray(offset, offset + 256 * 1024), file = `native-code-debt-${String(chunks.length + 1).padStart(3, "0")}.tar.gz.part`;
    writeFileSync(path.join(destination, file), chunk);
    chunks.push({ file, bytes: chunk.length, sha256: sha256(chunk) });
  }
  const baseline = JSON.parse(readFileSync("docs/operational-value/proof/native-code-debt/replay-baseline.json"));
  const manifest = { schemaVersion: 1, kind: "owned-only-native-code-debt-handoff", files, totalRegularFiles: files.length,
    archive: { file: path.basename(archive), bytes: bytes.length, sha256: sha256(bytes), encoding: "concatenate-ordered-chunks-then-gzip-tar" },
    chunks, unchangedBaselineDependenciesNotOwned: baseline.files };
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), manifestFile = path.join(destination, "native-code-debt.manifest.json");
  if (encoded.length > 256 * 1024) throw new Error("Oversized external manifest");
  writeFileSync(manifestFile, encoded);
  const verified = execFileSync("python3", ["-c", `
import hashlib,io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]); m=json.loads((root/'native-code-debt.manifest.json').read_bytes())
parts=[]
for p in m['chunks']:
    assert pathlib.PurePosixPath(p['file']).name==p['file']
    b=(root/p['file']).read_bytes()
    assert len(b)==p['bytes']<=262144 and hashlib.sha256(b).hexdigest()==p['sha256']
    parts.append(b)
b=b''.join(parts)
assert len(b)==m['archive']['bytes'] and hashlib.sha256(b).hexdigest()==m['archive']['sha256']
assert b==(root/m['archive']['file']).read_bytes()
expected={r['path']:r for r in m['files']}
assert len(expected)==len(m['files'])
with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
    members=t.getmembers()
    assert len(members)==len(expected) and {r.name for r in members}==set(expected)
    for r in members:
        p=pathlib.PurePosixPath(r.name)
        assert r.isfile() and not p.is_absolute() and '..' not in p.parts
        assert not any(x.startswith('._') or x=='__MACOSX' for x in p.parts)
        data=t.extractfile(r).read()
        assert len(data)==expected[r.name]['bytes']<=262144 and hashlib.sha256(data).hexdigest()==expected[r.name]['sha256']
print(json.dumps({'regularMembers':len(expected),'exactMemberSet':True,'allBytesAndDigestsVerified':True,'appleDouble':False,'unsafePaths':False,'chunkReassemblyVerified':True}))
`, destination], { encoding: "utf8" }).trim();
  return { destination, manifestFile, manifestSha256: sha256(encoded), archiveSha256: sha256(bytes), chunks: chunks.length, ...JSON.parse(verified) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageOwned(process.argv[2]), null, 2));
