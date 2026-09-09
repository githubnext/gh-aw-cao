import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const maximumSize = 256 * 1024;
const imageExtensions = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const root = path.resolve(import.meta.dirname, "..");
let trackedFiles;

try {
  trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
} catch {
  console.error("Unable to list tracked files. Ensure Git is installed and this command runs inside the repository.");
  process.exit(1);
}

const oversizedFiles = trackedFiles
  .filter((file) => {
    const isLockfile = path.basename(file) === "package-lock.json";
    const isAssetImage = file.split(/[\\/]/).includes("assets") && imageExtensions.has(path.extname(file).toLowerCase());
    return !isLockfile && !isAssetImage;
  })
  .flatMap((file) => {
    const filePath = path.join(root, file);
    const size = statSync(filePath).size;
    return size > maximumSize ? [{ file, size }] : [];
  });

if (oversizedFiles.length > 0) {
  console.error(`Tracked files must not exceed 256 KiB (${maximumSize} bytes):`);
  for (const { file, size } of oversizedFiles) {
    console.error(`- ${file} (${size} bytes)`);
  }
  process.exitCode = 1;
}
