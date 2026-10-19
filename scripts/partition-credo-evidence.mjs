import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { censusDigest } from "./operational-value-census-io.mjs";

const directory = "docs/operational-value/proof/credo-snippets";
const visit = folder => {
  let count = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) count += visit(file);
    else if (entry.isFile() && file.endsWith(".json") && statSync(file).size > 256 * 1024) {
      const value = readJsonArchive(file), before = censusDigest(value);
      writeJsonArchive(file, value);
      if (censusDigest(readJsonArchive(file)) !== before) throw new Error("Credo archive partition changed retained facts");
      count++;
    }
  }
  return count;
};
console.log(JSON.stringify({ partitionedFiles: visit(directory), logicalEvidenceUnchanged: true }));
