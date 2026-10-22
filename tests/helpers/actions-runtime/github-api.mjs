import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export async function githubAPI(workspace, event, report, revision) {
  const repository = event.repository;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname;
    report.requests.push({ method: request.method, path: route, ref: url.searchParams.get("ref") });
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-RateLimit-Limit", "5000");
    response.setHeader("X-RateLimit-Remaining", "4999");
    response.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 3600));
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    if (request.method !== "GET") {
      report.unhandled.push(`${request.method} ${route}`);
      send(403, { message: "Simulator forbids GitHub mutations in dry-run mode" });
      return;
    }
    const prefix = `/repos/${repository.full_name}`;
    if (route === "/rate_limit") {
      const quota = { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 };
      send(200, { resources: { core: quota, search: quota, graphql: quota }, rate: quota });
    } else if (route === prefix) send(200, repository);
    else if (route.startsWith(prefix + "/collaborators/") && route.endsWith("/permission")) {
      send(200, { permission: "admin", user: event.sender });
    } else if (route === prefix + "/actions/runs/1") {
      send(200, { id: 1, head_sha: revision.sha, path: revision.workflow, referenced_workflows: [] });
    } else if (route === prefix + "/actions/runs/1/attempts/1/jobs") {
      send(200, { total_count: 0, jobs: [] });
    } else if (route.startsWith(prefix + "/contents/")) {
      const name = decodeURIComponent(route.slice((prefix + "/contents/").length));
      const ref = url.searchParams.get("ref");
      if (ref !== revision.sha && (name === ".github/workflows/cao.json" || !["refs/heads/main", "main"].includes(ref))) {
        report.unhandled.push(`unavailable fixture revision for ${name}`);
        send(404, { message: "Fixture revision not found" });
        return;
      }
      const file = resolve(workspace, name);
      if (!file.startsWith(resolve(workspace) + sep)) { send(400, { message: "Invalid fixture path" }); return; }
      try {
        const data = await readFile(file);
        if (request.headers.accept?.includes("raw")) { response.end(data); return; }
        send(200, { type: "file", path: name, encoding: "base64", content: data.toString("base64"), sha: revision.sha });
      } catch (error) {
        if (error.code !== "ENOENT") { report.unhandled.push(`read ${name}`); }
        send(404, { message: "Fixture file not found" });
      }
    } else {
      report.unhandled.push(`${request.method} ${route}`);
      send(501, { message: "Unsupported simulator GitHub endpoint" });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
