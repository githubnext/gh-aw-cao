import { existsSync, readFileSync } from "node:fs";
import { credoSourceArchive } from "./credo-source-archive.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { credoHash, credoMarkdownPath, executeCredoSnippet, extractCredoSnippets } from "./native-credo-snippet-value.mjs";

const [cache, project] = process.argv.slice(2);
if (!cache || !project) throw new Error("usage: collect-credo-snippet-transitions.mjs PRIVATE_GIT_CACHE PRIVATE_CREDO_PROJECT");
const directory = "docs/operational-value/proof/credo-snippets";
if (existsSync(`${directory}/history-index.json`)) throw new Error("Refusing to overwrite complete Credo source history");
const contract = readCensusJson(`${directory}/contract.json`);
if (contract.interpreterSha256 !== credoHash(readFileSync("scripts/native-credo-snippet-value.mjs"))
  || contract.probeSha256 !== credoHash(readFileSync("scripts/credo-snippet-probe.exs"))) {
  throw new Error("Frozen Credo predicates changed before exhaustive acquisition");
}
const archive = credoSourceArchive(cache, contract.repository, `${directory}/history-sources`);
const metadata = archive.metadata;
const sourceFacts = new Map(), nativeFacts = new Map();
const inventory = new Map();
const initial = metadata(["ls-tree", "-r", contract.adoption.commit, "--", "docs", ".github/workflows"])
  .split("\n").flatMap(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/);
    return match && credoMarkdownPath(match[3]) ? [{ path: match[3], gitBlob: match[2], mode: match[1] }] : [];
  });
if (!initial.length) throw new Error("Initial Markdown inventory missing");

function acquire(commit, entry) {
  if (entry.mode !== "100644") throw new Error("Unsupported historical Markdown mode");
  const prior = sourceFacts.get(entry.gitBlob);
  if (prior) return prior;
  const row = archive.read(commit, entry.path);
  if (!row || row.id !== entry.gitBlob) throw new Error("Exhaustive Markdown history blob mismatch");
  const snippets = extractCredoSnippets(row.bytes.toString("utf8")).map(snippet => {
    const key = `${snippet.language}:${snippet.contentSha256}`;
    if (!nativeFacts.has(key)) nativeFacts.set(key, executeCredoSnippet(snippet, project));
    return { line: snippet.line, language: snippet.language, ...nativeFacts.get(key) };
  });
  const fact = { gitBlob: row.id, sha256: row.sha256, snippets };
  sourceFacts.set(row.id, fact);
  return fact;
}

for (const entry of initial) {
  acquire(contract.adoption.commit, entry);
  inventory.set(entry.path, entry);
}
const patterns = ["docs", ".github/workflows"].flatMap(root =>
  ["md", "mdx", "markdown"].map(extension => `:(glob,icase)${root}/**/*.${extension}`));
const raw = metadata(["log", "--first-parent", "--reverse", "--diff-merges=first-parent", "--raw", "--no-abbrev",
  "--no-renames", "--format=commit %H %cI", contract.sourceRevision, `^${contract.adoption.commit}`, "--", ...patterns]);
const transitions = [];
let current;
for (const line of raw.split("\n")) {
  if (!line) continue;
  const header = line.match(/^commit ([a-f0-9]{40}) (.+)$/);
  if (header) {
    current = { commit: header[1], at: new Date(header[2]).toISOString().replace(".000Z", "Z"), changes: [] };
    transitions.push(current);
    continue;
  }
  const change = line.match(/^:(\d+) (\d+) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])\t(.+)$/);
  if (!change || !current || !credoMarkdownPath(change[6])) throw new Error("Unrecognized historical Markdown transition");
  current.changes.push({ path: change[6], beforeMode: change[1], afterMode: change[2],
    beforeBlob: change[3], afterBlob: change[4], status: change[5] });
}
const stateSummary = () => {
  let eligible = 0;
  for (const entry of inventory.values()) eligible += sourceFacts.get(entry.gitBlob).snippets.length;
  return { markdownFiles: inventory.size, eligible };
};
const states = [{ commit: contract.adoption.commit, at: contract.adoption.adoptedAt, ...stateSummary() }];
for (const transition of transitions) {
  for (const change of transition.changes) {
    const before = inventory.get(change.path);
    if (change.beforeMode !== "000000" && (before?.gitBlob !== change.beforeBlob || before?.mode !== change.beforeMode)) {
      throw new Error("Historical Markdown transition chain is discontinuous");
    }
    if (change.beforeMode === "000000" && before) throw new Error("Duplicate historical Markdown addition");
    if (change.afterMode === "000000") inventory.delete(change.path);
    else {
      const entry = { path: change.path, gitBlob: change.afterBlob, mode: change.afterMode };
      acquire(transition.commit, entry);
      inventory.set(change.path, entry);
    }
  }
  states.push({ commit: transition.commit, at: transition.at, ...stateSummary() });
}
const final = metadata(["ls-tree", "-r", contract.sourceRevision, "--", "docs", ".github/workflows"])
  .split("\n").flatMap(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/);
    return match && credoMarkdownPath(match[3]) ? [{ path: match[3], gitBlob: match[2], mode: match[1] }] : [];
  });
const sorted = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
if (censusDigest(sorted(inventory.values())) !== censusDigest(sorted(final))) {
  throw new Error("Exhaustive Markdown history does not reconcile to the frozen terminal tree");
}
const facts = { schemaVersion: 1, initial, transitions, states, sources: [...sourceFacts.values()],
  terminalInventorySha256: censusDigest(sorted(final)) };
writeCensusJson(`${directory}/history.json.gz`, facts);
const sources = archive.sources();
writeCensusJson(`${directory}/history-index.json`, { schemaVersion: 1, repository: contract.repository,
  sourceRevision: contract.sourceRevision, until: contract.until, contractSha256: censusDigest(contract),
  collectorSha256: credoHash(readFileSync(import.meta.filename)), complete: true, historySha256: censusDigest(facts),
  sources, markdownChangingCommits: transitions.length, uniqueMarkdownBlobs: sourceFacts.size,
  checkedStates: states.length, eligibleStates: states.filter(state => state.eligible > 0).length,
  nativeSnippets: nativeFacts.size, terminalReconciled: true,
  status: states.some(state => state.eligible > 0) ? "eligible-historical-opportunities" : "no-eligible-opportunities",
  limitation: "Exhaustive first-parent repository source states, not unmerged PR branches, deleted remote objects or author intent; native fixtures never count as repository outcomes." });
console.log(JSON.stringify({ states: states.length, changes: transitions.reduce((sum, row) => sum + row.changes.length, 0),
  uniqueMarkdownBlobs: sourceFacts.size, nativeSnippets: nativeFacts.size, eligibleStates: states.filter(state => state.eligible).length }));
