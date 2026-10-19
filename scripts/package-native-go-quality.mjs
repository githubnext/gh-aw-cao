import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

export function packageOwned(destination) {
  if (!path.isAbsolute(destination)) throw new Error("Use an absolute external artifact directory");
  mkdirSync(destination, { recursive: true });
  const owned = [
    "docs/operational-value/proof/functions/go-logger.mjs",
    "docs/operational-value/proof/functions/go-pattern-detector.mjs",
    "docs/operational-value/proof/functions/daily-testify-uber-super-expert.mjs",
    "tests/unit/native-go-quality.test.mjs",
    ...readdirSync("scripts").filter(name => /native-go-quality.*\.mjs$/.test(name)).map(name => `scripts/${name}`),
  ];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = `${directory}/${name}`, stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) owned.push(file);
      else throw new Error(`Non-regular owned member: ${file}`);
    }
  }
  walk("docs/operational-value/proof/native-go-quality");
  owned.sort();
  if (new Set(owned).size !== owned.length) throw new Error("Repeated owned path");
  const files = owned.map(file => {
    if (!lstatSync(file).isFile()) throw new Error("Non-regular member");
    const bytes = readFileSync(file);
    if (bytes.length > 256 * 1024) throw new Error(`Oversized owned member: ${file}`);
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const list = path.join(destination, "native-go-quality.members.txt");
  writeFileSync(list, `${owned.join("\n")}\n`);
  const archive = path.join(destination, "native-go-quality.temporary.tar.gz");
  execFileSync("tar", ["-czf", archive, "-T", list], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = readFileSync(archive), chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
    const chunk = bytes.subarray(offset, offset + 256 * 1024);
    const name = `native-go-quality-${String(chunks.length + 1).padStart(3, "0")}.tar.gz.part`;
    writeFileSync(path.join(destination, name), chunk);
    chunks.push({ file: name, bytes: chunk.length, sha256: sha256(chunk) });
  }
  rmSync(archive);
  const manifest = { schemaVersion: 1, kind: "owned-only-native-go-quality-handoff",
    archive: { bytes: bytes.length, sha256: sha256(bytes), encoding: "concatenate-ordered-chunks-then-gzip-tar" },
    chunks, files, totalRegularFiles: files.length, appleDoubleAllowed: false };
  const manifestFile = path.join(destination, "native-go-quality.manifest.json");
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (encoded.length > 256 * 1024) throw new Error("Oversized external manifest");
  writeFileSync(manifestFile, encoded);
  const verification = execFileSync("python3", ["-c", `
import hashlib,io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1])
m=json.loads((root/'native-go-quality.manifest.json').read_bytes())
parts=[]
for p in m['chunks']:
    assert pathlib.PurePosixPath(p['file']).name==p['file']
    b=(root/p['file']).read_bytes()
    assert len(b)==p['bytes']<=262144 and hashlib.sha256(b).hexdigest()==p['sha256']
    parts.append(b)
b=b''.join(parts)
assert len(b)==m['archive']['bytes'] and hashlib.sha256(b).hexdigest()==m['archive']['sha256']
expected={r['path']:r for r in m['files']}
assert len(expected)==len(m['files'])
with tarfile.open(fileobj=io.BytesIO(b),mode='r:gz') as t:
    members=t.getmembers()
    assert len(members)==len(expected) and {r.name for r in members}==set(expected)
    for r in members:
        assert r.isfile() and not any(p.startswith('._') or p=='__MACOSX' for p in pathlib.PurePosixPath(r.name).parts)
        data=t.extractfile(r).read()
        assert len(data)==expected[r.name]['bytes']<=262144 and hashlib.sha256(data).hexdigest()==expected[r.name]['sha256']
print(json.dumps({'verifiedBy':'independent Python tarfile','regularMembers':len(expected),'archiveSha256':m['archive']['sha256'],'exactMemberSet':True,'appleDouble':False}))
`, destination], { encoding: "utf8" }).trim();
  return { destination, manifestFile, manifestSha256: sha256(encoded), ...JSON.parse(verification) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packageOwned(process.argv[2]), null, 2));
