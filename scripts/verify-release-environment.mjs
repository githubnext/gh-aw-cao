import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readPromotionEnvironment, repositoryApi } from "./release-promotion-evidence.mjs";

export async function verifyReleaseEnvironment(repository) {
  const get = repositoryApi(async (route, parameters) => {
    const args = ["api", "--method", "GET", route.slice(4)];
    for (const [key, value] of Object.entries(parameters)) args.push("-f", `${key}=${value}`);
    return { data: JSON.parse(execFileSync("gh", args, {
      encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "inherit"],
    })) };
  }, repository);
  const metadata = await get("");
  return readPromotionEnvironment(get, metadata.default_branch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-release-environment.mjs OWNER/REPO");
    const environment = await verifyReleaseEnvironment(process.argv[2]);
    console.log(JSON.stringify({ environment: environment.name, id: environment.id, verifiedAt: new Date().toISOString() }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
