import { buildSync } from "esbuild";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { packCaoRuntime, sealCaoRuntime, validateCaoRuntimeArtifact } from "../.github/workflows/shared/materialize-cao.mjs";

export function buildCaoRuntime(sourceRoot, destination, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("A full lowercase source revision SHA is required");
  const temporary = mkdtempSync(path.join(tmpdir(), "cao-runtime-build-"));
  try {
    const packed = packCaoRuntime(sourceRoot, temporary, {
      tracked: true,
      prepare(root) {
        const vendor = path.join(root, "dashboard/site/src/vendor");
        mkdirSync(vendor, { recursive: true });
        buildSync({
          absWorkingDir: sourceRoot,
          stdin: { contents: 'export { parseAllDocuments } from "yaml";', resolveDir: sourceRoot },
          outfile: path.join(vendor, "yaml.js"),
          bundle: true, format: "esm", platform: "neutral", target: "es2022", legalComments: "eof",
        });
        const require = createRequire(path.join(sourceRoot, "package.json"));
        cpSync(path.join(path.dirname(require.resolve("yaml/package.json")), "LICENSE"), path.join(vendor, "yaml.LICENSE"));
        const validator = path.join(root, "dashboard/site/src/validator-dashboard.js");
        const source = readFileSync(validator, "utf8");
        const compiled = source.replace("from 'yaml';", "from './vendor/yaml.js';");
        if (compiled === source) throw new Error("Dashboard YAML dependency changed; runtime bundling must be updated");
        writeFileSync(validator, compiled);
        sealCaoRuntime(root, revision);
      },
    });
    validateCaoRuntimeArtifact(packed.sourceRoot, revision);
    mkdirSync(destination, { recursive: true });
    const name = `cao-runtime-${revision}.tgz`;
    const archive = path.join(destination, name);
    cpSync(packed.archive, archive);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(`${archive}.sha256`, `${digest}  ${name}\n`);
    return { archive, digest, files: packed.files };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [destination, revision] = process.argv.slice(2);
  if (!destination || !revision) throw new Error("Usage: build-cao-runtime.mjs DESTINATION REVISION");
  const result = buildCaoRuntime(path.resolve(import.meta.dirname, ".."), path.resolve(destination), revision);
  console.log(`Built ${path.basename(result.archive)} (${result.files.length} files, sha256:${result.digest})`);
}
