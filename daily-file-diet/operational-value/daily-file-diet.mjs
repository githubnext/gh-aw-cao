import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const definition = {
  schemaVersion: 3,
  slug: "daily-file-diet",
  sourcePath: ".github/workflows/daily-file-diet.md",
  repository: "github/gh-aw",
  workflowName: "Daily File Diet",
  adoption: {
    commit: "1186030a620f4113f655c156bedf70cf2c164f79",
    adoptedAt: "2025-11-15T13:36:21Z",
    baselineCommit: "fc43d399fbe304278d3920906b90413db31184b8",
    baselineAt: "2025-11-15T13:27:11Z",
  },
  evaluation: { mode: "baseline-comparable" },
  evidence: {
    key: "weekly-pkg-go-file-size-snapshot",
    repositories: ["github/gh-aw"],
    opportunity: "A weekly immutable snapshot containing at least one non-test Go source file under pkg/.",
    filters: [
      "Include pkg/**/*.go.",
      "Exclude files whose names end in _test.go.",
      "Use the last commit on main at or before windowEnd.",
      "A file is compliant when its physical line count is at most 999.",
    ],
    collection: "Resolve all requested cutoffs from batched main-branch commit history, fetch each selected immutable commit archive once, and derive line counts locally. An empty eligible population is missing; when eligible files exist, zero compliant line mass is a valid zero.",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Direct threshold-severity primary with a separate compliant-mass diagnostic.",
    recommendation: "Use largest-file health as the operational-value measure and retain compliant line mass only as a non-composite diagnostic because the measures can disagree.",
    presentation: {
      label: "Go file-size health",
      betterLabel: "Higher means the largest eligible file is closer to or within the 999-line healthy range.",
    },
  },
  summary: { nativeLabel: "Largest eligible Go file line count" },
  metrics: [
    {
      id: "largest-file-health",
      name: "Largest-file health",
      role: "primary",
      formula: "min(1, 999 / largestFileLines) when at least one eligible file exists",
      direction: "increase",
      unit: "score",
      presentation: { name: "Largest-file health", legendLabel: "Largest-file health", transform: "identity" },
    },
    {
      id: "compliant-line-mass-share",
      name: "Compliant line-mass share",
      role: "diagnostic",
      formula: "compliantLines / totalLines when at least one eligible file and positive line mass exist",
      direction: "increase",
      unit: "share",
      presentation: { name: "Compliant line-mass share", legendLabel: "Compliant line mass", transform: "identity" },
    },
  ],
  validationExamples: {
    targetAttained: { eligibleFileCount: 2, totalLines: 1500, largestFileLines: 800, compliantLines: 1500 },
    targetMissed: { eligibleFileCount: 2, totalLines: 2400, largestFileLines: 1900, compliantLines: 500 },
    missing: { eligibleFileCount: 0, totalLines: 0, largestFileLines: null, compliantLines: 0 },
    malformed: { eligibleFileCount: "two", totalLines: -1, largestFileLines: "large", compliantLines: 4 },
  },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) fail(String(result.stderr || `${command} failed`).trim());
  return result.stdout;
}

function round(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

export function scoreMetric(metricId, evidence) {
  if (metricId === "largest-file-health") {
    if (!Number.isInteger(evidence?.eligibleFileCount) || evidence.eligibleFileCount <= 0
        || typeof evidence.largestFileLines !== "number" || evidence.largestFileLines <= 0) return null;
    return round(Math.max(0, Math.min(1, 999 / evidence.largestFileLines)));
  }
  if (metricId === "compliant-line-mass-share") {
    if (!Number.isInteger(evidence?.eligibleFileCount) || evidence.eligibleFileCount <= 0
        || typeof evidence.totalLines !== "number" || evidence.totalLines <= 0
        || typeof evidence.compliantLines !== "number" || evidence.compliantLines < 0
        || evidence.compliantLines > evidence.totalLines) return null;
    return round(Math.max(0, Math.min(1, evidence.compliantLines / evidence.totalLines)));
  }
  fail(`unknown metric: ${metricId}`);
}

function ghJson(endpoint) {
  return JSON.parse(run("gh", ["api", endpoint]));
}

function ghJsonPages(endpoint) {
  return JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint])).flat();
}

function listGoFiles(directory) {
  const files = [];
  if (!statSafe(directory)?.isDirectory()) return files;
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...listGoFiles(file));
    else if (name.endsWith(".go") && !name.endsWith("_test.go")) files.push(file);
  }
  return files;
}

function statSafe(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

export async function collectBatch(requests) {
  const valid = Array.isArray(requests) && requests.length > 0
    && requests.every((request) => ["windowStart", "windowEnd", "observedAt"]
      .every((key) => typeof request[key] === "string" && !Number.isNaN(Date.parse(request[key])))
      && Date.parse(request.windowEnd) - Date.parse(request.windowStart) === 7 * 86_400_000
      && Date.parse(request.observedAt) >= Date.parse(request.windowEnd));
  if (!valid) fail("invalid batch collection request");

  const ends = requests.map(({ windowEnd }) => windowEnd).toSorted();
  const minimum = ends[0];
  const maximum = ends.at(-1);
  const anchor = ghJson(`repos/github/gh-aw/commits?sha=main&until=${minimum}&per_page=1`);
  const range = minimum === maximum
    ? []
    : ghJsonPages(`repos/github/gh-aw/commits?sha=main&since=${minimum}&until=${maximum}&per_page=100`);
  const commits = [...anchor, ...range]
    .filter((commit, index, all) => all.findIndex(({ sha }) => sha === commit.sha) === index)
    .toSorted((left, right) => left.commit.committer.date.localeCompare(right.commit.committer.date));
  const selections = requests.map((request) => {
    const commit = commits.filter((item) => item.commit.committer.date <= request.windowEnd).at(-1);
    if (!commit) fail("no commit exists at or before requested window end");
    return commit;
  });

  const work = mkdtempSync(path.join(process.cwd(), ".aw-value-daily-file-diet."));
  try {
    const evidenceBySha = new Map();
    for (const commit of selections) {
      if (evidenceBySha.has(commit.sha)) continue;
      const archive = path.join(work, `${commit.sha}.tar.gz`);
      writeFileSync(archive, run("gh", ["api", `repos/github/gh-aw/tarball/${commit.sha}`], { encoding: null }));
      const tree = path.join(work, commit.sha);
      run("mkdir", ["-p", tree]);
      run("tar", ["-xzf", archive, "-C", tree, "--strip-components=1"]);
      const files = listGoFiles(path.join(tree, "pkg")).map((file) => {
        const contents = readFileSync(file);
        const lines = contents.length === 0 ? 0 : contents.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
        return { path: path.relative(tree, file), lines };
      }).toSorted((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
      evidenceBySha.set(commit.sha, {
        eligibleFileCount: files.length,
        totalLines: files.reduce((sum, file) => sum + file.lines, 0),
        largestFilePath: files[0]?.path ?? null,
        largestFileLines: files[0]?.lines ?? null,
        compliantFileCount: files.filter(({ lines }) => lines <= 999).length,
        compliantLines: files.filter(({ lines }) => lines <= 999).reduce((sum, file) => sum + file.lines, 0),
      });
    }
    return requests.map((request, index) => {
      const commit = selections[index];
      return {
        commit: commit.sha,
        evidence: {
          key: "weekly-pkg-go-file-size-snapshot",
          repositories: ["github/gh-aw"],
          opportunity: "Non-test Go source files under pkg/ at the immutable cutoff commit.",
          filters: ["pkg/**/*.go", "exclude *_test.go", "healthy line-count threshold <= 999", "main commit at or before windowEnd"],
          collection: "Physical line counts derived locally from one immutable GitHub commit archive.",
          window: {
            startAt: request.windowStart,
            endAt: request.windowEnd,
            observedAt: request.observedAt,
            durationDays: 7,
            cadenceDays: 7,
            maturationDays: 0,
          },
          ...evidenceBySha.get(commit.sha),
        },
        provenance: [
          { repository: "github/gh-aw", kind: "git-commit", ref: commit.sha },
          { repository: "github/gh-aw", kind: "github-archive", ref: `repos/github/gh-aw/tarball/${commit.sha}` },
        ],
      };
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
