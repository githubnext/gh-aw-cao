import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const maximumSize = 256 * 1024;
const allowedLargeFiles = new Set(["package-lock.json", "dashboard/site/package-lock.json"]);
const root = path.resolve(import.meta.dirname, "..");
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const oversizedFiles = trackedFiles.filter((file) => !allowedLargeFiles.has(file)).flatMap((file) => {
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
