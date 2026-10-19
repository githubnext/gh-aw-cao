import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { base, json, hash, revision, readOriginals } from "./native-monitoring-accuracy.mjs";

const facets = {
  "daily-code-metrics": {
    nativeLabel: "Workflow inventory count accuracy",
    population: "The two source-required direct workflow Markdown/lock count cells in the latest surviving marker-discovered report.",
    acceptance: "Partial native factual facet: both published direct workflow counts equal the actual immutable run-head regular-file inventory; independently compare the basename sets. This does not accept the source's health score or claim improved repository health.",
    limitations: "All other metrics, cloc, trends, recommendations, charts and underlying health outcomes remain unmeasured.",
  },
  "daily-repo-chronicle": {
    nativeLabel: "Cited mainline commit accuracy",
    population: "Distinct literal mainline commit hash citations in the latest surviving marker-discovered edition, compared to the contiguous run-head first-parent prefix in its declared edition window.",
    acceptance: "Partial native factual facet: each literal commit hash resolves uniquely in the preserved contiguous mainline prefix, with prefix citation coverage reported separately. Not a claim that prose, human attribution or the complete activity graph is correct.",
    limitations: "The edition explicitly spans 24h05m instead of the source-required 24h. Report that nonconformance. History beyond the first older parent, later mainline changes, semantic descriptions, human agency, issue statistics and reader understanding remain unmeasured.",
  },
  "repo-tree-map": {
    nativeLabel: "Published extension-count accuracy",
    population: "Every literal row in the selected surviving report's extension count table, against regular tracked files at the immutable run head.",
    acceptance: "Partial fixed-reference assessment: published suffix counts equal independently enumerated Git-tree suffix populations, excluding Git and dependency directories. Native metadata accuracy, not file volume growth, is the outcome facet.",
    limitations: "Untracked files and dirty checkout contents are unknown; agreement is with the bound immutable reference only. Disk-allocation sizes, graphical proportions, complete extension coverage and reader comprehension remain unmeasured.",
  },
  "github-mcp-tools-report": {
    nativeLabel: "Published mapping-fact accuracy",
    population: "Three explicitly repository-mapping facts: unique tool names, total registration entries and toolset categories in the latest surviving report.",
    acceptance: "Partial native factual facet: the three claimed JSON-mapping quantities equal the independent JSON blob at the immutable run head. Duplicate registrations remain distinct from unique tool names.",
    limitations: "A repository mapping is not live tools/list. No acceptance of advertised runtime tools, schemas, behavior, semantic documentation, access or downstream repairs.",
  },
  "weekly-issue-summary": {
    nativeLabel: "Listed new-issue window accuracy",
    population: "Every distinct issue URL in the report's explicitly bounded 'Human issues opened this week' list, plus a separately reported lower-bound total-opening contradiction check.",
    acceptance: "Partial native factual facet: the listed objects are independent surviving Issue identities whose creation timestamps fall in the exact report-declared seven-day interval and whose independent retained transfer timelines contain zero events. Also preserve independently provable missing opening events when that transfer-free surviving creation lower bound exceeds the claimed total.",
    limitations: "No full historical creation ledger is claimed. Missing/deleted/transferred identities are unknown, not invalid. Human identity, authors, titles, labels, states, complete issue-list coverage, charts and interpretations remain unmeasured. A zero undercount floor is not proof of correctness.",
  },
  "daily-issues-report": {
    nativeLabel: "Captured-cohort date-count accuracy",
    population: "The two published seven-day/thirty-day creation counts for the retained 1000-issue cache cohort, with each identity and creation timestamp independently corroborated.",
    acceptance: "Partial native factual facet: recompute the two creation-window counts from the actual retained artifact cohort using independent issue-history creation timestamps. Require invariance across independently recorded prefetch completion through Discussion creation so no exact computation timestamp is invented. Effective SDK driver sends the actual prompt, not a deterministic sample replay.",
    limitations: "Cache custody is not a signed pre-agent fetch receipt, latest-1000 completeness is not established, and the cache is not proof of analyzer execution. State, labels, triage, clusters, semantics, charts and maintainer benefit remain unmeasured.",
  },
};

export function authorMonitoringFunctions() {
  const target = path.join(base, "contracts.json");
  if (existsSync(target)) throw new Error("Explicit native contract version already exists");
  const originals = readOriginals(), discovery = json(path.join(base, "discovery.json"));
  const records = discovery.records.map(record => ({
    slug: record.slug, head: record.head,
    sourceBlob: originals.resolve(record.head, `.github/workflows/${record.slug}.md`).oid,
    frozenSourceBlob: originals.resolve(revision, `.github/workflows/${record.slug}.md`).oid,
    adoption: { commit: record.adoption, adoptedAt: originals.commit(record.adoption).at,
      baselineCommit: record.parent, baselineAt: originals.commit(record.parent).at },
    proposal: record.proposal, authoring: record.authoring, attribution: record.attribution,
    selection: "Latest surviving pre-cutoff Discussion with this exact workflow marker in the already fully acquired inventory. One selected report per workflow; all other reports remain unassessed. No random, representative, blind or complete-lifetime claim.",
    ...facets[record.slug],
  }));
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, version: "native-monitoring-accuracy-v1",
    repository: "github/gh-aw", repositoryId: 1036865607, revision, cutoff: "2026-10-18T15:00:12Z",
    skillVersion: "0.18.5", interpretation: "Author once, deterministically replay; outcome-informed retrospective. Original full census proposals preserved verbatim. Native partial facts do not satisfy every full-goal condition.",
    records }, null, 2)}\n`);
  const files = ["scripts/native-monitoring-accuracy.mjs", "scripts/native-monitoring-value.mjs",
    "scripts/collect-native-monitoring-accuracy.mjs", "scripts/author-native-monitoring-functions.mjs",
    ".github/skills/add-operational-value/scripts/collect-output-history.mjs",
    ".github/skills/add-operational-value/scripts/common.mjs",
    ".github/skills/add-operational-value/scripts/github-lineage.mjs",
    ".github/skills/add-operational-value/scripts/json-archive.mjs",
    "docs/operational-value/proof/native-monitoring-accuracy/discovery.json",
    "docs/operational-value/proof/native-monitoring-accuracy/originals.json",
    ...discovery.records.flatMap(record => [`docs/operational-value/proof/native-monitoring-accuracy/packets/${record.slug}-run.json`,
      `docs/operational-value/proof/native-monitoring-accuracy/packets/${record.slug}-discussion-page.json`]),
    ...discovery.records.flatMap(record => (record.transferPackets ?? []).map(name =>
      `docs/operational-value/proof/native-monitoring-accuracy/packets/${name}.json`)),
    "docs/operational-value/proof/native-monitoring-accuracy/packets/daily-issues-cache.json",
    "docs/operational-value/proof/native-monitoring-accuracy/packets/daily-issues-report-agent-job.json",
    "docs/operational-value/proof/native-monitoring-accuracy/issue-history/history.json.gz",
  ];
  const rawManifest = JSON.parse(readFileSync(path.join(base, "originals.json")));
  if (rawManifest.kind === "partitioned-census-json") {
    files.push(...rawManifest.parts.map(part => `docs/operational-value/proof/native-monitoring-accuracy/${part.file}`));
  }
  const lock = path.join(base, "compiler-lock.json");
  writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1,
    interpretation: "Pins production interpreter/helper/source/discovery identities, including transitive portable skill helpers. Native Git objects and packet chunks are validated against pinned manifests during replay.",
    files: files.map(file => ({ path: file, sha256: hash(readFileSync(file)) })) }, null, 2)}\n`);
  for (const record of records) {
    const file = `docs/operational-value/proof/functions/${record.slug}.mjs`;
    if (existsSync(file)) throw new Error("Refusing to overwrite an existing value function");
    writeFileSync(file, `import { monitoringModule } from "../../../../scripts/native-monitoring-value.mjs";\n\nexport const { definition, collectBatch, scoreMetric } = monitoringModule(${JSON.stringify(record.slug)},\n  "${hash(readFileSync(target))}",\n  "${hash(readFileSync(lock))}");\n`);
  }
  return { functions: records.length, contractSha256: hash(readFileSync(target)), compilerSha256: hash(readFileSync(lock)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(authorMonitoringFunctions()));
